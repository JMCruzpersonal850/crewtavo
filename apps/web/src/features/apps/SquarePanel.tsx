/**
 * Square on its app page: the business's own Square account, so clients pay through the
 * Square it already uses instead of having to move to Stripe. Square has no sign-in flow to
 * send anyone through (a developer app's token is its way in), so the setup guides instead of
 * just asking: numbered steps walk to the app in Square's Developer Dashboard (the same login
 * as the Square account itself), the Application ID and access token are pasted here and
 * checked with Square before anything is kept — its locations are read back, and the one
 * payments are taken at is picked from that list, never typed as an id. A developer app has a
 * sandbox and a production side with different tokens, so which side is part of connecting:
 * sandbox first, with Square's test cards, and production when it's real money. Once
 * connected: the location payments are taken at, and "Payment updates": the address Square
 * needs, with the steps to make the webhook subscription in Square and keep its signature
 * key here so Crewtavo can check the updates that arrive were really sent by Square. A
 * Crewtavo whose server was given a Square account works without any of this, and says so.
 */
import { useMutation } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/Button";
import { Field, FormChecks, FormError } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { Fact, Facts, Section } from "@/components/ui/Section";
import { api } from "@/lib/api";
import type { AppRow, SquareState } from "./catalog";
import { CodeRow, Steps, Step, kit } from "./PanelKit";

/** Square's Developer Dashboard: where the app, its credentials and its webhooks live. */
const SQUARE_DASHBOARD = "https://developer.squareup.com/apps";

interface SquareLocation {
  id: string;
  name: string;
  currency?: string;
}

type Environment = "sandbox" | "production";

export function SquarePanel({ app, onChanged }: { app: AppRow; onChanged: () => void }) {
  const state = app.square ?? null;
  const [changing, setChanging] = useState(false);
  if (state?.own && app.status !== "disconnected" && !changing) return <Connected app={app} state={state} onChange={() => setChanging(true)} />;
  return (
    <>
      {state?.server && (
        <section className="callout callout-good" aria-label="Payments">
          <Icon name="check" size={16} />
          <div className="grow">
            <div>Clients pay through the Square account set up for this server</div>
            Nothing to do here. To take payments through your own Square account instead, connect it below.
          </div>
        </section>
      )}
      <ConnectForm
        app={app}
        changing={changing || Boolean(state?.own)}
        optional={Boolean(state?.server)}
        onSaved={() => {
          setChanging(false);
          onChanged();
        }}
        onCancel={changing ? () => setChanging(false) : undefined}
      />
    </>
  );
}

