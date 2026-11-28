/**
 * AI Calls: every call the AI voice agent handled (GET /api/voice/calls), newest first, with what
 * came of it. A row opens its call beside the list: the summary, what the agent pulled from the
 * caller (name, phone, service, preferred time, message), the recording and the transcript, and
 * the request and visit it made when it booked. With no calls yet and no agent connected, the
 * empty state says where setup lives instead — Apps → AI Voice Agent.
 */
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";
import { Icon } from "@/components/ui/Icon";
import { PageHeader, useDocumentTitle } from "@/components/ui/PageHeader";
import { Fact, Facts, RelatedList, RelatedRow, Section } from "@/components/ui/Section";
import { Loading, SkeletonText } from "@/components/ui/Skeleton";
import { EmptyState, ErrorState } from "@/components/ui/States";
import { StatusPill } from "@/components/ui/StatusPill";
import { FilterTabs } from "@/components/ui/Toolbar";
import { api } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import { useSession } from "@/lib/session";
import type { VoiceState } from "../apps/catalog";
import { durationLabel, extractedRows, OUTCOME_FILTERS, outcomeTone, type AiCallDetail, type AiCallRow, type OutcomeFilterKey } from "./aiCalls";

const PAGE_SIZE = 50;

export function AiCallsPage() {
  useDocumentTitle("AI Calls");
  const session = useSession();
  const [filter, setFilter] = useState<OutcomeFilterKey>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const param = OUTCOME_FILTERS.find((f) => f.key === filter)?.param;

  const calls = useQuery({
    queryKey: ["voice-calls", session.company.id, filter],
    placeholderData: keepPreviousData,
    queryFn: () => api.get<{ calls: AiCallRow[]; total: number }>(`/voice/calls?limit=${PAGE_SIZE}&offset=0${param ? `&outcome=${encodeURIComponent(param)}` : ""}`),
  });
  // Only for the empty state: whether an agent is connected at all. A failure here (an admin-only
  // route, say) just leaves the plain empty state.
  const voice = useQuery({
    queryKey: ["voice-agent", session.company.id],
    queryFn: () => api.get<VoiceState>("/apps/voice"),
    retry: false,
  });
  const rows = calls.data?.calls ?? [];
  const notConnected = voice.data ? !voice.data.connected : false;

  return (
    <>
      <PageHeader title="AI Calls" lede="Calls your AI voice agent answered — what it booked, the messages it took, and what callers asked." />
      <FilterTabs label="Filter calls by outcome" value={filter} onChange={(key) => { setFilter(key); setSelectedId(null); }} options={OUTCOME_FILTERS.map((f) => ({ value: f.key, label: f.label }))} />
      {calls.isPending && <Loading label="Loading calls"><SkeletonText lines={4} /></Loading>}
      {calls.error && <ErrorState error={calls.error} onRetry={() => calls.refetch()} />}
      {calls.data && rows.length === 0 && (
        notConnected ? (
          <EmptyState icon="phone" title="No AI-handled calls yet" action={<Link className="btn btn-primary" to="/apps/voice">Set up the AI Voice Agent</Link>}>
            Nothing has been forwarded to an agent yet. Setup lives in Apps → AI Voice Agent: connect Retell or Vapi there, and the calls it answers will land here.
          </EmptyState>
        ) : (
          <EmptyState icon="phone" title="No AI-handled calls yet">
            {filter === "all" ? "When your agent answers a forwarded call, it shows here with its summary and outcome." : "No calls with this outcome yet."}
          </EmptyState>
        )
      )}
      {rows.length > 0 && (
        <div className="stack" style={{ gap: 16 }}>
          <RelatedList label="AI-handled calls">
            {rows.map((call) => (
              <RelatedRow
                key={call.id}
                onClick={() => setSelectedId(selectedId === call.id ? null : call.id)}
                current={selectedId === call.id}
                lead={<span className="rel-icon" data-tone={call.booked || call.visitId ? "good" : undefined}><Icon name="phone" size={15} /></span>}
                title={<>{call.callerLabel} {(call.booked || call.visitId) && <StatusPill label="Booked" tone="good" />}</>}
                sub={call.summary ? <span style={{ display: "-webkit-box", WebkitLineClamp: 1, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{call.summary}</span> : undefined}
                end={<span className="stack-sm" style={{ textAlign: "right" }}><span>{call.when}</span>{call.durationLabel && <span className="muted small">{call.durationLabel}</span>}<StatusPill label={call.outcomeLabel} tone={outcomeTone(call.outcome)} /></span>}
              />
            ))}
          </RelatedList>
          {selectedId && <CallDetail key={selectedId} id={selectedId} />}
        </div>
      )}
    </>
  );
}

/** One call in full, under the list: summary, extracted details, recording, transcript, and its links. */
function CallDetail({ id }: { id: string }) {
  const detail = useQuery({
    queryKey: ["voice-call", id],
    queryFn: () => api.get<AiCallDetail>(`/voice/calls/${id}`),
  });
  if (detail.isPending) return <Section title="Call"><Loading label="Loading call"><SkeletonText lines={4} /></Loading></Section>;
  if (detail.error) return <Section title="Call"><ErrorState compact error={detail.error} onRetry={() => detail.refetch()} /></Section>;
  const call = detail.data!;
  const rows = extractedRows(call.extracted);
  const title = call.caller_name || call.caller_phone || "Call";
  return (
    <Section title={title}>
      <Facts>
        <Fact label="When">{call.started_at ? formatDateTime(call.started_at) : null}</Fact>
        <Fact label="Caller">{call.caller_phone}</Fact>
        <Fact label="Called">{call.called_number}</Fact>
        <Fact label="Length">{durationLabel(call.duration_seconds)}</Fact>
        <Fact label="Outcome">{call.outcome}</Fact>
        <Fact label="Request">{call.request_number}</Fact>
        <Fact label="Visit">{call.visit_starts_at ? formatDateTime(call.visit_starts_at) : null}</Fact>
      </Facts>
      {call.summary && <p>{call.summary}</p>}
      {rows.length > 0 && (
        <Facts label="What the agent took down">
          {rows.map((row) => <Fact key={row.label} label={row.label}>{row.value}</Fact>)}
        </Facts>
      )}
      <div className="row wrap" style={{ gap: 8 }}>
        {call.request_id && <Link className="btn" to={`/requests/${call.request_id}`}><Icon name="requests" size={14} />Open request</Link>}
        {call.visit_id && <Link className="btn" to={`/schedule?visit=${call.visit_id}`}><Icon name="calendar" size={14} />Open visit</Link>}
        {call.recording_url && <a className="btn" href={call.recording_url} target="_blank" rel="noreferrer"><Icon name="play" size={14} />Recording</a>}
      </div>
      {call.transcript && (
        <>
          <h3>Transcript</h3>
          <pre style={{ maxHeight: 320, overflow: "auto", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{call.transcript}</pre>
        </>
      )}
    </Section>
  );
}
