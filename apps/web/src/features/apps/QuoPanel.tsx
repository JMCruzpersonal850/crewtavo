/**
 * Quo on its app page: the business's own Quo account, so texts go from the Quo number it
 * already has. Quo has no sign-in flow to send anyone through (an API key is its official way
 * in), so the setup guides instead of just asking: numbered steps walk to the key in Quo
 * (Workspace Settings → API, where it's generated and named), the key is pasted here and
 * checked with Quo before anything is kept — its numbers are read back, and the one texts go
 * from is picked from that list, never typed as an id. Once connected: the number texts go
 * from, and "Replies from clients": the address Quo needs, with the steps to make the webhook
 * in Quo and keep its signing key here so Crewtavo can check the texts that arrive were really
 * sent by Quo. A Crewtavo whose server was given a Quo account works without any of this, and
 * says so.
 */
import { TEXT_CONSENT_HINT } from "@crewtavo/core/marketing";
import { phoneDisplay } from "@crewtavo/core/phone";
import { useMutation } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/Button";
import { Field, FormChecks, FormError } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { Fact, Facts, Section } from "@/components/ui/Section";
import { api } from "@/lib/api";
import type { AppRow, QuoState } from "./catalog";
import { CodeRow, Steps, Step, kit } from "./PanelKit";

/** The Quo web app. Its API settings have no address of their own to link to: the steps carry it from here. */
const QUO_APP = "https://my.quo.com";

interface QuoNumber {
  id: string;
  number: string;
  name: string | null;
}

