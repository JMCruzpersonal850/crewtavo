import { describe, expect, it } from "vitest";
import {
  emptyGeofence,
  geofence,
  geofenceActions,
  geofenceRadius,
  IN_A_ROW_MS,
  keepSites,
  LEAVE_AFTER_MS,
  nextLook,
  noteTap,
  trackFix,
  type ActionContext,
  type Fix,
  type GeofenceEvent,
  type GeofenceSite,
  type GeofenceState,
} from "../src/geofence";

// 12 Oak St, and a fix `north` metres north of it (a degree of latitude is about 111.2 km).
const OAK: GeofenceSite = { visitId: "oak", lat: 40, lng: -75, place: "12 Oak St", status: "scheduled" };
const ELM: GeofenceSite = { visitId: "elm", lat: 40.05, lng: -75, place: "8 Elm Ave", status: "scheduled" };
const M_PER_DEG = 111_195;
const T0 = Date.parse("2026-11-13T14:00:00Z");
const min = 60_000;
const fix = (north: number, minutes: number, accuracy = 15): Fix => ({ lat: 40 + north / M_PER_DEG, lng: -75, accuracy, at: T0 + minutes * min });

/** Feeds fixes in order and collects every event. */
function run(fixes: Fix[], sites: GeofenceSite[] = [OAK], radius = 200, from: GeofenceState = emptyGeofence()) {
  let state = from;
  const events: GeofenceEvent[] = [];
  for (const f of fixes) {
    const out = trackFix(state, f, sites, radius);
    state = out.state;
    events.push(...out.events);
  }
  return { state, events };
}

describe("the setting (settings.clock.geofence)", () => {
  it("is off for a company with nothing saved, and for anything it doesn't know", () => {
    expect(geofence({})).toEqual({ mode: "off", radius: 200 });
    expect(geofence(null)).toEqual({ mode: "off", radius: 200 });
    expect(geofence({ clock: { mode: "day" } })).toEqual({ mode: "off", radius: 200 });
    expect(geofence({ clock: { geofence: { mode: "auto" } } }).mode).toBe("off");
    expect(geofence({ clock: { geofence: "clock" } }).mode).toBe("off");
  });

  it("reads both choices and the radius", () => {
    expect(geofence({ clock: { geofence: { mode: "remind", radius: 150 } } })).toEqual({ mode: "remind", radius: 150 });
    expect(geofence({ clock: { geofence: { mode: "clock", radius: 300 } } })).toEqual({ mode: "clock", radius: 300 });
  });

  it("keeps the radius to 100 to 500 metres, 200 when it isn't a number", () => {
    expect(geofenceRadius(50)).toBe(100);
    expect(geofenceRadius(5000)).toBe(500);
    expect(geofenceRadius("250")).toBe(250);
    expect(geofenceRadius(212.6)).toBe(213);
    expect(geofenceRadius("")).toBe(200);
    expect(geofenceRadius("wide")).toBe(200);
    expect(geofenceRadius(undefined)).toBe(200);
    expect(geofenceRadius(Number.NaN)).toBe(200);
  });
});

