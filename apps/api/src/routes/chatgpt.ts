/**
 * Crewtavo's own AI, where it's set up (Apps → Claude and Apps → ChatGPT; services/ai.ts decides
 * which service answers each ask):
 *
 *   PUT  /ai/service            a company with both a Claude key and an OpenAI key chooses which
 *                               one Crewtavo's AI uses.
 *   PUT  /apps/chatgpt/model    the model the company's OpenAI key uses, among the ones OpenAI
 *                               lists for it.
 *   POST /apps/chatgpt/models   asks OpenAI for that list again.
 *
 * The OpenAI key itself is saved, checked first, by PUT /apps/chatgpt/key (routes/apps.ts).
 */
import { ADMINS } from "@crewtavo/core";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { checkOpenAiKey, pickModel } from "../integrations/openai";
import { loadSecret } from "../integrations/tokens";
import { requireCompany, requireUser } from "../lib/auth";
import { asJson, dbError, HttpError, readJson } from "../lib/http";
import { adminClient } from "../lib/supabase";
import { companyAi, type OpenAiSettings } from "../services/ai";

export const chatgpt = new Hono<AppEnv>();

/**
 * Which of the company's two keys Crewtavo's AI uses. Only a choice between keys that are there:
 * with one key, that one is used whatever was chosen before.
 */
chatgpt.put("/ai/service", requireUser, requireCompany(ADMINS, "apps"), async (c) => {
  const body = await readJson(c, z.object({ service: z.enum(["claude", "chatgpt"]) }));
  const admin = adminClient(c.env);
  const [claude, openai] = await Promise.all([loadSecret(c.env, admin, c.var.companyId, "anthropic").catch(() => null), loadSecret(c.env, admin, c.var.companyId, "chatgpt").catch(() => null)]);
  if (!(body.service === "claude" ? claude : openai)?.api_key) {
    throw new HttpError(400, body.service === "claude" ? "Add a Claude key under Apps → Claude first." : "Add an OpenAI key under Apps → ChatGPT first.");
  }
  // As the owner or admin, so the database checks who may change the company's settings.
  const { error } = await c.var.db.rpc("merge_company_settings", { p_company: c.var.companyId, p_settings: { ai: { service: body.service } } });
  if (error) throw dbError(error);
  return c.json({ service: (await companyAi(c.env, admin, c.var.companyId))?.service ?? null });
});

/** The company's OpenAI key and what's kept beside it, or a refusal when there's no key. */
async function openAiKey(c: { env: AppEnv["Bindings"]; var: { companyId: string } }) {
  const admin = adminClient(c.env);
  const secret = await loadSecret(c.env, admin, c.var.companyId, "chatgpt").catch(() => null);
  if (!secret?.api_key) throw new HttpError(409, "Add an OpenAI key first.");
  const { data, error } = await admin.from("integrations").select("settings").eq("company_id", c.var.companyId).eq("provider", "chatgpt").maybeSingle();
  if (error) throw dbError(error);
  return { admin, apiKey: secret.api_key, settings: (data?.settings ?? {}) as OpenAiSettings };
}

chatgpt.put("/apps/chatgpt/model", requireUser, requireCompany(ADMINS, "apps"), async (c) => {
  const body = await readJson(c, z.object({ model: z.string().trim().min(1).max(200) }));
  if (c.env.OPENAI_MODEL) throw new HttpError(409, `This server is set to use ${c.env.OPENAI_MODEL} (OPENAI_MODEL), so the model can't be changed here.`);
  const { admin, settings } = await openAiKey(c);
  if (!(settings.models ?? []).some((m) => m.slug === body.model)) throw new HttpError(400, "OpenAI doesn't list that model for your key. Check for new models, then pick one.");
  const { error } = await admin.from("integrations").update({ settings: asJson({ ...settings, model: body.model }) }).eq("company_id", c.var.companyId).eq("provider", "chatgpt");
  if (error) throw dbError(error);
  return c.json({ model: body.model });
});

/** Check for new models: the list is OpenAI's own for the key, read again (which costs nothing). */
chatgpt.post("/apps/chatgpt/models", requireUser, requireCompany(ADMINS, "apps"), async (c) => {
  const { admin, apiKey, settings } = await openAiKey(c);
  const checked = await checkOpenAiKey(apiKey);
  if ("problem" in checked) throw new HttpError(502, checked.problem);
  const model = pickModel(c.env, checked.models, settings.model);
  const { error } = await admin.from("integrations").update({ settings: asJson({ ...settings, model: c.env.OPENAI_MODEL ? (settings.model ?? null) : model, models: checked.models }) }).eq("company_id", c.var.companyId).eq("provider", "chatgpt");
  if (error) throw dbError(error);
  return c.json({ model, models: checked.models, model_locked: Boolean(c.env.OPENAI_MODEL) });
});
