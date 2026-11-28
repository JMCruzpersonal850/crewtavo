/**
 * The words on the client's live tracking page (/track/:token, TrackPage.tsx), kept apart from
 * the page so they can be tested: above all the honesty label — how old the crew's last reported
 * place is, said plainly, because a phone browser can't report from the background and the pin
 * the client sees may be minutes old.
 */

/** How long ago the crew's phone last reported, as a person would say it. */
export function ageWords(ageSeconds: number): string {
  const s = Math.max(0, Math.floor(ageSeconds));
  if (s < 45) return "just now";
  if (s < 90) return "1 minute ago";
  const minutes = Math.round(s / 60);
  if (minutes < 60) return `${minutes} minutes ago`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} ${hours === 1 ? "hour" : "hours"} ${rest} minutes ago` : `${hours} ${hours === 1 ? "hour" : "hours"} ago`;
}

/** The drive still to go, as the page says it: "about 12 minutes away", "about an hour away". */
export function etaWords(etaMinutes: number): string {
  const m = Math.max(1, Math.round(etaMinutes));
  if (m === 1) return "about 1 minute away";
  if (m < 60) return `about ${m} minutes away`;
  const hours = Math.floor(m / 60);
  const rest = m % 60;
  if (!rest) return hours === 1 ? "about an hour away" : `about ${hours} hours away`;
  return `about ${hours} ${hours === 1 ? "hour" : "hours"} ${rest} minutes away`;
}