describe("arriving", () => {
  it("takes two good fixes in a row inside the radius, and is dated at the first", () => {
    const { events } = run([fix(2000, 0), fix(150, 1), fix(40, 2)]);
    expect(events).toEqual([{ kind: "arrived", visitId: "oak", at: T0 + 1 * min, tapped: false }]);
  });

  it("isn't one fix: the phone may be passing by", () => {
    expect(run([fix(2000, 0), fix(100, 1), fix(2000, 2)]).events).toEqual([]);
  });

  it("doesn't count a fix less sure than the radius, and starts the count again after it", () => {
    expect(run([fix(50, 0), fix(50, 1, 400), fix(50, 2)]).events).toEqual([]);
    expect(run([fix(50, 0), fix(50, 1, 400), fix(50, 2), fix(50, 3)]).events).toEqual([{ kind: "arrived", visitId: "oak", at: T0 + 2 * min, tapped: false }]);
  });

  it("counts a fix as sure as the radius, and not one just outside it", () => {
    expect(run([fix(0, 0, 200), fix(0, 1, 200)]).events).toHaveLength(1);
    expect(run([fix(205, 0), fix(205, 1)]).events).toEqual([]);
  });

  it("follows the radius the office chose", () => {
    expect(run([fix(300, 0), fix(300, 1)], [OAK], 200).events).toEqual([]);
    expect(run([fix(300, 0), fix(300, 1)], [OAK], 400).events).toHaveLength(1);
  });

  it("counts when the app opens already there (the phone didn't know where it was before)", () => {
    expect(run([fix(10, 0), fix(12, 0.5)]).events).toEqual([{ kind: "arrived", visitId: "oak", at: T0, tapped: false }]);
  });

  it("happens once however long they stay", () => {
    const { events } = run([fix(10, 0), fix(10, 1), fix(10, 2), fix(30, 30), fix(5, 90), fix(400, 95), fix(20, 96)]);
    expect(events.filter((e) => e.kind === "arrived")).toHaveLength(1);
    expect(events).toHaveLength(1);
  });

  it("starts a new run when the fixes are far apart in time: they may have left and come back between", () => {
    const { events } = run([fix(2000, 0), fix(10, 1), fix(10, 1 + IN_A_ROW_MS / min + 5), fix(10, 1 + IN_A_ROW_MS / min + 6)]);
    expect(events).toEqual([{ kind: "arrived", visitId: "oak", at: T0 + (1 + IN_A_ROW_MS / min + 5) * min, tapped: false }]);
  });

  it("skips a fix older than the last, or the same one again, or one that makes no sense", () => {
    const first = run([fix(10, 5)]);
    expect(trackFix(first.state, fix(10, 4), [OAK], 200)).toEqual({ state: first.state, events: [] });
    expect(trackFix(first.state, fix(10, 5), [OAK], 200)).toEqual({ state: first.state, events: [] });
    expect(trackFix(first.state, { ...fix(10, 6), lat: Number.NaN }, [OAK], 200).events).toEqual([]);
    expect(trackFix(first.state, { ...fix(10, 6), accuracy: -1 }, [OAK], 200).state).toBe(first.state);
  });

  it("leaves out a property with no point on the map", () => {
    expect(run([fix(10, 0), fix(10, 1)], [{ ...OAK, lat: Number.NaN }]).events).toEqual([]);
  });
});

describe("leaving", () => {
  const there = () => run([fix(10, 0), fix(10, 1)]).state;

  it("takes fixes past the radius and its margin for a few minutes, and is dated at the first one outside", () => {
    const { events } = run([fix(600, 10), fix(900, 11), fix(1500, 10 + LEAVE_AFTER_MS / min)], [OAK], 200, there());
    expect(events).toEqual([{ kind: "left", visitId: "oak", at: T0 + 10 * min, tapped: false }]);
  });

  it("isn't a few fixes in the margin: a big lot, or a rough fix", () => {
    // 200 m radius, 100 m margin: 250 m out is neither in nor gone.
    expect(run([fix(250, 10), fix(260, 20), fix(280, 40)], [OAK], 200, there()).events).toEqual([]);
  });

  it("isn't a fix far out with an error as big as the distance", () => {
    expect(run([fix(600, 10, 500), fix(600, 30, 500)], [OAK], 200, there()).events).toEqual([]);
  });

  it("is cancelled by a fix back inside (they walked to the truck and back)", () => {
    expect(run([fix(600, 10), fix(20, 11), fix(600, 12), fix(600, 14)], [OAK], 200, there()).events).toEqual([]);
  });

  it("isn't cancelled by a fix in the margin", () => {
    expect(run([fix(600, 10), fix(250, 11), fix(600, 14)], [OAK], 200, there()).events).toEqual([{ kind: "left", visitId: "oak", at: T0 + 10 * min, tapped: false }]);
  });

  it("only follows an arrival: never having been there isn't leaving", () => {
    expect(run([fix(2000, 0), fix(3000, 10), fix(4000, 20)]).events).toEqual([]);
  });

  it("happens once, and then coming back is a new arrival", () => {
    const { events } = run([fix(600, 10), fix(600, 14), fix(800, 20), fix(10, 30), fix(10, 31)], [OAK], 200, there());
    expect(events.map((e) => [e.kind, (e.at - T0) / min])).toEqual([["left", 10], ["arrived", 30]]);
  });
});

