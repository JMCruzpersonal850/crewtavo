/**
 * How the time clock works, as the company sets it (settings.clock.mode; Settings → Company → Time
 * clock). The database reads the same setting (private.clock_mode) when a visit is finished.
 *
 *   visits   The clock runs while a visit is in progress: Start visit starts it, Complete visit
 *            stops it. Driving and shop time are on the clock only when someone starts a timer.
 *   day      The clock runs all day: On my way starts it on travel, Start visit moves it onto the
 *            visit, Complete visit moves everyone on that visit's clock back to travel, and it
 *            stops when the person taps Stop for the day.
 *
 * A company from before the setting has none saved and stays on visits. A new company starts on
 * day (the database sets it as the company is made). Travel is the Driving timer: paid time for the
 * person, on no job. A subcontractor's clock is always visits only.
 */
export type ClockMode = "visits" | "day";

export const CLOCK_MODE_LABELS: Record<ClockMode, string> = {
  visits: "Visits only",
  day: "Whole day",
};

/** One line under the setting for each choice. */
export const CLOCK_MODE_HINTS: Record<ClockMode, string> = {
  visits: "The clock runs while a visit is in progress: Start visit starts it and Complete visit stops it. Driving counts only when someone starts a Driving timer.",
  day: "Travel between visits is on the clock. On my way starts it, Start visit moves it onto the visit, Complete visit moves it back to driving, and it runs until the person taps Stop for the day.",
};

/** The company's choice, from its settings. */
export function clockMode(settings: unknown): ClockMode {
  const clock = (settings as { clock?: unknown } | null | undefined)?.clock;
  return clock && typeof clock === "object" && (clock as { mode?: unknown }).mode === "day" ? "day" : "visits";
}