function ConnectForm({ app, changing, optional, onSaved, onCancel }: { app: AppRow; changing: boolean; optional: boolean; onSaved: () => void; onCancel?: () => void }) {
  const [applicationId, setApplicationId] = useState("");
  const [accessToken, setAccessToken] = useState("");
  const [environment, setEnvironment] = useState<Environment>("sandbox");
  const [show, setShow] = useState(false);
  const [locations, setLocations] = useState<SquareLocation[] | null>(null);
  const [picked, setPicked] = useState("");
  const [webhookKey, setWebhookKey] = useState("");
  const check = useMutation({
    meta: { inline: true },
    mutationFn: () => api.post<{ locations: SquareLocation[] }>(`/apps/${app.id}/check`, { access_token: accessToken.trim(), environment }),
    onSuccess: (res) => {
      setLocations(res.locations);
      setPicked(res.locations[0]?.id ?? "");
    },
  });
  const save = useMutation({
    meta: { inline: true, success: "Square connected" },
    mutationFn: () =>
      api.put(`/apps/${app.id}/account`, {
        application_id: applicationId.trim(),
        access_token: accessToken.trim(),
        environment,
        location_id: picked,
        ...(webhookKey.trim() ? { webhook_key: webhookKey.trim() } : {}),
      }),
    onSuccess: () => {
      setAccessToken("");
      setLocations(null);
      onSaved();
    },
  });
  const editCredentials = (apply: () => void) => {
    apply();
    // Different credentials are a different account (or its other side): its locations have to be read again.
    setLocations(null);
    setPicked("");
    check.reset();
    save.reset();
  };
  return (
    <Section className={kit.panel} id="app-setup" title={changing ? "Change your Square account" : optional ? "Use your own Square account" : "Connect your Square account"}>
      <p className={kit.note}>
        About ten minutes. Square connects with an access token from a free developer app — there's no sign-in page to send you to, so here's exactly where everything lives.
        Square bills you directly for the payments you take, the same rates as your Square account today.
      </p>
      <Steps>
        <Step>
          <a className="btn btn-sm" href={SQUARE_DASHBOARD} target="_blank" rel="noreferrer">Open the Square Developer Dashboard <Icon name="external" size={12} /></a>
          <p className={kit.note}>Sign in with your normal Square login — no new account. Click <strong>+ New App</strong>, name it <strong>Crewtavo</strong>, and open it.</p>
        </Step>
        <Step>
          In the app, open <strong>Credentials</strong>. It has two sides, <strong>Sandbox</strong> and <strong>Production</strong>, each with its own Application ID and access token.
          Start with <strong>Sandbox</strong>: nothing real is charged there, and Square's test cards work. Copy the <strong>Application ID</strong> and the <strong>access token</strong> of the side you're connecting.
        </Step>
        <Step>Paste both here, pick the same side, and press <strong>Check this token</strong>. Crewtavo reads your Square locations back — at no cost, nothing is charged — and you pick the one payments are taken at.</Step>
      </Steps>
      <form
        className="stack-sm"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          if (locations) save.mutate();
          else check.mutate();
        }}
      >
        <Field label="Application ID" hint="From the app's Credentials, on the same side (Sandbox or Production) as the token.">
          <input className="input" value={applicationId} onChange={(e) => editCredentials(() => setApplicationId(e.target.value))} autoComplete="off" spellCheck={false} maxLength={100} required placeholder="sq0idp-…" />
        </Field>
        <Field label="Access token" hint="Stored encrypted and never shown again." requiredMessage="Paste your Square access token.">
          <div className="input-group">
            <input className="input" type={show ? "text" : "password"} value={accessToken} onChange={(e) => editCredentials(() => setAccessToken(e.target.value))} autoComplete="off" spellCheck={false} maxLength={300} required style={{ paddingRight: 36 }} placeholder="Your token from Square" />
            <button type="button" className="icon-btn addon-right" style={{ position: "absolute", right: 2, pointerEvents: "auto" }} aria-label={show ? "Hide token" : "Show token"} onClick={() => setShow(!show)}><Icon name={show ? "eye" : "lock"} size={14} /></button>
          </div>
        </Field>
        <Field label="Which side of Square" hint="Sandbox is for testing — no real money moves. Connect Production, with the production token, when you're ready for real payments.">
          <select className="select" value={environment} onChange={(e) => editCredentials(() => setEnvironment(e.target.value as Environment))}>
            <option value="sandbox">Sandbox (testing)</option>
            <option value="production">Production (real payments)</option>
          </select>
        </Field>
        <FormError error={check.error} />
        {!locations && (
          <div className="row wrap" style={{ gap: 8 }}>
            <Button type="submit" variant="primary" loading={check.isPending} disabled={!applicationId.trim() || !accessToken.trim()}>Check this token</Button>
            {onCancel && <Button onClick={onCancel}>Cancel</Button>}
          </div>
        )}
        {locations && (
          <>
            <span className="app-status"><Icon name="check" size={16} />Square accepted the token. {locations.length === 1 ? "Your account has one location:" : `Your account has ${locations.length} locations:`}</span>
            <Field label="The location payments are taken at" requiredMessage="Pick the location payments are taken at.">
              <select className="select" value={picked} onChange={(e) => setPicked(e.target.value)} required>
                {locations.map((l) => (
                  <option key={l.id} value={l.id}>{l.name}</option>
                ))}
              </select>
            </Field>
            <Field label="Webhook signature key (you can add this later)" hint="From the webhook subscription you'll make in Square for payment updates, below. With it, Crewtavo checks that updates really came from Square.">
              <input className="input" value={webhookKey} onChange={(e) => setWebhookKey(e.target.value)} autoComplete="off" spellCheck={false} maxLength={300} placeholder="Optional for now" />
            </Field>
            <FormError error={save.error} />
            <div className="row wrap" style={{ gap: 8 }}>
              <FormChecks />
              <Button type="submit" variant="primary" loading={save.isPending} disabled={!picked}>{changing ? "Save" : "Connect"}</Button>
              {onCancel && <Button onClick={onCancel}>Cancel</Button>}
            </div>
          </>
        )}
      </form>
    </Section>
  );
}