describe("taps win", () => {
  it("marks the visit when they tap while there, and says so as they leave; then it's forgotten", () => {
    let state = noteTap(run([fix(10, 0), fix(10, 1)]).state, ["oak"]);
    const out = run([fix(600, 10), fix(600, 14)], [OAK], 200, state);
    expect(out.events).toEqual([{ kind: "left", visitId: "oak", at: T0 + 10 * min, tapped: true }]);
    state = out.state;
    expect(state.sites.oak!.tapped).toBe(false);
    expect(run([fix(10, 30), fix(10, 31)], [OAK], 200, state).events[0]!.tapped).toBe(false);
  });

  it("counts a tap made before the phone knew where it was, for the arrival it finds", () => {
    const state = noteTap(emptyGeofence(), ["oak"]);
    expect(run([fix(10, 0), fix(10, 1)], [OAK], 200, state).events).toEqual([{ kind: "arrived", visitId: "oak", at: T0, tapped: true }]);
  });

  it("doesn't count a tap made on the way there: arriving is coming back", () => {
    const away = run([fix(3000, 0)]).state;
    const state = noteTap(away, ["oak"]);
    expect(state).toEqual(away);
    expect(run([fix(10, 10), fix(10, 11)], [OAK], 200, state).events[0]!.tapped).toBe(false);
  });
});

describe("two properties", () => {
  it("tracks each on its own: gone from one and at the next", () => {
    const elmNorth = (ELM.lat - 40) * M_PER_DEG;
    const { events } = run([fix(10, 0), fix(10, 1), fix(elmNorth, 20), fix(elmNorth + 5, 21), fix(elmNorth, 24)], [OAK, ELM]);
    expect(events.map((e) => [e.kind, e.visitId, (e.at - T0) / min])).toEqual([["arrived", "oak", 0], ["arrived", "elm", 20], ["left", "oak", 20]]);
  });

  it("forgets a visit that isn't today's any more", () => {
    const { state } = run([fix(10, 0), fix(10, 1)], [OAK, ELM]);
    expect(Object.keys(keepSites(state, ["elm"]).sites)).toEqual(["elm"]);
  });
});

