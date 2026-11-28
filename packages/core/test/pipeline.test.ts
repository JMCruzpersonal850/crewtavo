import { describe, expect, it } from "vitest";
import { PIPELINE_STAGE_LABELS, pipelineLanes, pipelineStageLabel, pipelineStages, pipelineStagesSetting } from "../src/pipeline";

describe("the sales board's stages as a company names them", () => {
  it("are the five fixed stages with their default names when nothing is saved", () => {
    for (const settings of [null, undefined, {}, { pipeline_stages: null }, { pipeline_stages: "nope" }]) {
      expect(pipelineStages(settings).map((s) => [s.key, s.label, s.hidden])).toEqual([
        ["new", "New requests", false],
        ["assess", "Assessments", false],
        ["draft", "Drafting quote", false],
        ["sent", "Awaiting response", false],
        ["won", "Approved", false],
      ]);
    }
  });

  it("take the company's names, cleaned, and only for the stages there are", () => {
    const stages = pipelineStages({ pipeline_stages: { labels: { new: "  Leads ", assess: "Site   visits", won: "Won!", bogus: "Nope", draft: 42 } } });
    expect(stages.map((s) => s.label)).toEqual(["Leads", "Site visits", "Drafting quote", "Awaiting response", "Won!"]);
  });

  it("caps a name at the label limit and reads an all-whitespace name as none", () => {
    expect(pipelineStageLabel("x".repeat(80))).toHaveLength(40);
    expect(pipelineStageLabel("   ")).toBeNull();
    expect(pipelineStageLabel(null)).toBeNull();
  });

  it("marks the stages the company folded away, and drops unknown ones", () => {
    const stages = pipelineStages({ pipeline_stages: { hidden: ["draft", "draft", "bogus", 7] } });
    expect(stages.filter((s) => s.hidden).map((s) => s.key)).toEqual(["draft"]);
  });

  it("shows every stage when all five were folded away", () => {
    const stages = pipelineStages({ pipeline_stages: { hidden: ["new", "assess", "draft", "sent", "won"] } });
    expect(stages.every((s) => !s.hidden)).toBe(true);
  });

  it("cleans what Settings saves back to just the names that differ and the folded stages", () => {
    const cleaned = pipelineStagesSetting({ pipeline_stages: { labels: { new: "Leads", assess: PIPELINE_STAGE_LABELS.assess, sent: " Proposal   sent " }, hidden: ["assess", "bogus"] } });
    expect(cleaned).toEqual({ labels: { new: "Leads", sent: "Proposal sent" }, hidden: ["assess"] });
    // What Settings saves is what the board reads.
    const settings = { pipeline_stages: cleaned };
    expect(pipelineStages(settings).map((s) => [s.key, s.label, s.hidden])).toEqual([
      ["new", "Leads", false],
      ["assess", "Assessments", true],
      ["draft", "Drafting quote", false],
      ["sent", "Proposal sent", false],
      ["won", "Approved", false],
    ]);
  });
});

describe("the lanes the board draws", () => {
  it("are one per stage when nothing is folded", () => {
    expect(pipelineLanes(null)).toEqual([
      { key: "new", label: "New requests", stages: ["new"] },
      { key: "assess", label: "Assessments", stages: ["assess"] },
      { key: "draft", label: "Drafting quote", stages: ["draft"] },
      { key: "sent", label: "Awaiting response", stages: ["sent"] },
      { key: "won", label: "Approved", stages: ["won"] },
    ]);
  });

  it("fold a hidden stage into the shown stage before it", () => {
    expect(pipelineLanes({ pipeline_stages: { hidden: ["draft"] } }).map((l) => [l.key, l.stages])).toEqual([
      ["new", ["new"]],
      ["assess", ["assess", "draft"]],
      ["sent", ["sent"]],
      ["won", ["won"]],
    ]);
  });

  it("fold stages hidden ahead of the first shown stage into that first lane", () => {
    expect(pipelineLanes({ pipeline_stages: { hidden: ["new", "assess"] } }).map((l) => [l.key, l.stages])).toEqual([
      ["draft", ["new", "assess", "draft"]],
      ["sent", ["sent"]],
      ["won", ["won"]],
    ]);
  });

  it("keep the company's names on the lanes", () => {
    const lanes = pipelineLanes({ pipeline_stages: { labels: { new: "Leads" }, hidden: ["won"] } });
    expect(lanes[0]).toMatchObject({ key: "new", label: "Leads" });
    expect(lanes.at(-1)).toMatchObject({ key: "sent", stages: ["sent", "won"] });
  });
});