function Connected({ app, state, onChange }: { app: AppRow; state: SquareState; onChange: () => void }) {
  return (
    <>
      <Section className={kit.panel} title="Square account" action={<button type="button" onClick={onChange}><Icon name="edit" size={14} />Change account</button>}>
        {app.status === "error" && (
          <div className="callout callout-danger" role="alert">
            <Icon name="alert" size={16} />
            <div className="grow"><div>Square isn't accepting this token anymore</div>{app.last_error}</div>
          </div>
        )}
        {app.status !== "error" && app.last_error && <span className="field-error">{app.last_error}</span>}
        <Facts>
          <Fact label="Connected to">{app.status !== "error" && (app.account_label ?? "Connected")}</Fact>
          <Fact label="Payments taken at">{state.location_name ?? "—"}</Fact>
          <Fact label="Side">{state.environment === "sandbox" ? "Sandbox — testing, no real money moves" : "Production — real payments"}</Fact>
        </Facts>
        <p className={kit.note}>
          {state.active
            ? "Clients pay with Square: the card form on their invoice page charges this account, and deposits, tips and fees are recorded like Stripe's."
            : <>Clients pay with Stripe right now. <Link to="/settings?tab=payments">Choose Square in Settings → Payments</Link> to take payments here — invoices already sent keep the provider they went out with.</>}
        </p>
        {state.environment === "sandbox" && (
          <div className="callout callout-warning" role="note">
            <Icon name="alert" size={16} />
            <div className="grow">This is the sandbox side: test cards work, real cards don't. When you're ready, use <strong>Change account</strong> and connect the Production side with its token.</div>
          </div>
        )}
      </Section>
      <Section className={kit.panel} title="Payment updates">
        <p className={kit.note}>
          For payments to be reconciled even when an answer is lost on the way back, Square sends each payment's updates to this address. Square can't be set from here — it takes a few minutes in the Developer Dashboard:
        </p>
        <CodeRow value={state.webhook_url} name="Address for payment updates" done="Address copied" />
        <Steps>
          <Step>In the <a href={SQUARE_DASHBOARD} target="_blank" rel="noreferrer">Square Developer Dashboard</a>, open your app, then <strong>Webhooks → Subscriptions → Add subscription</strong>.</Step>
          <Step>Paste the address above exactly as it is — Square signs each update with this address as part of the signature, so even one letter different and updates are refused. Name it <strong>Crewtavo</strong>.</Step>
          <Step>Choose the events <strong>payment.created</strong> and <strong>payment.updated</strong>, and save.</Step>
          <Step>Open the subscription, copy its <strong>Signature key</strong>, and keep it under <strong>Change account</strong> here, so Crewtavo can check that the updates it receives were really sent by Square.</Step>
        </Steps>
        {!state.reachable && (
          <div className="callout callout-warning" role="note">
            <Icon name="alert" size={16} />
            <div className="grow">Square can only reach a public https address, and this Crewtavo doesn't have one yet. Clients can still pay; updates just can't arrive until it does.</div>
          </div>
        )}
        <p className={kit.note}>Payments are recorded the moment a charge completes; the updates are the safety net, and settle anything that was still on its way.</p>
      </Section>
    </>
  );
}