describe("what to do", () => {
  const arrived = (visitId = "oak", tapped = false): GeofenceEvent => ({ kind: "arrived", visitId, at: T0, tapped });
  const left = (visitId = "oak", tapped = false): GeofenceEvent => ({ kind: "left", visitId, at: T0 + 60 * min, tapped });
  const ctx = (over: Partial<ActionContext> = {}): ActionContext => ({ mode: "clock", sites: [OAK], clock: null, day: false, ...over });

  it("does nothing when the company has it off", () => {
    expect(geofenceActions([arrived(), left()], ctx({ mode: "off" }))).toEqual([]);
  });

  describe("remind", () => {
    it("asks to start a visit that hasn't started, and never touches the clock", () => {
      expect(geofenceActions([arrived()], ctx({ mode: "remind" }))).toEqual([{ kind: "ask-start", visitId: "oak", clockOnly: false }]);
      expect(geofenceActions([arrived()], ctx({ mode: "remind", sites: [{ ...OAK, status: "en_route" }] }))).toEqual([{ kind: "ask-start", visitId: "oak", clockOnly: false }]);
    });

    it("asks to start their clock on a visit a crewmate started", () => {
      expect(geofenceActions([arrived()], ctx({ mode: "remind", sites: [{ ...OAK, status: "in_progress" }] }))).toEqual([{ kind: "ask-start", visitId: "oak", clockOnly: true }]);
    });

    it("asks nothing when the visit is under way and their clock is on it", () => {
      expect(geofenceActions([arrived()], ctx({ mode: "remind", sites: [{ ...OAK, status: "in_progress" }], clock: { category: "visit", visitId: "oak" } }))).toEqual([]);
    });

    it("asks to complete the visit, or stop their clock, as they leave", () => {
      const sites = [{ ...OAK, status: "in_progress" }];
      expect(geofenceActions([left()], ctx({ mode: "remind", sites, clock: { category: "visit", visitId: "oak" } }))).toEqual([{ kind: "ask-finish", visitId: "oak", complete: true, stopClock: true }]);
      expect(geofenceActions([left()], ctx({ mode: "remind", sites }))).toEqual([{ kind: "ask-finish", visitId: "oak", complete: true, stopClock: false }]);
      expect(geofenceActions([left()], ctx({ mode: "remind", clock: { category: "visit", visitId: "oak" } }))).toEqual([{ kind: "ask-finish", visitId: "oak", complete: false, stopClock: true }]);
      expect(geofenceActions([left()], ctx({ mode: "remind" }))).toEqual([]);
    });
  });

  describe("start and stop the clock", () => {
    it("starts their clock at the arrival and still asks them to start the visit (that can text the client)", () => {
      expect(geofenceActions([arrived()], ctx())).toEqual([
        { kind: "start-clock", visitId: "oak", at: T0 },
        { kind: "ask-start", visitId: "oak", clockOnly: false },
      ]);
    });

    it("moves them onto the visit from driving or another visit, as a tap would", () => {
      expect(geofenceActions([arrived()], ctx({ clock: { category: "drive", visitId: null }, day: true }))[0]).toEqual({ kind: "start-clock", visitId: "oak", at: T0 });
      expect(geofenceActions([arrived()], ctx({ clock: { category: "visit", visitId: "elm" } }))[0]).toEqual({ kind: "start-clock", visitId: "oak", at: T0 });
    });

    it("starts their clock on a visit a crewmate started, and asks nothing more", () => {
      expect(geofenceActions([arrived()], ctx({ sites: [{ ...OAK, status: "in_progress" }] }))).toEqual([{ kind: "start-clock", visitId: "oak", at: T0 }]);
    });

    it("leaves a clock already on the visit as it is", () => {
      expect(geofenceActions([arrived()], ctx({ sites: [{ ...OAK, status: "in_progress" }], clock: { category: "visit", visitId: "oak" } }))).toEqual([]);
    });

    it("never starts a clock over a break: it asks instead", () => {
      expect(geofenceActions([arrived()], ctx({ clock: { category: "break", visitId: null } }))).toEqual([{ kind: "ask-start", visitId: "oak", clockOnly: false }]);
      expect(geofenceActions([arrived()], ctx({ clock: { category: "break", visitId: null }, sites: [{ ...OAK, status: "in_progress" }] }))).toEqual([{ kind: "ask-start", visitId: "oak", clockOnly: true }]);
    });

    it("never starts a clock on a finished or cancelled visit, nor asks about one", () => {
      for (const status of ["completed", "cancelled"]) {
        expect(geofenceActions([arrived(), left()], ctx({ sites: [{ ...OAK, status }], clock: { category: "visit", visitId: "oak" } }))).toEqual([]);
      }
    });

    it("doesn't fight a tap: after one there, it only asks", () => {
      expect(geofenceActions([arrived("oak", true)], ctx())).toEqual([{ kind: "ask-start", visitId: "oak", clockOnly: false }]);
      expect(geofenceActions([left("oak", true)], ctx({ sites: [{ ...OAK, status: "in_progress" }], clock: { category: "visit", visitId: "oak" } }))).toEqual([
        { kind: "ask-finish", visitId: "oak", complete: true, stopClock: true },
      ]);
    });

    it("stops their clock on the visit as they leave, and asks them to complete it", () => {
      expect(geofenceActions([left()], ctx({ sites: [{ ...OAK, status: "in_progress" }], clock: { category: "visit", visitId: "oak" } }))).toEqual([
        { kind: "stop-clock", visitId: "oak", at: T0 + 60 * min, travel: false },
        { kind: "ask-finish", visitId: "oak", complete: true, stopClock: false },
      ]);
    });

    it("moves it to travel on the whole-day clock", () => {
      expect(geofenceActions([left()], ctx({ day: true, clock: { category: "visit", visitId: "oak" } }))).toEqual([{ kind: "stop-clock", visitId: "oak", at: T0 + 60 * min, travel: true }]);
    });

    it("leaves a clock that isn't on the visit as it is (a break, the next visit, driving)", () => {
      expect(geofenceActions([left()], ctx({ clock: { category: "break", visitId: null } }))).toEqual([]);
      expect(geofenceActions([left()], ctx({ clock: { category: "visit", visitId: "elm" } }))).toEqual([]);
      expect(geofenceActions([left()], ctx({ sites: [{ ...OAK, status: "in_progress" }], clock: { category: "drive", visitId: null } }))).toEqual([
        { kind: "ask-finish", visitId: "oak", complete: true, stopClock: false },
      ]);
    });

    it("never completes a visit itself", () => {
      const all = geofenceActions([left(), arrived()], ctx({ sites: [{ ...OAK, status: "in_progress" }], clock: { category: "visit", visitId: "oak" } }));
      expect(all.map((a) => a.kind)).not.toContain("complete");
    });

    it("acts on one visit when two are at the same property: the one under way, else the first", () => {
      const twin = { ...OAK, visitId: "oak-2" };
      expect(geofenceActions([arrived("oak"), arrived("oak-2")], ctx({ sites: [OAK, twin] }))).toEqual([
        { kind: "start-clock", visitId: "oak", at: T0 },
        { kind: "ask-start", visitId: "oak", clockOnly: false },
      ]);
      expect(geofenceActions([arrived("oak"), arrived("oak-2")], ctx({ sites: [OAK, { ...twin, status: "in_progress" }] }))).toEqual([{ kind: "start-clock", visitId: "oak-2", at: T0 }]);
    });

    it("stops the clock at the last property before starting it at the next, from one fix", () => {
      const sites = [{ ...OAK, status: "in_progress" }, ELM];
      expect(geofenceActions([arrived("elm"), left("oak")], ctx({ sites, clock: { category: "visit", visitId: "oak" } }))).toEqual([
        { kind: "stop-clock", visitId: "oak", at: T0 + 60 * min, travel: false },
        { kind: "ask-finish", visitId: "oak", complete: true, stopClock: false },
        { kind: "start-clock", visitId: "elm", at: T0 },
        { kind: "ask-start", visitId: "elm", clockOnly: false },
      ]);
    });

    it("ignores a visit it doesn't have (taken off today since)", () => {
      expect(geofenceActions([arrived("gone"), left("gone")], ctx())).toEqual([]);
    });
  });
});

