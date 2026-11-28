/**
 * A voice walkthrough of the visit: the crew taps Record, talks through what they see, and the
 * recording uploads right away (POST /visits/:id/voice-reports) to be turned into a transcript
 * and a list of work; a ready report can become a draft proposal in one tap. Recordings are NOT
 * kept on the phone — with no signal the section says so and recording is off, rather than
 * promising something it can't keep. The reports list is the API's: each one shows where it
 * stands in plain words, its items and transcript when they came out, or the problem as the
 * server told it when they didn't.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Button, Spinner } from "@/components/ui/Button";
import { FormError } from "@/components/ui/Field";
import { Section } from "@/components/ui/Section";
import { api } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import { uploadOnce } from "@/lib/files";
import { t } from "@/lib/i18n";
import { useSession } from "@/lib/session";
import { toast } from "@/lib/toast";
import { useSignal } from "./OfflineNote";
import { extensionForMime, formatClock, pickRecorderMime } from "./voiceRecorder";

interface VoiceItem { title: string; detail: string | null; quantity: number | null; unit: string | null }
interface VoiceReport {
  id: string;
  status: "recorded" | "needs_key" | "transcribed" | "ready" | "failed";
  problem: string | null;
  transcript: string | null;
  items: VoiceItem[] | null;
  quote_id: string | null;
}

export function VoiceWalkthrough({ visitId }: { visitId: string }) {
  const session = useSession();
  const queryClient = useQueryClient();
  const online = useSignal();
  const key = ["voice-reports", visitId];
  const reports = useQuery({
    queryKey: key,
    queryFn: async () => (await api.get<{ reports: VoiceReport[] }>(`/visits/${visitId}/voice-reports`)).reports,
  });

  const recorder = useRef<MediaRecorder | null>(null);
  const mic = useRef<MediaStream | null>(null);
  const chunks = useRef<Blob[]>([]);
  const startedAt = useRef(0);
  const discarded = useRef(false);
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [sending, setSending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  // Proposals made from here, by report id: the convert answer carries the number the list may not.
  const [made, setMade] = useState<Record<string, { id: string; number: number }>>({});

  const stopMic = () => {
    mic.current?.getTracks().forEach((track) => track.stop());
    mic.current = null;
  };

  // Leaving mid-recording drops it: nothing uploads from a screen that's gone.
  useEffect(
    () => () => {
      discarded.current = true;
      if (recorder.current && recorder.current.state !== "inactive") recorder.current.stop();
      stopMic();
    },
    [],
  );

  useEffect(() => {
    if (!recording) return;
    const timer = window.setInterval(() => setElapsed((Date.now() - startedAt.current) / 1000), 250);
    return () => window.clearInterval(timer);
  }, [recording]);

  const upload = async (blob: Blob, mime: string) => {
    setSending(true);
    try {
      const ext = extensionForMime(mime);
      const fileName = `voice-${crypto.randomUUID()}.${ext}`;
      const path = `${session.company.id}/visit/${visitId}/${fileName}`;
      await uploadOnce(path, blob);
      await api.post(`/visits/${visitId}/voice-reports`, { path, file_name: fileName, content_type: blob.type || mime || "audio/webm", size_bytes: blob.size });
      toast.success(t("Walkthrough sent"), { description: t("The office gets the transcript and the list of work from it.") });
      void queryClient.invalidateQueries({ queryKey: key });
    } catch (error) {
      setProblem(t("The recording couldn't be sent: {reason}", { reason: errorMessage(error) }));
    } finally {
      setSending(false);
    }
  };

  const start = async () => {
    setProblem(null);
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setProblem(t("This browser can't record audio here. Crewtavo needs a secure connection and a newer browser to record."));
      return;
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (error) {
      setProblem(
        error instanceof DOMException && error.name === "NotAllowedError"
          ? t("Crewtavo doesn't have permission to use the microphone. Allow microphone access for this site in your browser settings, then try again.")
          : t("The microphone couldn't be opened. It may be in use by another app — close that app and try again."),
      );
      return;
    }
    mic.current = stream;
    const mime = pickRecorderMime((m) => MediaRecorder.isTypeSupported(m));
    const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    chunks.current = [];
    discarded.current = false;
    rec.ondataavailable = (e) => {
      if (e.data.size) chunks.current.push(e.data);
    };
    rec.onstop = () => {
      stopMic();
      setRecording(false);
      if (discarded.current) return;
      const type = rec.mimeType || mime;
      const blob = new Blob(chunks.current, { type });
      chunks.current = [];
      if (blob.size) void upload(blob, type);
    };
    recorder.current = rec;
    startedAt.current = Date.now();
    setElapsed(0);
    rec.start();
    setRecording(true);
  };

  const convert = useMutation({
    mutationFn: async (reportId: string) => api.post<{ quote: { id: string; number: number } }>(`/visits/${visitId}/voice-reports/${reportId}/convert`),
    onSuccess: (data, reportId) => {
      setMade((all) => ({ ...all, [reportId]: data.quote }));
      void queryClient.invalidateQueries({ queryKey: key });
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  const list = reports.data ?? [];
  return (
    <Section title={t("Voice walkthrough")} count={list.length || undefined} className="visit-voice">
      {!online ? (
        <p className="field-hint">{t("Voice reports upload right away, so they need signal — recordings aren't kept on the phone yet.")}</p>
      ) : recording ? (
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <Button variant="danger" icon="square" onClick={() => recorder.current?.stop()}>{t("Stop")}</Button>
          <span className="tabular" role="timer" aria-label={t("Recording time")}>{formatClock(elapsed)}</span>
          <span className="field-hint">{t("Talk through the work: rooms, what's wrong, what it needs.")}</span>
        </div>
      ) : (
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <Button variant="primary" icon="waves" loading={sending} onClick={() => void start()}>{t("Record a walkthrough")}</Button>
          {sending && <span className="field-hint">{t("Sending the recording…")}</span>}
        </div>
      )}
      {problem && <p className="field-hint" role="alert">{problem}</p>}
      {reports.isPending ? (
        <p className="field-hint"><Spinner size={14} /> {t("Loading…")}</p>
      ) : reports.error ? (
        <FormError error={reports.error} />
      ) : (
        list.length > 0 && (
          <div style={{ display: "grid", gap: 14, marginTop: 12 }}>
            {list.map((report) => (
              <VoiceReportView key={report.id} report={report} made={made[report.id]} converting={convert.isPending && convert.variables === report.id} onConvert={() => convert.mutate(report.id)} />
            ))}
          </div>
        )
      )}
    </Section>
  );
}

/** One report as it stands: its items and transcript, the plain problem, or that it's on its way. */
function VoiceReportView({ report, made, converting, onConvert }: { report: VoiceReport; made?: { id: string; number: number }; converting: boolean; onConvert: () => void }) {
  const items = report.items ?? [];
  const proposal = made ?? (report.quote_id ? { id: report.quote_id, number: null } : null);
  return (
    <div>
      {report.status === "recorded" && <p className="field-hint">{t("Saved — being turned into text. Check back in a moment.")}</p>}
      {(report.status === "needs_key" || report.status === "failed") && <p className="field-hint" role="alert">{report.problem ?? t("Something went wrong with this recording.")}</p>}
      {report.status === "transcribed" && (
        <>
          <p className="field-hint">{t("We got the words, but couldn't pull a list of work out of this one.")}</p>
          {report.transcript && <Transcript text={report.transcript} />}
        </>
      )}
      {report.status === "ready" && (
        <>
          {items.length > 0 && (
            <ul className="rel" role="list">
              {items.map((item, i) => (
                <li key={i} className="rel-row">
                  <div className="rel-body">
                    <span className="rel-head"><span className="rel-title">{item.title}</span></span>
                    {(item.detail || item.quantity != null) && (
                      <span className="rel-sub">{[item.detail, item.quantity != null ? `${item.quantity}${item.unit ? ` ${item.unit}` : ""}` : null].filter(Boolean).join(" · ")}</span>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
          {report.transcript && <Transcript text={report.transcript} />}
        </>
      )}
      {proposal ? (
        <p style={{ marginTop: 8 }}>
          <Link to={`/quotes/${proposal.id}`}>{proposal.number != null ? t("Proposal #{number}", { number: proposal.number }) : t("Proposal")}</Link>
        </p>
      ) : (
        report.status === "ready" && items.length > 0 && (
          <div style={{ marginTop: 8 }}>
            <Button icon="quote" loading={converting} onClick={onConvert}>{t("Make a draft proposal")}</Button>
          </div>
        )
      )}
    </div>
  );
}

/** What was said, folded away until someone wants to read it. */
function Transcript({ text }: { text: string }) {
  return (
    <details style={{ marginTop: 6 }}>
      <summary>{t("Transcript")}</summary>
      <p className="pre-wrap" style={{ marginTop: 6 }}>{text}</p>
    </details>
  );
}
