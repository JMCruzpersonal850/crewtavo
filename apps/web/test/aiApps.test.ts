/**
 * Claude and ChatGPT under Apps are what powers Crewtavo's own AI (a key, or for ChatGPT a person's
 * own plan). Using Crewtavo from inside either chat app is the connector, which is added and
 * managed in Settings → AI assistants and nowhere else: the app pages only point there.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { companyFeatures } from "../src/lib/api";
import { APP_INFO, type AppRow } from "../src/features/apps/catalog";
import { isInstalled } from "../src/features/apps/installed";

const source = (path: string) => readFileSync(fileURLToPath(new URL(`../src/${path}`, import.meta.url)), "utf8");
const app = (more: Partial<AppRow>) => ({ id: "chatgpt", auth: "api_key", status: "disconnected", ...more }) as AppRow;

describe("the Claude and ChatGPT apps", () => {
  it.each(["anthropic", "chatgpt"])("%s is about Crewtavo's own AI, and points to Settings for the connector", (id) => {
    const info = APP_INFO[id]!;
    expect(info.about).toContain("add the connector in Settings → AI assistants");
    expect(info.connectsWith).not.toMatch(/connector/i);
    // What goes to the AI service and what doesn't, as the other AI app (fal.ai) says it.
    expect(info.access[0]).toMatch(/^Send (Anthropic|OpenAI) what an ask is about/);
    expect(info.access).toContain("Nothing else: it can't look things up in Crewtavo or change anything");
    // Nothing left that says it reads clients or changes the price list: that was the connector.
    expect(JSON.stringify(info)).not.toMatch(/Search clients|once you allow it|full access/);
  });

  it("ChatGPT says both ways to pay, and whose asks a plan covers", () => {
    const info = APP_INFO.chatgpt!;
    expect(info.access).toContain("With an API key, OpenAI bills your API account directly for what's used");
    expect(info.access.some((line) => line.startsWith("With Continue with ChatGPT, your own ChatGPT plan pays for what you ask yourself"))).toBe(true);
    expect(info.about).toContain("ChatGPT Plus or Pro plan");
    expect(info.about).toContain("never anyone else's asks");
  });

  it("have no connector link on their pages: that's in Settings alone", () => {
    const page = source("features/apps/AppDetailPage.tsx");
    expect(page).not.toMatch(/ConnectorCard|mcp_url|mcpUrl|CONNECTOR_STEPS|Connector link copied/);
    expect(page).toContain('To use Crewtavo from inside {app.name}, add the connector in <Link to="/settings?tab=assistants">Settings → AI assistants</Link>.');
    const settings = source("features/settings/AssistantSettings.tsx");
    expect(settings).toContain("Connector link copied");
    expect(settings).toContain("CONNECTOR_STEPS.chatgpt");
  });
});

describe("whether ChatGPT is installed", () => {
  it("is so with the company's OpenAI key, or with the person's own plan connected, and not otherwise", () => {
    expect(isInstalled(app({}))).toBe(false);
    expect(isInstalled(app({ status: "connected" }))).toBe(true);
    expect(isInstalled(app({ my_plan: true }))).toBe(true);
    expect(isInstalled(app({ id: "anthropic", status: "connected" }))).toBe(true);
    expect(isInstalled(app({ id: "anthropic" }))).toBe(false);
  });

  it("isn't decided by an assistant someone connected in Settings anymore", () => {
    // A server from before this still calls ChatGPT a connector: nothing to install there.
    expect(isInstalled(app({ auth: "connector" }))).toBe(false);
    expect(source("features/apps/installed.ts")).not.toMatch(/assistantAppFor|useAssistantConnections/);
  });
});

describe("AI across the app", () => {
  const features = { ai: false, payments: false, email: false, sms: false, roofInsights: false };

  it("is on for a company with a key, and for a person whose own ChatGPT plan is connected", () => {
    expect(companyFeatures(features, {})).toMatchObject({ ai: false, chatgptPlan: false });
    expect(companyFeatures(features, { ai_connected: true })).toMatchObject({ ai: true, chatgptPlan: false });
    expect(companyFeatures(features, { ai_connected: true, chatgpt_plan: true })).toMatchObject({ ai: true, chatgptPlan: true });
  });
});
