/**
 * The rules a business can build on a visit being booked, moved or cancelled (automations.ts):
 * what starts them, what a message can say, and that they take no wait of their own (the database
 * holds them ten minutes for the change to settle: 20261113000500_visit_notices.sql).
 */
import { describe, expect, it } from "vitest";
import {
  actionsForTrigger,
  describeRuleSentence,
  isVisitNotice,
  renderTemplate,
  TRIGGERS,
  triggerAllowed,
  triggerDef,
  validateRule,
  variablesForTrigger,
  VISIT_MOVED_WORDS,
  VISIT_NOTICE_SETTLE_MIN,
  VISIT_NOTICE_STARTERS,
  VISIT_NOTICE_TRIGGERS,
  visitNoticesPending,
  type Action,
} from "../src/automations";

const email: Action = { type: "send_email", subject: "Your visit", body: "{{date}}{{time}}" };

describe("a visit booked, moved or cancelled", () => {
  it("starts rules, in the order they happen and ahead of the reminder", () => {
    const visits = TRIGGERS.filter((t) => t.group === "Visits").map((t) => t.verb);
    expect(visits.slice(0, 4)).toEqual(["visit.scheduled", "visit.rescheduled", "visit.cancelled", "visit.reminder"]);
    expect(VISIT_NOTICE_TRIGGERS.map((verb) => triggerDef(verb)?.label)).toEqual(["A visit is booked", "A visit is moved", "A visit is cancelled"]);
    for (const verb of VISIT_NOTICE_TRIGGERS) expect(triggerDef(verb)).toMatchObject({ group: "Visits", subject: "visit", delayable: false });
  });

  it("is open to anyone who builds rules, and takes every action a visit's rule can", () => {
    for (const verb of VISIT_NOTICE_TRIGGERS) {
      expect(triggerAllowed(verb, () => false)).toBe(true);
      expect(actionsForTrigger(verb).map((a) => a.type)).toEqual(expect.arrayContaining(["send_email", "send_sms", "notify", "create_task", "add_note"]));
      expect(validateRule({ name: "Tell them", trigger: verb, delay_minutes: 0, conditions: [], actions: [email, { type: "send_sms", body: "{{date}}" }] })).toEqual([]);
    }
  });

  it("can say the day, the time, the address and the Hub link, and where a moved visit was", () => {
    for (const verb of VISIT_NOTICE_TRIGGERS) {
      expect(variablesForTrigger(verb).map((v) => v.token)).toEqual(expect.arrayContaining(["date", "time", "address", "link", "client.first_name", "company.phone"]));
    }
    expect(variablesForTrigger("visit.rescheduled").map((v) => v.token)).toEqual(expect.arrayContaining(["old.date", "old.time"]));
    expect(variablesForTrigger("visit.scheduled").map((v) => v.token)).not.toContain("old.date");
    expect(variablesForTrigger("visit.cancelled").map((v) => v.token)).not.toContain("old.date");
    // Nothing about a move is kept from a task: the crew knows where a visit was.
    expect(variablesForTrigger("visit.rescheduled", true).map((v) => v.token)).toContain("old.date");
    expect(renderTemplate("It was {{old.date}}{{old.time}} and is now {{date}}{{time}}.", { date: "Thursday, October 29", time: " at 9:00 AM", old: { date: "Wednesday, October 28", time: "" } })).toBe(
      "It was Wednesday, October 28 and is now Thursday, October 29 at 9:00 AM.",
    );
  });

  it("gives the reminder and the other visit rules the Hub link too", () => {
    for (const verb of ["visit.reminder", "visit.en_route", "visit.completed"]) expect(variablesForTrigger(verb).map((v) => v.token)).toContain("link");
    expect(variablesForTrigger("job.completed").map((v) => v.token)).not.toContain("link");
  });

  it("reads as a sentence", () => {
    expect(describeRuleSentence({ trigger: "visit.rescheduled", delay_minutes: 0, conditions: [], actions: [email] })).toBe("When a visit is moved: email the client.");
    expect(describeRuleSentence({ trigger: "visit.scheduled", delay_minutes: 0, conditions: [{ field: "kind", op: "equals", value: "assessment" }], actions: [email, { type: "send_sms", body: "Hi" }] })).toBe(
      "When a visit is booked, if type is Assessment: email the client, then text the client.",
    );
  });

  it("is told apart from everything else that happens to a visit", () => {
    expect(VISIT_NOTICE_TRIGGERS.every(isVisitNotice)).toBe(true);
    for (const verb of ["visit.reminder", "visit.en_route", "visit.completed", "visit.reschedule_requested", "visit.cancel_requested", "job.created", "", null, undefined]) expect(isVisitNotice(verb)).toBe(false);
  });

  it("has a note to answer only for a business that was running before these messages", () => {
    expect(VISIT_NOTICE_STARTERS).toEqual(["visit_scheduled", "visit_rescheduled", "visit_cancelled"]);
    expect(visitNoticesPending({ visit_notices: { pending: true } })).toBe(true);
    // Answered, a business made since (nothing saved), and anything that isn't the setting.
    for (const settings of [{ visit_notices: { pending: false, answered_at: "2026-11-13T12:00:00Z" } }, {}, null, undefined, { visit_notices: null }, { visit_notices: "pending" }, { visit_notices: { pending: "true" } }]) {
      expect(visitNoticesPending(settings)).toBe(false);
    }
  });

  it("says in words what a move is and how long a message waits", () => {
    expect(VISIT_NOTICE_SETTLE_MIN).toBe(10);
    expect(VISIT_MOVED_WORDS).toContain("its day changes, or its start time changes by an hour or more");
    expect(VISIT_MOVED_WORDS).toContain("arrival window");
  });
});
