/**
 * Assessments: what a site visit gathers beyond its notes and photos — measured rooms
 * (visit_measurements, written by the web app through its own client under the tables'
 * policies) and voice reports: a spoken walkthrough recorded on the visit, transcribed and
 * structured into work items by services/voiceReports.ts, and turned into a draft proposal
 * from here. The recording itself is uploaded to storage by the client first; these routes
 * take the path it landed at.
 */
import { SALES, STAFF } from "@crewtavo/core";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { requireCompany, requireUser } from "../lib/auth";
import { dbError, param, readJson } from "../lib/http";
import { adminClient } from "../lib/supabase";
import { convertVoiceReport, createVoiceReport } from "../services/voiceReports";

export const assessments = new Hono<AppEnv>();

const voiceReportSchema = z.object({
  path: z.string().trim().min(1).max(500),
  file_name: z.string().trim().min(1).max(300),
  content_type: z.string().trim().min(1).max(200),
  size_bytes: z.number().int().min(0).max(2_000_000_000),
});

/**
 * A recording made on the visit becomes its voice report. The whole field team records —
 * whoever walked the property is who talked — and the report comes back at whatever stage
 * it reached (ready, transcribed, needs_key, failed), with the reason on it when it stopped.
 */
assessments.post("/visits/:id/voice-reports", requireUser, requireCompany(STAFF), async (c) => {
  const visitId = param(c, "id");
  const body = await readJson(c, voiceReportSchema);
  const report = await createVoiceReport(c.env, c.var.db, adminClient(c.env), { companyId: c.var.companyId, userId: c.var.userId }, visitId, body);
  return c.json({ report });
});

/** The visit's voice reports, newest first. */
assessments.get("/visits/:id/voice-reports", requireUser, requireCompany(STAFF), async (c) => {
  const visitId = param(c, "id");
  const { data, error } = await c.var.db
    .from("visit_voice_reports")
    .select("*")
    .eq("company_id", c.var.companyId)
    .eq("visit_id", visitId)
    .order("created_at", { ascending: false });
  if (error) throw dbError(error);
  return c.json({ reports: data ?? [] });
});

/** Turn a report's items into a draft proposal for the visit's client (unpriced; the estimator prices it). */
assessments.post("/visits/:id/voice-reports/:reportId/convert", requireUser, requireCompany(SALES), async (c) => {
  const visitId = param(c, "id");
  const reportId = param(c, "reportId");
  return c.json(await convertVoiceReport(c.env, c.var.db, c.var.companyId, visitId, reportId));
});
