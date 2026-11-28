/**
 * The AI Voice Agent on its app page: a Retell or Vapi agent that answers the calls to the
 * business's Quo number nobody picks up. Its state is its own (GET /api/apps/voice), not the Apps
 * list's: the form below saves the platform, its key (never read back — a blank field keeps the
 * saved one), the agent and the number calls forward to, the greeting and the FAQs it answers, and
 * whether it's live. Once connected, the wiring card carries what the platform side needs: the
 * webhook finished calls are posted to, the two tool addresses (check availability, book an
 * appointment) and the token and secret that guard them, each regenerable — which breaks the
 * platform side until the new value is pasted there, so it asks first. The agent setup file
 * (GET /api/apps/voice/agent-config) is the JSON to hand the agent at Retell or Vapi.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/Button";
import { confirm } from "@/components/ui/Confirm";
import { Field, FormChecks, FormError } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { Section } from "@/components/ui/Section";
import { StatusPill, type Tone } from "@/components/ui/StatusPill";
import { api } from "@/lib/api";
import { copyText } from "@/lib/clipboard";
import { useSession } from "@/lib/session";
import type { AppRow, VoiceFaq, VoiceState } from "./catalog";
import { CodeRow, SwitchLine, kit } from "./PanelKit";

type Platform = "retell" | "vapi";

const PLATFORM_NAMES: Record<Platform, string> = { retell: "Retell", vapi: "Vapi" };

/** Where the agent stands, in the panel's status line: nothing saved, saved but switched off, or live. */
export function voiceStatus(state: Pick<VoiceState, "connected" | "enabled" | "live"> | null | undefined): { label: string; tone: Tone } {
  if (!state?.connected) return { label: "Not set up", tone: "muted" };
  if (state.live) return { label: "Live", tone: "good" };
  return { label: "Saved but off", tone: "pending" };
}

export function VoiceAgentPanel({ onChanged }: { app: AppRow; onChanged: () => void }) {
  const session = useSession();
  const queryClient = useQueryClient();
  const state = useQuery({
    queryKey: ["voice-agent", session.company.id],
    queryFn: () => api.get<VoiceState>("/apps/voice"),
  });
  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["voice-agent", session.company.id] });
    onChanged();
  };
  if (state.isPending) return <Section className={kit.panel} title="AI Voice Agent"><p className={kit.note}>Loading…</p></Section>;
  if (state.error) {
    return (
      <Section className={kit.panel} title="AI Voice Agent">
        <FormError error={state.error} />
        <Button onClick={() => state.refetch()}>Try again</Button>
      </Section>
    );
  }
  // Keyed on the saved values, so a save (or a disconnect) starts the form from what the server kept.
  return <VoiceForm key={JSON.stringify(state.data)} initial={state.data!} onChanged={refresh} />;
}