export function QuoPanel({ app, onChanged }: { app: AppRow; onChanged: () => void }) {
  const state = app.quo ?? null;
  const [changing, setChanging] = useState(false);
  if (state?.own && app.status !== "disconnected" && !changing) return <Connected app={app} state={state} onChange={() => setChanging(true)} />;
  return (
    <>
      {state?.server && (
        <section className="callout callout-good" aria-label="Texting">
          <Icon name="check" size={16} />
          <div className="grow">
            <div>Texts go out from the Quo number set up for this server</div>
            Nothing to do here. To text from your own Quo number instead, connect your Quo account below.
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
  const [apiKey, setApiKey] = useState("");
  const [show, setShow] = useState(false);
  const [numbers, setNumbers] = useState<QuoNumber[] | null>(null);
  const [picked, setPicked] = useState("");
  const [webhookKey, setWebhookKey] = useState("");
  const check = useMutation({
    meta: { inline: true },
    mutationFn: () => api.post<{ numbers: QuoNumber[] }>(`/apps/${app.id}/check`, { api_key: apiKey.trim() }),
    onSuccess: (res) => {
      setNumbers(res.numbers);
      setPicked(res.numbers[0]?.id ?? "");
    },
  });
  const save = useMutation({
    meta: { inline: true, success: "Quo connected" },
    mutationFn: () =>
      api.put(`/apps/${app.id}/account`, {
        api_key: apiKey.trim(),
        phone_number_id: picked,
        ...(webhookKey.trim() ? { webhook_key: webhookKey.trim() } : {}),
      }),
    onSuccess: () => {
      setApiKey("");
      setNumbers(null);
      onSaved();
    },
  });
  const editKey = (value: string) => {
    setApiKey(value);
    // A different key is a different workspace: its numbers have to be read again.
    setNumbers(null);
    setPicked("");
    check.reset();
    save.reset();
  };
  return (
    <Section className={kit.panel} id="app-setup" title={changing ? "Change your Quo account" : optional ? "Use your own Quo account" : "Connect your Quo account"}>
      <p className={kit.note}>
        About five minutes. Quo connects with an API key — there's no sign-in page to send you to, so here's exactly where the key lives. Quo bills you directly for the texts you
        send. In the US, your Quo workspace also needs its carrier registration done before API texts go out, which Quo walks you through.
      </p>
      <p className={kit.note}>{TEXT_CONSENT_HINT}</p>
      <Steps>
        <Step>
          <a className="btn btn-sm" href={QUO_APP} target="_blank" rel="noreferrer">Open Quo <Icon name="external" size={12} /></a>
          <p className={kit.note}>Sign in, then go to <strong>Workspace Settings → API</strong>. Only a workspace owner or admin sees that tab.</p>
        </Step>
        <Step>Click <strong>Generate API key</strong> and name it <strong>crewtavo</strong> (Quo doesn't allow spaces in key names). Copy the key — Quo shows it only once. Lost it? Generate another; the old one can be deleted there.</Step>
        <Step>Paste the key here and press <strong>Check this key</strong>. Crewtavo reads your Quo numbers back — at no cost, nothing is sent — and you pick the one texts go from.</Step>
      </Steps>
      <form
        className="stack-sm"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          if (numbers) save.mutate();
          else check.mutate();
        }}
      >
        <Field label="Quo API key" hint="Stored encrypted and never shown again." requiredMessage="Paste your Quo API key.">
          <div className="input-group">
            <input className="input" type={show ? "text" : "password"} value={apiKey} onChange={(e) => editKey(e.target.value)} autoComplete="off" spellCheck={false} maxLength={200} required style={{ paddingRight: 36 }} placeholder="Your key from Quo" />
            <button type="button" className="icon-btn addon-right" style={{ position: "absolute", right: 2, pointerEvents: "auto" }} aria-label={show ? "Hide key" : "Show key"} onClick={() => setShow(!show)}><Icon name={show ? "eye" : "lock"} size={14} /></button>
          </div>
        </Field>
        <FormError error={check.error} />
        {!numbers && (
          <div className="row wrap" style={{ gap: 8 }}>
            <Button type="submit" variant="primary" loading={check.isPending} disabled={!apiKey.trim()}>Check this key</Button>
            {onCancel && <Button onClick={onCancel}>Cancel</Button>}
          </div>
        )}
        {numbers && (
          <>
            <span className="app-status"><Icon name="check" size={16} />Quo accepted the key. {numbers.length === 1 ? "Your workspace has one number:" : `Your workspace has ${numbers.length} numbers:`}</span>
            <Field label="The number texts go from" requiredMessage="Pick the number texts go from.">
              <select className="select" value={picked} onChange={(e) => setPicked(e.target.value)} required>
                {numbers.map((n) => (
                  <option key={n.id} value={n.id}>{phoneDisplay(n.number)}{n.name ? ` — ${n.name}` : ""}</option>
                ))}
              </select>
            </Field>
            <Field label="Webhook signing key (you can add this later)" hint="From the webhook you'll make in Quo for replies, under ⋯ → Reveal signing secret. With it, Crewtavo checks that texts really came from Quo.">
              <input className="input" value={webhookKey} onChange={(e) => setWebhookKey(e.target.value)} autoComplete="off" spellCheck={false} maxLength={200} placeholder="Optional for now" />
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

function Connected({ app, state, onChange }: { app: AppRow; state: QuoState; onChange: () => void }) {
  return (
    <>
      <Section className={kit.panel} title="Quo account" action={<button type="button" onClick={onChange}><Icon name="edit" size={14} />Change account</button>}>
        {app.status === "error" && (
          <div className="callout callout-danger" role="alert">
            <Icon name="alert" size={16} />
            <div className="grow"><div>Quo isn't accepting this key anymore</div>{app.last_error}</div>
          </div>
        )}
        {app.status !== "error" && app.last_error && <span className="field-error">{app.last_error}</span>}
        <Facts>
          <Fact label="Connected to">{app.status !== "error" && (app.account_label ?? "Connected")}</Fact>
        </Facts>
        <p className={kit.note}>Reminders, on-my-way texts and the texts you send from Messages go out from this number.</p>
      </Section>
      <Section className={kit.panel} title="Replies from clients">
        <p className={kit.note}>
          For replies to land in Messages, Quo has to send incoming texts to this address. Quo can't be set from here — it takes a minute in Quo:
        </p>
        <CodeRow value={state.webhook_url} name="Address for incoming texts" done="Address copied" />
        <Steps>
          <Step>In Quo, open <strong>Settings → Webhooks</strong> and click <strong>Create webhook</strong>.</Step>
          <Step>Paste the address above, and choose the <strong>message.received</strong> event for your number.</Step>
          <Step>Open the webhook's details, click <strong>⋯ → Reveal signing secret</strong>, and keep that key under <strong>Change account</strong> here, so Crewtavo can check that the texts it receives were really sent by Quo.</Step>
        </Steps>
        {!state.reachable && (
          <div className="callout callout-warning" role="note">
            <Icon name="alert" size={16} />
            <div className="grow">Quo can only reach a public https address, and this Crewtavo doesn't have one yet. Texts still go out.</div>
          </div>
        )}
        <p className={kit.note}>Once it's set, texts to your number come into Messages, and STOP is honoured.</p>
      </Section>
    </>
  );
}
