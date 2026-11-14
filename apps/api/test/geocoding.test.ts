/**
 * Finding an address on the map: only the free geocoders are asked (the US Census, then
 * OpenStreetMap for places abroad), and an answer of "no such address" is told apart from no answer.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { geocodeAddress, lookUpAddress } from "../src/services/external";

/** Stub fetch: `answer` returns a Response, or a body to send back as JSON. Says which hosts were asked. */
function serve(answer: (url: URL) => Response | unknown) {
  const asked: URL[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    asked.push(url);
    const out = answer(url);
    return out instanceof Response ? out : Response.json(out);
  });
  return asked;
}
const census = (matches: unknown[]) => ({ result: { addressMatches: matches } });
const PELL = { matchedAddress: "418 PELL AVE, ROCKY MOUNT, VA, 24151", coordinates: { x: -79.88, y: 36.99 } };

afterEach(() => vi.unstubAllGlobals());

describe("looking an address up", () => {
  it("asks the Census geocoder, and nobody else for a US address", async () => {
    const asked = serve(() => census([PELL]));
    expect(await lookUpAddress("  418 Pell   Ave, Rocky Mount, VA ")).toEqual({ lat: 36.99, lng: -79.88, formatted: PELL.matchedAddress, country: "US", source: "census" });
    expect(asked.map((u) => u.host)).toEqual(["geocoding.geo.census.gov"]);
    expect(asked[0]!.searchParams.get("address")).toBe("418 Pell Ave, Rocky Mount, VA");
  });

  it("never asks Google, whatever keys the server has", async () => {
    const asked = serve((url) => (url.host === "photon.komoot.io" ? { features: [] } : census([])));
    await lookUpAddress("418 Pell Ave, Rocky Mount, VA");
    await lookUpAddress("10 Downing Street, London", { world: true });
    expect(asked.some((u) => /google/.test(u.host))).toBe(false);
    expect(new Set(asked.map((u) => u.host))).toEqual(new Set(["geocoding.geo.census.gov", "photon.komoot.io"]));
  });

  it("says an address the Census doesn't know apart from a Census that didn't answer", async () => {
    serve(() => census([]));
    expect(await lookUpAddress("1 Nowhere Lane, Rocky Mount, VA")).toBe("none");
    expect(await geocodeAddress("1 Nowhere Lane, Rocky Mount, VA")).toBeNull();

    serve(() => new Response("busy", { status: 503 }));
    expect(await lookUpAddress("418 Pell Ave, Rocky Mount, VA")).toBe("failed");
    serve(() => new Response("<html>maintenance</html>", { status: 200 }));
    expect(await lookUpAddress("418 Pell Ave, Rocky Mount, VA")).toBe("failed");
    vi.stubGlobal("fetch", async () => {
      throw new Error("offline");
    });
    expect(await lookUpAddress("418 Pell Ave, Rocky Mount, VA")).toBe("failed");
    expect(await geocodeAddress("418 Pell Ave, Rocky Mount, VA")).toBeNull();
  });

  it("looks abroad in OpenStreetMap only when asked to", async () => {
    const london = { features: [{ geometry: { coordinates: [-0.1276, 51.5034] }, properties: { housenumber: "10", street: "Downing Street", city: "London", country: "United Kingdom", countrycode: "gb" } }] };
    const asked = serve((url) => (url.host === "photon.komoot.io" ? london : census([])));
    expect(await lookUpAddress("10 Downing Street, London")).toBe("none");
    expect(asked).toHaveLength(1);
    expect(await lookUpAddress("10 Downing Street, London", { world: true })).toEqual({ lat: 51.5034, lng: -0.1276, formatted: "10 Downing Street, London, United Kingdom", country: "GB", source: "openstreetmap" });

    serve((url) => (url.host === "photon.komoot.io" ? { features: [] } : census([])));
    expect(await lookUpAddress("1 Nowhere, Atlantis", { world: true })).toBe("none");
    serve((url) => (url.host === "photon.komoot.io" ? new Response("busy", { status: 503 }) : census([])));
    expect(await lookUpAddress("10 Downing Street, London", { world: true })).toBe("failed");
  });

  it("doesn't ask about a few letters", async () => {
    const asked = serve(() => census([PELL]));
    expect(await lookUpAddress(" 418 ")).toBe("none");
    expect(asked).toHaveLength(0);
  });
});
