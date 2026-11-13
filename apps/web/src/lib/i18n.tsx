/**
 * The app's language: English, or Spanish for whoever chooses it (Settings → Profile → Language, My
 * day's question when the phone speaks Spanish, or the switch on the sign-in page). The translation
 * layer itself is @crewtavo/core/i18n; this keeps the choice and loads the Spanish lines.
 *
 * Which language: the person's own choice (profiles.locale, the same on every phone they use), else
 * the choice made on this device, else English. The phone's own language doesn't switch anyone over
 * by itself: it only makes My day ask. The choice made last is kept on the device too, so the app
 * opens in it straight away, also before signing in and with no signal.
 *
 * Changing language reloads the page, so lists and labels made as the app loaded don't mix the two.
 * Spanish is its own file, downloaded only for someone using it (the service worker keeps it for
 * when there's no signal).
 */
import { Fragment, type ReactNode } from "react";
import { getLocale, isLocale, setLocale, t, type Locale } from "@crewtavo/core/i18n";

export { english, getLocale, intlLocale, isLocale, LOCALE_NAMES, msg, t, type Locale } from "@crewtavo/core/i18n";

const KEY = "crewtavo.locale";

/** The language chosen on this device, or null for none. */
export function deviceLocale(): Locale | null {
  try {
    const value = localStorage.getItem(KEY);
    return isLocale(value) ? value : null;
  } catch {
    return null;
  }
}

function keepOnDevice(locale: Locale | null) {
  try {
    if (locale) localStorage.setItem(KEY, locale);
    else localStorage.removeItem(KEY);
  } catch {
    // Private mode: the choice lasts until the tab closes.
  }
}

/** What the language was meant to be as the app opened (Spanish can fail to load with no signal). */
let wanted: Locale = "en";

/** Pages for clients (their hub, booking forms, referral and unsubscribe links) stay in English for now. */
const CLIENT_FACING = /^\/(hub|book|u|refer)\//;

/** Loads the language chosen on this device before the first screen shows. */
export async function startLocale() {
  wanted = CLIENT_FACING.test(window.location.pathname) ? "en" : deviceLocale() ?? "en";
  if (wanted === "es") {
    try {
      const { installSpanish } = await import("@crewtavo/core/i18n/es");
      installSpanish();
      setLocale("es");
    } catch {
      // Not downloaded yet and no signal: English until it can be.
    }
  }
  document.documentElement.lang = getLocale();
}

/** Switches the app to a language now: kept on this device, and the page reloads into it. */
export function switchLocale(locale: Locale) {
  keepOnDevice(locale);
  if (locale !== wanted) window.location.reload();
}

/**
 * Once the signed-in person is known: their own choice wins over this device's, and is kept here
 * for next time. Reloads when that means another language than the one the app opened in.
 */
export function followProfile(profileLocale: string | null | undefined) {
  if (isLocale(profileLocale) && profileLocale !== deviceLocale()) keepOnDevice(profileLocale);
  const effective = isLocale(profileLocale) ? profileLocale : deviceLocale() ?? "en";
  if (effective !== wanted) window.location.reload();
}

/** Whether the phone or browser is set to Spanish (for offering it, never for switching unasked). */
export const phoneSpeaksSpanish = () => {
  try {
    return /^es\b/i.test(navigator.languages?.[0] ?? navigator.language ?? "");
  } catch {
    return false;
  }
};

type Part = ReactNode | ((inner: ReactNode) => ReactNode);

/**
 * A sentence with links or emphasis inside, translated whole:
 *   <T text="Read the <link>terms</link> before {date}" link={(s) => <Link to="/license">{s}</Link>} date={when} />
 * Each <name>…</name> is drawn by the function of that name; each {name} is the value of that name.
 */
export function T({ text, ...parts }: { text: string } & Record<string, Part>) {
  return <>{render(t(text), parts)}</>;
}

function render(text: string, parts: Record<string, Part>): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /<(\w+)>([\s\S]*?)<\/\1>|\{(\w+)\}/g;
  let last = 0;
  let index = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const [whole, tag, inner, name] = m;
    const part = parts[tag ?? name!];
    if (tag) out.push(<Fragment key={index++}>{typeof part === "function" ? part(render(inner!, parts)) : render(inner!, parts)}</Fragment>);
    else if (part === undefined) out.push(whole);
    else out.push(<Fragment key={index++}>{typeof part === "function" ? part(null) : part}</Fragment>);
    last = m.index + whole.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
