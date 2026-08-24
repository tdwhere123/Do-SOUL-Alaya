// @ts-nocheck
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RecallEvalOneQuestionInput } from
  "../../../bench/lifecycle/recall-eval/question/recall-eval-question.js";

const mocks = vi.hoisted(() => ({
  warm: vi.fn(),
  recall: vi.fn(),
  detach: vi.fn(),
  onWarmup: vi.fn()
}));

vi.mock(
  "../../../bench/provenance/embedding/embedding-cache-warmup.js",
  () => ({ warmLongMemEvalEmbeddingCaches: mocks.warm })
);
vi.mock("../../../longmemeval/runner.js", () => ({
  buildLongMemEvalSidecarKey: vi.fn(() => "key"),
  deriveLongMemEvalGoldEvidenceIds: vi.fn(() => []),
  deriveLongMemEvalGoldMemoryIds: vi.fn(() => []),
  deriveLongMemEvalGoldObjectIds: vi.fn(() => []),
  resolveLongMemEvalHitVerdict: vi.fn(() => ({
    hitAt1: false, hitAt5: false, hitAt10: false, firstTier: null
  })),
  runLongMemEvalRecallCycle: mocks.recall
}));
vi.mock("../../../bench/diagnostics.js", () => ({
  buildQuestionDiagnostic: vi.fn(() => ({
    delivered_results: [], candidates: [], is_abstention: false
  }))
}));
vi.mock("../../../bench/diagnostics/diagnostics-measurement-axes.js", () => ({
  attachQuestionMeasurementAxes: vi.fn((diagnostic) => diagnostic)
}));
vi.mock("../../../bench/diagnostics/gold-object-identities.js", () => ({
  buildGoldObjectIdentities: vi.fn(() => [])
}));
vi.mock("../../../bench/provenance/recall-eval/recall-eval-pool-dump.js", () => ({
  writeRecallEvalPoolDump: vi.fn()
}));
vi.mock("../../../bench/qa/recall-token-economy.js", () => ({
  extractRecallTokenEconomy: vi.fn(() => null)
}));
vi.mock("../../../longmemeval/runner/runner-helpers.js", () => ({
  deriveLongMemEvalMemoryObjectIds: vi.fn(() => [])
}));

import { recallEvalOneQuestion } from
  "../../../bench/lifecycle/recall-eval/question/recall-eval-question.js";

describe("recall-eval question memory profile wiring", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.recall.mockResolvedValue({
      scoredRecallResult: { results: [], active_constraints: [] },
      scoredRecallLatencyMs: 1
    });
  });

  it("samples only after an actual document embedding warmup", async () => {
    mocks.warm.mockResolvedValueOnce({
      embeddingWarmup: null,
      queryEmbeddingWarmup: null,
      documentWarmupLatencyMs: null
    });
    await recallEvalOneQuestion(buildInput("disabled"));
    expect(mocks.onWarmup).not.toHaveBeenCalled();

    mocks.warm.mockResolvedValueOnce({
      embeddingWarmup: warmupSummary(0),
      queryEmbeddingWarmup: null,
      documentWarmupLatencyMs: 1
    });
    await recallEvalOneQuestion(buildInput("env"));
    expect(mocks.onWarmup).not.toHaveBeenCalled();

    mocks.warm.mockImplementationOnce(async () => {
      expect(mocks.onWarmup).not.toHaveBeenCalled();
      return {
        embeddingWarmup: warmupSummary(1),
        queryEmbeddingWarmup: null,
        documentWarmupLatencyMs: 2
      };
    });
    await recallEvalOneQuestion(buildInput("env"));

    expect(mocks.onWarmup).toHaveBeenCalledTimes(1);
    expect(mocks.detach).toHaveBeenCalledTimes(3);
  });

  it("does not attach or detach a caller-owned workspace", async () => {
    mocks.warm.mockResolvedValue({
      embeddingWarmup: null,
      queryEmbeddingWarmup: null,
      documentWarmupLatencyMs: null
    });
    const input = buildInput("disabled");
    const owned = await input.daemon.attachWorkspace({
      workspaceId: input.question.workspaceId,
      runId: input.question.runId
    });
    mocks.detach.mockClear();
    (input.daemon.attachWorkspace as ReturnType<typeof vi.fn>).mockClear();

    await recallEvalOneQuestion({ ...input, workspace: owned });

    expect(input.daemon.attachWorkspace).not.toHaveBeenCalled();
    expect(mocks.detach).not.toHaveBeenCalled();
  });
});

function warmupSummary(passCount: number) {
  return {
    status: "ready" as const,
    expected_count: 1,
    ready_count: 1,
    ready_rate: 1,
    pass_count: passCount,
    missing_object_ids: [],
    provider_kind: "local_onnx",
    model_id: "model",
    schema_version: 2,
    d2q_input: "content_plus_hq" as const
  };
}

function buildInput(
  embeddingMode: RecallEvalOneQuestionInput["embeddingMode"]
): RecallEvalOneQuestionInput {
  const workspace = {
    detach: mocks.detach,
    queryTokenMetrics: vi.fn(async () => ({})),
    queryEdgeProposalKpiRows: vi.fn(async () => []),
    warmEmbeddingCache: vi.fn(),
    warmQueryEmbeddingCache: vi.fn()
  };
  const daemon = {
    attachWorkspace: vi.fn(async () => workspace)
  } as unknown as RecallEvalOneQuestionInput["daemon"];
  return {
    daemon,
    question: {
      questionId: "q-memory",
      workspaceId: "workspace-memory",
      runId: "run-memory",
      question: "What should be recalled?",
      questionDate: "2026-08-12T00:00:00.000Z",
      answerSessionIds: [],
      answerSeedDropReasons: [],
      sidecar: []
    },
    turnIndex: 1,
    embeddingMode,
    recallOptions: { maxResults: 10, conflictAwareness: true },
    simulateReport: "none",
    measurement: undefined,
    onActualEmbeddingWarmupComplete: async () => {
      mocks.onWarmup();
    }
  };
}
