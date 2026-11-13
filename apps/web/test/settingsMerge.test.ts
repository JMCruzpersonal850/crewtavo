/**
 * Settings → Company and Settings → Schedule save only their own settings, merged into the ones
 * saved (public.merge_company_settings, tested in supabase/tests/company_settings_merge_test.sql),
 * so a page open since before a newer change (a weather rule, an app turned on) doesn't undo it.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const source = (file: string) => readFileSync(fileURLToPath(new URL(`../src/features/settings/${file}`, import.meta.url)), "utf8");

describe("saving company settings", () => {
  it("merges the screen's own keys instead of writing back the whole settings it loaded", () => {
    for (const file of ["CompanySettings.tsx", "ScheduleSettings.tsx"]) {
      const code = source(file);
      expect(code, file).toContain(`rpc("merge_company_settings", { p_company: company.id, p_settings:`);
      expect(code, file).not.toMatch(/\.\.\.previous\b/);
      expect(code, file).not.toMatch(/from\("companies"\)\s*\.update\(\{[^}]*settings:/);
    }
  });

  it("saves whether a one-off job is marked complete when its last visit is finished, under the name the database reads", () => {
    const code = source("CompanySettings.tsx");
    expect(code).toContain('jobs: { complete_when_visits_done: v.complete_jobs === "1" }');
    expect(code).toContain('complete_jobs: completesWhenVisitsDone(s) ? "1" : ""');
    const sql = readFileSync(fileURLToPath(new URL("../../../supabase/migrations/20261113000100_finished_jobs_ask_for_their_invoice.sql", import.meta.url)), "utf8");
    expect(sql).toContain("c.settings -> 'jobs' -> 'complete_when_visits_done'");
    // The job's page says when the database marked it, with the way back beside it.
    const page = readFileSync(fileURLToPath(new URL("../src/features/jobs/JobPage.tsx", import.meta.url)), "utf8");
    expect(page).toContain("Marked complete when its last visit was finished");
    expect(page).toContain('j.finished_by_visits_at && ["requires_invoicing", "completed"].includes(j.status)');
  });

  it("saves how the clock works beside the other clock settings, under the name the database reads", () => {
    const code = source("CompanySettings.tsx");
    expect(code).toContain('clock: { record_location: v.record_location === "1", breaks: v.breaks, mode: v.clock_mode }');
    expect(code).toContain("clock_mode: clockMode(s)");
    // Both choices are offered, each with its one line.
    expect(code).toContain("(Object.keys(CLOCK_MODE_LABELS) as ClockMode[]).map");
    expect(code).toContain("hint={CLOCK_MODE_HINTS[f.clock_mode as ClockMode]}");
    const sql = readFileSync(fileURLToPath(new URL("../../../supabase/migrations/20261113000610_whole_day_clock.sql", import.meta.url)), "utf8");
    expect(sql).toContain("c.settings -> 'clock' ->> 'mode'");
  });

  it("saves the workdays with the workday hours", () => {
    expect(source("CompanySettings.tsx")).toContain(`working_hours: { start: v.hours_start, end: v.hours_end, days: v.workdays.split(",").map(Number) }`);
  });
});