function VoiceForm({ initial, onChanged }: { initial: VoiceState; onChanged: () => void }) {
  const [platform, setPlatform] = useState<Platform>(initial.platform ?? "retell");
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [agentId, setAgentId] = useState(initial.agent_id ?? "");
  const [phoneNumber, setPhoneNumber] = useState(initial.phone_number ?? "");
  const [formId, setFormId] = useState(initial.form_id ?? "");
  const [greeting, setGreeting] = useState(initial.greeting ?? "");
  const [faqs, setFaqs] = useState<VoiceFaq[]>(initial.faqs ?? []);
  const [enabled, setEnabled] = useState(initial.enabled);
  const status = voiceStatus(initial);

  const save = useMutation({
    meta: { inline: true, success: "AI Voice Agent saved" },
    mutationFn: () =>
      api.put<VoiceState>("/apps/voice/account", {
        platform,
        ...(apiKey.trim() ? { api_key: apiKey.trim() } : {}),
        agent_id: agentId.trim(),
        phone_number: phoneNumber.trim(),
        form_id: formId.trim() || null,
        enabled,
        greeting,
        // The API requires both halves of a question, so a half-filled row is left out rather than failing the whole save.
        faqs: faqs.filter((f) => f.question.trim() && f.answer.trim()),
      }),
    onSuccess: () => {
      setApiKey("");
      onChanged();
    },
  });
  const disconnect = useMutation({
    meta: { inline: true, success: "AI Voice Agent disconnected" },
    mutationFn: () => api.delete("/apps/voice/account"),
    onSuccess: onChanged,
  });
  const askDisconnect = async () => {
    if (await confirm({ title: "Disconnect the AI Voice Agent?", body: "Its key, tool token and webhook secret are removed from Crewtavo, and forwarded calls stop being answered until you connect it again. Calls already recorded stay in AI Calls.", confirmLabel: "Disconnect", danger: true })) disconnect.mutate();
  };

  const setFaq = (i: number, patch: Partial<VoiceFaq>) => setFaqs((rows) => rows.map((row, j) => (j === i ? { ...row, ...patch } : row)));

  return (
    <>
      <Section className={kit.panel} id="app-setup" title="Voice agent">
        <p><StatusPill label={status.label} tone={status.tone} /></p>
        <p className={kit.note}>
          When a call to your Quo number goes unanswered, it forwards to your AI agent's number. The agent can book a free estimate on your real calendar or take a message.
          Calls, transcripts and outcomes land in <Link to="/ai-calls">AI Calls</Link>.
        </p>
        <form
          className="stack-sm"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            save.mutate();
          }}
        >
          <Field label="Platform">
            <select className="select" value={platform} onChange={(e) => setPlatform(e.target.value as Platform)}>
              <option value="retell">Retell</option>
              <option value="vapi">Vapi</option>
            </select>
          </Field>
          <Field label={`${PLATFORM_NAMES[platform]} API key`} hint="Stored encrypted and never shown again.">
            <div className="input-group">
              <input
                className="input"
                type={showKey ? "text" : "password"}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                autoComplete="off"
                spellCheck={false}
                maxLength={300}
                style={{ paddingRight: 36 }}
                placeholder={initial.has_api_key ? "Saved — paste a new one to replace" : `Your key from ${PLATFORM_NAMES[platform]}`}
              />
              <button type="button" className="icon-btn addon-right" style={{ position: "absolute", right: 2, pointerEvents: "auto" }} aria-label={showKey ? "Hide key" : "Show key"} onClick={() => setShowKey(!showKey)}><Icon name={showKey ? "eye" : "lock"} size={14} /></button>
            </div>
          </Field>
          <Field label="Agent ID" hint={`The agent you made in ${PLATFORM_NAMES[platform]} — the setup file below has what to give it.`}>
            <input className="input" value={agentId} onChange={(e) => setAgentId(e.target.value)} autoComplete="off" spellCheck={false} maxLength={200} placeholder="The agent's ID" />
          </Field>
          <Field label="Phone number" hint="The number the platform gave the agent — the one unanswered Quo calls forward to.">
            <input className="input" value={phoneNumber} onChange={(e) => setPhoneNumber(e.target.value)} autoComplete="tel" spellCheck={false} maxLength={40} placeholder="+1 555 000 0000" />
          </Field>
          <Field label="Booking form ID (optional)" hint="Which booking form the agent books estimates through, when you have more than one.">
            <input className="input" value={formId} onChange={(e) => setFormId(e.target.value)} autoComplete="off" spellCheck={false} maxLength={200} placeholder="Optional" />
          </Field>
          <Field label="Greeting" hint="The first thing the agent says when it picks up.">
            <textarea className="input" rows={3} value={greeting} onChange={(e) => setGreeting(e.target.value)} maxLength={1000} placeholder="Thanks for calling — how can I help?" />
          </Field>
          <div className="stack-sm">
            <span className="field-label">Questions it can answer</span>
            {faqs.map((faq, i) => (
              <div key={i} className="stack-sm" style={{ borderTop: "1px solid var(--border, #e5e5e5)", paddingTop: 8 }}>
                <Field label={`Question ${i + 1}`}>
                  <input className="input" value={faq.question} onChange={(e) => setFaq(i, { question: e.target.value })} maxLength={300} placeholder="What areas do you serve?" />
                </Field>
                <Field label="Answer">
                  <textarea className="input" rows={2} value={faq.answer} onChange={(e) => setFaq(i, { answer: e.target.value })} maxLength={1000} placeholder="We serve…" />
                </Field>
                <div>
                  <Button size="sm" icon="trash" onClick={() => setFaqs((rows) => rows.filter((_, j) => j !== i))}>Remove question</Button>
                </div>
              </div>
            ))}
            <div>
              <Button size="sm" icon="plus" onClick={() => setFaqs((rows) => [...rows, { question: "", answer: "" }])}>Add a question</Button>
            </div>
          </div>
          <SwitchLine label="Agent is on" hint="When it's on and connected, forwarded calls are answered. Off keeps everything saved." checked={enabled} onChange={setEnabled} />
          <FormError error={save.error} />
          <FormError error={disconnect.error} />
          <div className="row wrap" style={{ gap: 8 }}>
            <FormChecks />
            <Button type="submit" variant="primary" loading={save.isPending}>Save</Button>
            {initial.connected && <Button variant="danger" loading={disconnect.isPending} onClick={askDisconnect}>Disconnect</Button>}
          </div>
        </form>
        <p className={kit.note}><Link to="/ai-calls">See AI-handled calls →</Link></p>
      </Section>
      {initial.connected && <WiringCard state={initial} platform={platform} onChanged={onChanged} />}
      {initial.connected && <AgentConfigCard />}
    </>
  );
}

