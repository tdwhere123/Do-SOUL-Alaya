import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildFullLongMemEvalPayload } from
  "../../../../../packages/eval/src/__tests__/history/history-fixture.js";
import { verifiedEvidenceForPayload } from
  "../../../../../packages/eval/src/__tests__/gates/verified-evidence-fixture.js";
import type { ParsedFlags } from "../../cli/cli-options.js";

const runners = vi.hoisted(() => ({
  multiturn: vi.fn(),
  crossquestion: vi.fn()
}));

vi.mock("../../longmemeval/multiturn.js", () => ({
  runLongMemEvalMultiturn: runners.multiturn
}));
vi.mock("../../longmemeval/crossquestion.js", () => ({
  runLongMemEvalCrossQuestion: runners.crossquestion
}));

import {
  runLongMemEvalCrossQuestionCommand,
  runLongMemEvalMultiturnCommand
} from "../../cli/cli-commands.js";

beforeEach(() => {
  runners.multiturn.mockReset();
  runners.crossquestion.mockReset();
});

describe("Tier 1 CLI evidence exit", () => {
  it.each([
    ["multiturn" as const, "public-multiturn" as const],
    ["crossquestion" as const, "public-crossquestion" as const]
  ])("accepts verified %s evidence", async (surface, benchName) => {
    const payload = buildFullLongMemEvalPayload(benchName, "abc1234", 0.95);
    const evidenceContext = await verifiedEvidenceForPayload(payload);
    runnerFor(surface).mockResolvedValue(result(payload, evidenceContext));

    await expect(commandFor(surface)(flags())).resolves.toBe(0);
    expect(runnerFor(surface)).toHaveBeenCalledWith(expect.objectContaining({
      extractionCacheRoot: "/tmp/extraction-cache"
    }));
    expect(runnerFor(surface).mock.calls[0]?.[0]).not.toHaveProperty("pinnedMetaRoot");
  });

  it.each([
    ["multiturn" as const, "public-multiturn" as const],
    ["crossquestion" as const, "public-crossquestion" as const]
  ])("fails closed when %s evidence is missing", async (surface, benchName) => {
    const payload = buildFullLongMemEvalPayload(benchName, "abc1234", 0.95);
    runnerFor(surface).mockResolvedValue(result(payload, null));

    await expect(commandFor(surface)(flags())).resolves.toBe(1);
  });

  it.each([
    ["multiturn" as const, "public-multiturn" as const],
    ["crossquestion" as const, "public-crossquestion" as const]
  ])("fails closed when %s uses a pinned metadata override", async (surface, benchName) => {
    const payload = buildFullLongMemEvalPayload(benchName, "abc1234", 0.95);
    runnerFor(surface).mockResolvedValue(result(payload, null));

    await expect(commandFor(surface)(flags({
      pinnedMetaRoot: "/tmp/pinned-meta"
    }))).resolves.toBe(1);
    expect(runnerFor(surface)).toHaveBeenCalledWith(expect.objectContaining({
      pinnedMetaRoot: "/tmp/pinned-meta"
    }));
  });
});

function runnerFor(surface: "multiturn" | "crossquestion") {
  return surface === "multiturn" ? runners.multiturn : runners.crossquestion;
}

function commandFor(surface: "multiturn" | "crossquestion") {
  return surface === "multiturn"
    ? runLongMemEvalMultiturnCommand
    : runLongMemEvalCrossQuestionCommand;
}

function result(
  payload: ReturnType<typeof buildFullLongMemEvalPayload>,
  evidenceContext: Awaited<ReturnType<typeof verifiedEvidenceForPayload>> | null
) {
  return {
    slug: "fixture",
    kpiPath: "/tmp/kpi.json",
    reportPath: "/tmp/report.md",
    findingsPath: "/tmp/findings.md",
    diagnosticsPath: null,
    payload,
    evidenceContext
  };
}

function flags(overrides: Partial<ParsedFlags> = {}): ParsedFlags {
  return {
    variant: "longmemeval_s",
    historyRoot: "/tmp/history",
    embeddingMode: "disabled",
    embeddingProviderKind: "openai",
    policyShape: "stress",
    simulateReport: "none",
    force: false,
    legacySnapshot: false,
    extractionCacheRoot: "/tmp/extraction-cache",
    qa: false,
    edgePlane: false,
    ...overrides
  };
}
