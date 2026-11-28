/**
 * Voice reports: an estimator walks a property talking, and the visit gets a report — the
 * recording kept on the visit (an attachments row, like its photos), the words in it, and the
 * work items those words describe, ready to become a draft proposal.
 *
 * The words come from OpenAI's transcription, which needs the company's own OpenAI key
 * (Apps → ChatGPT): Claude has no audio endpoint (integrations/transcribe.ts). With no key
 * the report stops at `needs_key` and says so in plain words — the recording is never lost
 * over a missing key. The structuring after that goes through services/ai.ts like every other
 * ask; if it fails, the report stays `transcribed`, because the transcript is the value and
 * the items can be read out of it by a person.
 */
import type { Database } from "@crewtavo/core/database";
import type { Env } from "../env";
import { OpenAiProblem } from "../integrations/openai";
import { loadSecret } from "../integrations/tokens";
import { transcribeAudio } from "../integrations/transcribe";
import { asJson, dbError, HttpError, must } from "../lib/http";
import type { Db } from "../lib/supabase";
import { complete, countAiAsk, type Asker } from "./ai";

/** One work item in a report: what the estimator said needs doing, in proposal-line shape. */
export interface VoiceReportItem {
  title: string;
  detail: string;
  quantity: number;
  unit: string;
}

/** The most items one walkthrough can become; a longer list is a transcript to read, not lines. */
const MAX_ITEMS = 50;

/**
 * The work items in the AI's answer, read defensively: the answer should be only a JSON array
 * of {"title","detail","quantity","unit"}, but a model that wraps it in code fences, or adds
 * words around it, still yields its items. Anything that isn't an array of objects with a
 * title in it gives nothing back — a bad structure must never invent work. Quantities and
 * units are the estimator's, spoken: an item that doesn't carry them is one each.
 */
export function parseReportItems(text: string): VoiceReportItem[] {
  const fenced = text.replace(/```(?:json)?/gi, "");
  const start = fenced.indexOf("[");
  const end = fenced.lastIndexOf("]");
  if (start < 0 || end <= start) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(fenced.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const items: VoiceReportItem[] = [];
  for (const raw of parsed) {
    if (!raw || typeof raw !== "object") continue;
    const row = raw as Record<string, unknown>;
    const title = typeof row.title === "string" ? row.title.trim() : "";
    if (!title) continue;
    const quantity = typeof row.quantity === "number" && Number.isFinite(row.quantity) && row.quantity > 0 ? row.quantity : 1;
    items.push({
      title: title.slice(0, 300),
      detail: typeof row.detail === "string" ? row.detail.trim().slice(0, 1000) : "",
      quantity,
      unit: typeof row.unit === "string" && row.unit.trim() ? row.unit.trim().slice(0, 40) : "ea",
    });
    if (items.length >= MAX_ITEMS) break;
  }
  return items;
}

/** Why a transcription stopped, in words the person who recorded it can act on. */
function transcribeProblem(problem: OpenAiProblem): string {
  if (problem.kind === "key") return "The OpenAI key under Apps → ChatGPT didn't work, so the recording couldn't be transcribed. Check that it was copied correctly, then record again — the recording is saved on the visit.";
  if (problem.kind === "usage_limit") return "The OpenAI account under Apps → ChatGPT is out of credit or at its spending limit, so the recording couldn't be transcribed. Add credit at platform.openai.com, then record again — the recording is saved on the visit.";
  if (problem.kind === "timeout") return "Transcribing the recording took too long, so it wasn't turned into words. Try recording again — the recording is saved on the visit.";
  return "The recording couldn't be transcribed. Try recording again — the recording is saved on the visit.";
}

const NO_KEY_PROBLEM = "Voice reports need the company's OpenAI key: an admin can add it under Apps → ChatGPT. The recording is saved on the visit.";

type ReportRow = Database["public"]["Tables"]["visit_voice_reports"]["Row"];
type ReportUpdate = Database["public"]["Tables"]["visit_voice_reports"]["Update"];

/** Save a change to a report and hand back the row as it now stands. */
async function saveReport(db: Db, companyId: string, reportId: string, change: ReportUpdate): Promise<ReportRow> {
  const { error } = await db.from("visit_voice_reports").update(change).eq("company_id", companyId).eq("id", reportId);
  if (error) throw dbError(error);
  return must(await db.from("visit_voice_reports").select("*").eq("company_id", companyId).eq("id", reportId).maybeSingle(), "Voice report not found.");
}

/**
 * A recording made on a visit becomes its voice report: the recording is filed on the visit,
 * then transcribed and structured as far as the company's keys allow. Only a visit that
 * isn't there, or a recording filed somewhere it doesn't belong, is an error — every other
 * stopping point is written on the report itself (its status and problem) and the report is
 * returned, because the recording is saved either way and the person holding the phone
 * needs to see where it stands, not an error page.
 */
export async function createVoiceReport(
  env: Env,
  db: Db,
  admin: Db,
  asker: Asker & { userId: string },
  visitId: string,
  body: { path: string; file_name: string; content_type: string; size_bytes: number },
): Promise<ReportRow> {
  const { companyId, userId } = asker;
  const visit = await db.from("visits").select("id").eq("company_id", companyId).eq("id", visitId).maybeSingle();
  if (visit.error) throw dbError(visit.error);
  if (!visit.data) throw new HttpError(404, "Visit not found.");
  if (!body.path.startsWith(`${companyId}/visit/${visitId}/`)) {
    throw new HttpError(400, "That recording wasn't filed under this visit. Record it again from the visit.");
  }

  // The recording lives on the visit like its photos do.
  const attachment = await db
    .from("attachments")
    .insert({ company_id: companyId, owner_type: "visit", owner_id: visitId, path: body.path, file_name: body.file_name, content_type: body.content_type, size_bytes: body.size_bytes, created_by: userId })
    .select("id")
    .single();
  if (attachment.error) throw dbError(attachment.error);

  const inserted = await db
    .from("visit_voice_reports")
    .insert({ company_id: companyId, visit_id: visitId, audio_path: body.path, status: "recorded", created_by: userId })
    .select("*")
    .single();
  if (inserted.error) throw dbError(inserted.error);
  let report: ReportRow = inserted.data;

  const secret = await loadSecret(env, admin, companyId, "chatgpt").catch(() => null);
  const apiKey = secret?.api_key ?? null;
  if (!apiKey) {
    return saveReport(db, companyId, report.id, { status: "needs_key", problem: NO_KEY_PROBLEM });
  }

  const download = await admin.storage.from("files").download(body.path);
  if (download.error || !download.data) {
    return saveReport(db, companyId, report.id, { status: "failed", problem: "The recording couldn't be read back, so it wasn't transcribed. Try recording again — the recording is saved on the visit." });
  }
  const data = await download.data.arrayBuffer();

  let transcript: string;
  try {
    transcript = await transcribeAudio(apiKey, { data, contentType: body.content_type, fileName: body.file_name });
  } catch (error) {
    if (error instanceof OpenAiProblem) return saveReport(db, companyId, report.id, { status: "failed", problem: transcribeProblem(error) });
    throw error;
  }
  report = await saveReport(db, companyId, report.id, { status: "transcribed", transcript, problem: null });

  // The words into work items. A failure here costs nothing: the report keeps its transcript.
  try {
    await countAiAsk(env, companyId, userId);
    const answer = await complete(env, {
      asker: { companyId, userId },
      system:
        "You turn an estimator's spoken site-visit walkthrough into the work items of a proposal. " +
        "Answer with ONLY a JSON array — no prose, no code fences — of objects with \"title\" (the work, in a few words), " +
        "\"detail\" (what the estimator said about it), \"quantity\" and \"unit\". Give a quantity and unit only when the " +
        "estimator spoke them (\"twelve feet of trim\" is quantity 12, unit \"ft\"); otherwise quantity 1 and unit \"ea\". " +
        "Include only work the estimator actually described.",
      prompt: `The estimator's walkthrough, as transcribed:\n\n${transcript}`,
      maxTokens: 4000,
    });
    const items = parseReportItems(answer);
    if (items.length) report = await saveReport(db, companyId, report.id, { status: "ready", items: asJson(items) });
  } catch {
    // The transcript stands on its own; the items can be structured again later.
  }
  return report;
}