/** The addresses and secrets the platform side is wired with, once there's an account to wire. */
function WiringCard({ state, platform, onChanged }: { state: VoiceState; platform: Platform; onChanged: () => void }) {
  const regenerate = useMutation({
    meta: { inline: true, success: "New value saved — paste it into your platform" },
    mutationFn: (which: "tool_token" | "webhook_secret") => api.post<VoiceState>("/apps/voice/regenerate", { which }),
    onSuccess: onChanged,
  });
  const askRegenerate = async (which: "tool_token" | "webhook_secret") => {
    const what = which === "tool_token" ? "tool token" : "webhook secret";
    if (await confirm({ title: `Make a new ${what}?`, body: `The old ${what} stops working right away, so the agent can't ${which === "tool_token" ? "check times or book" : "send finished calls here"} until the new one is pasted into ${PLATFORM_NAMES[platform]}.`, confirmLabel: "Make a new one", danger: true })) regenerate.mutate(which);
  };
  return (
    <Section className={kit.panel} title="Wiring">
      <p className={kit.note}>What {PLATFORM_NAMES[platform]} needs, so finished calls come back here and the agent can use your calendar:</p>
      <span className="field-label">Webhook — finished calls are posted here</span>
      <CodeRow value={state.webhook_urls[platform]} name="Webhook address" done="Webhook address copied" />
      <span className="field-label">Tools the agent can call</span>
      <CodeRow label="Check availability" value={state.tool_urls.check_availability} name="Check availability address" done="Address copied" />
      <CodeRow label="Book appointment" value={state.tool_urls.book_appointment} name="Book appointment address" done="Address copied" />
      {state.tool_token && (
        <>
          <span className="field-label">Tool token — the agent sends this with each tool call</span>
          <CodeRow value={state.tool_token} name="Tool token" done="Tool token copied" />
          <div><Button size="sm" icon="refresh" loading={regenerate.isPending && regenerate.variables === "tool_token"} onClick={() => askRegenerate("tool_token")}>Regenerate tool token</Button></div>
        </>
      )}
      {state.webhook_secret && (
        <>
          <span className="field-label">Webhook secret — checks that calls really came from {PLATFORM_NAMES[platform]}</span>
          <CodeRow value={state.webhook_secret} name="Webhook secret" done="Webhook secret copied" />
          <div><Button size="sm" icon="refresh" loading={regenerate.isPending && regenerate.variables === "webhook_secret"} onClick={() => askRegenerate("webhook_secret")}>Regenerate webhook secret</Button></div>
        </>
      )}
      <FormError error={regenerate.error} />
    </Section>
  );
}

/** The JSON to hand the agent at Retell or Vapi: fetched on request, shown, copied or downloaded. */
function AgentConfigCard() {
  const [config, setConfig] = useState<string | null>(null);
  const fetchConfig = useMutation({
    meta: { inline: true },
    mutationFn: () => api.get<Record<string, unknown>>("/apps/voice/agent-config"),
    onSuccess: (res) => setConfig(JSON.stringify(res, null, 2)),
  });
  const download = () => {
    if (!config) return;
    const url = URL.createObjectURL(new Blob([config], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "voice-agent-setup.json";
    a.click();
    URL.revokeObjectURL(url);
  };
  return (
    <Section className={kit.panel} title="Agent setup file">
      <p className={kit.note}>
        Everything the agent at Retell or Vapi needs — its greeting, instructions, your questions and answers, and the tools above — as one file, made from what you've saved here.
        Save changes above first, then get a fresh copy.
      </p>
      <div className="row wrap" style={{ gap: 8 }}>
        <Button icon="download" loading={fetchConfig.isPending} onClick={() => fetchConfig.mutate()}>Get the agent setup file</Button>
        {config && (
          <>
            <Button size="sm" icon="copy" onClick={() => copyText(config, "Setup file copied")}>Copy</Button>
            <Button size="sm" icon="download" onClick={download}>Download (.json)</Button>
          </>
        )}
      </div>
      <FormError error={fetchConfig.error} />
      {config && <pre style={{ maxHeight: 320, overflow: "auto", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{config}</pre>}
    </Section>
  );
}