describe("how often to look", () => {
  it("looks soon and with GPS before the first fix, and while an arrival or departure is being confirmed", () => {
    expect(nextLook(emptyGeofence(), null, [OAK], 200)).toEqual({ delayMs: 20_000, precise: true });
    const halfway = run([fix(10, 0)]).state;
    expect(nextLook(halfway, fix(10, 0), [OAK], 200)).toEqual({ delayMs: 20_000, precise: true });
  });

  it("every half minute near a property or while there", () => {
    expect(nextLook(run([fix(1000, 0)]).state, fix(1000, 0), [OAK], 200)).toEqual({ delayMs: 30_000, precise: true });
    expect(nextLook(run([fix(10, 0), fix(10, 1)]).state, fix(10, 1), [OAK], 200)).toEqual({ delayMs: 30_000, precise: true });
  });

  it("less often, and roughly, far from all of them", () => {
    expect(nextLook(run([fix(5000, 0)]).state, fix(5000, 0), [OAK], 200)).toEqual({ delayMs: 60_000, precise: true });
    expect(nextLook(run([fix(30_000, 0)]).state, fix(30_000, 0), [OAK], 200)).toEqual({ delayMs: 120_000, precise: false });
  });

  it("doesn't count finished visits", () => {
    expect(nextLook(emptyGeofence(), fix(10, 0), [{ ...OAK, status: "completed" }], 200)).toEqual({ delayMs: 120_000, precise: false });
  });
});