/**
 * Turn a report's items into a draft proposal for the visit's client, priced at zero — the
 * estimator prices it, the report only names the work. A report already converted gives its
 * proposal back rather than making a second one.
 */
export async function convertVoiceReport(env: Env, db: Db, companyId: string, visitId: string, reportId: string): Promise<{ quote: { id: string; number: number | null } }> {
  void env;
  const report: ReportRow = must(
    await db.from("visit_voice_reports").select("*").eq("company_id", companyId).eq("visit_id", visitId).eq("id", reportId).maybeSingle(),
    "Voice report not found.",
  );
  if (report.quote_id) {
    const existing = must(await db.from("quotes").select("id, number").eq("company_id", companyId).eq("id", report.quote_id).maybeSingle(), "Proposal not found.");
    return { quote: { id: existing.id, number: existing.number } };
  }

  const visit = must(
    await db
      .from("visits")
      .select("id, title, request_id, job:jobs(client_id, property_id), request:requests(client_id, property_id, title)")
      .eq("company_id", companyId)
      .eq("id", visitId)
      .maybeSingle(),
    "Visit not found.",
  ) as unknown as {
    title: string;
    request_id: string | null;
    job: { client_id: string; property_id: string | null } | null;
    request: { client_id: string; property_id: string | null; title: string } | null;
  };
  const fromJob = visit.job ?? null;
  const clientId = fromJob?.client_id ?? visit.request?.client_id ?? null;
  if (!clientId) throw new HttpError(422, "This visit isn't tied to a client yet, so there's nobody to make a proposal for.");
  const propertyId = fromJob?.property_id ?? visit.request?.property_id ?? null;

  const quote = await db
    .from("quotes")
    .insert({
      company_id: companyId,
      client_id: clientId,
      property_id: propertyId,
      // The proposal remembers the request it came from, when the visit was for one.
      request_id: fromJob ? null : visit.request_id,
      title: visit.title || "Site visit proposal",
      status: "draft",
    })
    .select("id, number")
    .single();
  if (quote.error) throw dbError(quote.error);

  const items = parseReportItems(JSON.stringify(Array.isArray(report.items) ? report.items : []));
  if (items.length) {
    const lines = items.map((item, index) => ({
      company_id: companyId,
      quote_id: quote.data.id,
      name: item.title,
      description: item.detail || null,
      quantity: item.quantity,
      unit: item.unit,
      unit_price: 0,
      sort: index,
    }));
    const { error } = await db.from("quote_line_items").insert(lines);
    if (error) throw dbError(error);
  }

  const { error } = await db.from("visit_voice_reports").update({ quote_id: quote.data.id }).eq("company_id", companyId).eq("id", reportId);
  if (error) throw dbError(error);
  const saved = must(await db.from("quotes").select("id, number").eq("company_id", companyId).eq("id", quote.data.id).maybeSingle(), "Proposal not found.");
  return { quote: { id: saved.id, number: saved.number } };
}
