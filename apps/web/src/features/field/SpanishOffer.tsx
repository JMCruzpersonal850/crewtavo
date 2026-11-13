/**
 * My day asks once, in both languages, whether to use Crewtavo in Spanish: for someone who hasn't
 * chosen a language yet whose phone is set to Spanish (or who chose Spanish on this phone before
 * signing in). Either answer is saved with them (profiles.locale), so it isn't asked again on any
 * phone; Settings → Profile → Language changes it later. A server older than the language choice
 * sends no locale at all, and then nothing is asked.
 */
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { FormError } from "@/components/ui/Field";
import { deviceLocale, phoneSpeaksSpanish, type Locale } from "@/lib/i18n";
import { useSession } from "@/lib/session";
import { saveLanguage } from "../settings/Language";

const ASKED = "crewtavo.locale-asked";

const askedHere = () => {
  try {
    return localStorage.getItem(ASKED) === "1";
  } catch {
    return false;
  }
};

export function SpanishOffer() {
  const session = useSession();
  const [hidden, setHidden] = useState(askedHere);
  const answer = useMutation({
    meta: { inline: true },
    mutationFn: async (locale: Locale) => {
      try {
        localStorage.setItem(ASKED, "1");
      } catch {
        // Private mode: saved with them all the same.
      }
      await saveLanguage(session, locale);
    },
    onSuccess: () => setHidden(true),
  });
  if (hidden || session.profile.locale !== null || !(phoneSpeaksSpanish() || deviceLocale() === "es")) return null;
  // Asked in Spanish, with the English underneath for whoever reads the screen with them.
  return (
    <section className="card card-pad stack-sm" aria-labelledby="spanish-offer">
      {/* i18n-ignore: asked in both languages whatever the app is in */}
      <strong id="spanish-offer" lang="es" style={{ fontSize: 16 }}>¿Usar Crewtavo en español?</strong>
      {/* i18n-ignore */}
      <span className="muted small" lang="en">Use Crewtavo in Spanish? You can change it later in Settings → Profile.</span>
      <FormError error={answer.error} />
      <div className="row wrap" style={{ gap: 8 }}>
        {/* i18n-ignore */}
        <Button variant="primary" lang="es" loading={answer.isPending && answer.variables === "es"} onClick={() => answer.mutate("es")}>Sí, en español</Button>
        {/* i18n-ignore */}
        <Button lang="en" loading={answer.isPending && answer.variables === "en"} onClick={() => answer.mutate("en")}>No, keep English</Button>
      </div>
    </section>
  );
}
