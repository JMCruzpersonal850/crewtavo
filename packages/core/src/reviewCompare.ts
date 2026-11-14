/**
 * How you compare (Marketing → Reviews): the business's Google rating and review count next to up to
 * five competitors' (apps/api/src/services/reviewCompare.ts keeps them, refreshed weekly). Shared by
 * the API and the card: when a check is due, how a count changed, and where the business stands.
 */

export const MAX_COMPETITORS = 5;
/** The background task checks each company this often. */
export const AUTO_DAYS = 7;
/** A check by hand, at most this often. */
export const HAND_HOURS = 24;

const HOUR = 3_600_000;

/** Whether the weekly check is due. */
export const autoDue = (checkedAt: string | null | undefined, now = Date.now()) => !checkedAt || now - Date.parse(checkedAt) >= AUTO_DAYS * 24 * HOUR;

/** When a check by hand can be made again, or null when it can be now. A check by the task counts too. */
export function nextHandCheck(checkedAt: string | null | undefined, now = Date.now()): Date | null {
  if (!checkedAt) return null;
  const next = Date.parse(checkedAt) + HAND_HOURS * HOUR;
  return next > now ? new Date(next) : null;
}

export interface ComparedPlace {
  id: string;
  name: string;
  is_own: boolean;
  rating: number | null;
  ratings_total: number | null;
  previous_total: number | null;
  checked_at: string | null;
  previous_checked_at: string | null;
}

/** How many reviews a place gained (or lost) since the check before, or null when there's nothing to compare. */
export function countChange(p: Pick<ComparedPlace, "ratings_total" | "previous_total">): number | null {
  if (p.ratings_total == null || p.previous_total == null) return null;
  return p.ratings_total - p.previous_total;
}

/** "+3", "−1", "No change", or "" with nothing to compare. */
export function changeWords(change: number | null): string {
  if (change == null) return "";
  if (change === 0) return "No change";
  return change > 0 ? `+${change.toLocaleString("en-US")}` : `−${Math.abs(change).toLocaleString("en-US")}`;
}

/** Places best first: the higher rating, then more reviews, then the name; places not checked yet last. */
export function ranked<T extends Pick<ComparedPlace, "name" | "rating" | "ratings_total">>(places: readonly T[]): T[] {
  return [...places].sort(
    (a, b) => (b.rating ?? -1) - (a.rating ?? -1) || (b.ratings_total ?? -1) - (a.ratings_total ?? -1) || a.name.localeCompare(b.name),
  );
}

export interface Standing {
  /** 1 for the best rating. */
  rank: number;
  of: number;
  /** The business's rating less the competitors' average, to one decimal; null without both. */
  ratingVsAverage: number | null;
  /** The business's reviews less the competitors' average, whole; null without both. */
  reviewsVsAverage: number | null;
  /** Reviews gained since the check before, the business's and the competitors' average. */
  gained: number | null;
  averageGained: number | null;
}

const average = (values: number[]) => (values.length ? values.reduce((s, v) => s + v, 0) / values.length : null);

/** Where the business stands among the places checked, or null without its own place or any competitor checked. */
export function standing(places: readonly ComparedPlace[]): Standing | null {
  const own = places.find((p) => p.is_own);
  const others = places.filter((p) => !p.is_own);
  if (!own || own.rating == null || !others.some((p) => p.rating != null)) return null;
  const order = ranked(places.filter((p) => p.rating != null));
  const ratings = others.map((p) => p.rating).filter((r): r is number => r != null);
  const counts = others.map((p) => p.ratings_total).filter((n): n is number => n != null);
  const gains = others.map(countChange).filter((n): n is number => n != null);
  const avgRating = average(ratings);
  const avgCount = average(counts);
  return {
    rank: order.findIndex((p) => p.id === own.id) + 1,
    of: order.length,
    ratingVsAverage: avgRating == null ? null : Math.round((own.rating - avgRating) * 10) / 10,
    reviewsVsAverage: avgCount == null || own.ratings_total == null ? null : Math.round(own.ratings_total - avgCount),
    gained: countChange(own),
    averageGained: gains.length ? Math.round(average(gains)! * 10) / 10 : null,
  };
}

/** "Highest rated of 4", "2nd of 4 by rating". */
export function standingWords(s: Pick<Standing, "rank" | "of">): string {
  if (s.rank === 1) return `Highest rated of ${s.of}`;
  const suffix = s.rank % 100 >= 11 && s.rank % 100 <= 13 ? "th" : ({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[s.rank % 10] ?? "th";
  return `${s.rank}${suffix} of ${s.of} by rating`;
}
