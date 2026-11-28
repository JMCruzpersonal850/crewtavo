/**
 * The sales board under a company's own stage names (Settings → Company → Sales board): the lanes
 * it draws from settings.pipeline_stages, and the moves a drop on a lane makes.
 */
import { describe, expect, it } from "vitest";
import { boardLanes, laneTarget } from "../src/features/pipeline/PipelinePage";

describe("the board's lanes from the company's settings", () => {
  it("are the five stages with their default names when the company saved none", () => {
    const lanes = boardLanes(null);
    expect(lanes.map((l) => [l.key, l.label, l.columns])).toEqual([
      ["new", "New requests", ["new"]],
      ["assess", "Assessments", ["assess"]],
      ["draft", "Drafting quote", ["draft"]],
      ["sent", "Awaiting response", ["sent"]],
      ["won", "Approved", ["won"]],
    ]);
    expect(lanes.map((l) => l.statuses)).toEqual([["new"], ["assessment_scheduled", "assessment_complete"], ["draft"], ["sent", "changes_requested"], ["approved"]]);
  });

  it("wear the company's names — Josue's words for the stages", () => {
    const lanes = boardLanes({ pipeline_stages: { labels: { new: "New Leads", assess: "Site Visits", draft: "Building Proposal", sent: "Proposal Sent", won: "Won-Sold" } } });
    expect(lanes.map((l) => l.label)).toEqual(["New Leads", "Site Visits", "Building Proposal", "Proposal Sent", "Won-Sold"]);
  });

  it("fold a hidden stage's statuses into the lane before it, with its groups kept for the phone", () => {
    const lanes = boardLanes({ pipeline_stages: { hidden: ["draft"] } });
    expect(lanes.map((l) => l.key)).toEqual(["new", "assess", "sent", "won"]);
    const assess = lanes[1]!;
    expect(assess.columns).toEqual(["assess", "draft"]);
    expect(assess.statuses).toEqual(["assessment_scheduled", "assessment_complete", "draft"]);
    // The folded stage's cards group under their own name on the phone, after the lane's own groups.
    expect(assess.groups?.map((g) => g.status)).toEqual(["assessment_complete", "assessment_scheduled", "draft"]);
  });
});

describe("a drop on a lane", () => {
  const request = { kind: "request" as const, status: "new" };
  const draftQuote = { kind: "quote" as const, status: "draft" };
  const sentQuote = { kind: "quote" as const, status: "sent" };
  const approvedQuote = { kind: "quote" as const, status: "approved" };

  it("moves a card to the stage in the lane it can move to", () => {
    expect(laneTarget(request, ["draft"])).toBe("draft");
    expect(laneTarget(request, ["assess", "draft"])).toBe("draft");
    expect(laneTarget(draftQuote, ["sent", "won"])).toBe("sent");
    expect(laneTarget(sentQuote, ["sent", "won"])).toBe("won");
  });

  it("refuses a lane holding no stage the card can move to", () => {
    expect(laneTarget(request, ["new"])).toBeNull();
    expect(laneTarget(request, ["sent"])).toBeNull();
    expect(laneTarget(draftQuote, ["draft"])).toBeNull();
    expect(laneTarget(approvedQuote, ["won"])).toBeNull();
  });
});
