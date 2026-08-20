import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  drainAuditedAsyncSideEffects,
  scheduleAuditedAsyncSideEffect
} from "@do-soul/alaya-core";
import { createLongMemEvalSelectionContractFromAssignments } from "../../../bench/selection/contract.js";
import { executeLongMemEvalRun } from "../../../longmemeval/runner/runner-execution.js";
import type { LongMemEvalRunContext } from "../../../longmemeval/runner/prepare-context.js";
import type { LongMemEvalRunOptions } from "../../../longmemeval/runner.js";
import type { BenchRecallWeightOverrides } from "../../../harness/recall/recall-weight-overrides.js";
import { emptySeedFuelInventory } from
  "../../../bench/extraction/seed-fuel/seed-fuel-inventory.js";

const mocks = vi.hoisted(() => ({
  events: [] as string[],
  prepare: vi.fn(),
  prepareSnapshot: vi.fn(),
  recall: vi.fn(),
  runQuestion: vi.fn(),
  startDaemon: vi.fn(),
  collectInventory: vi.fn(),
  quiesce: vi.fn(),
  buildProvenance: vi.fn(),
  writeSnapshot: vi.fn(),
  snapshotAuthority: vi.fn(),
  snapshotAuthorityProof: vi.fn(),
  checkpoint: vi.fn(),
  fieldCheckpoint: vi.fn()
}));
const QUESTION_IDS = ["first", "second"] as const;
const EXTRACTION_CACHE_PREFLIGHT_PROOF = Object.freeze({
  kind: "sentinel-extraction-cache-preflight-proof"
});

interface SnapshotPolicyDrift {
  readonly policyShape?: "chat";
  readonly simulateReport?: "mixed";
  readonly recallWeightOverrides?: BenchRecallWeightOverrides;
  readonly qa?: true;
  readonly embeddingMode?: "env";
}

vi.mock("../../../harness/daemon.js", () => ({
  startBenchDaemon: mocks.startDaemon
}));
vi.mock("../../../bench/extraction/seed-fuel/seed-fuel-collector.js", () => ({
  collectBenchSeedFuelInventory: mocks.collectInventory
}));
vi.mock("../../../bench/snapshot/quiescence.js", () => ({
  awaitLongMemEvalSnapshotQuiescence: mocks.quiesce
}));
vi.mock("../../../longmemeval/runner/question/runner-question.js", () => ({
  prepareLongMemEvalQuestion: mocks.prepare,
  prepareLongMemEvalSnapshotQuestion: mocks.prepareSnapshot,
  runLongMemEvalQuestion: mocks.runQuestion,
  runPreparedLongMemEvalQuestion: mocks.recall
}));
vi.mock("../../../longmemeval/runner/runner-helpers.js", () => ({
  writeRecallEvalSnapshot: mocks.writeSnapshot
}));
vi.mock("../../../bench/provenance/run.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../bench/provenance/run.js")>(),
  buildLongMemEvalRunProvenance: mocks.buildProvenance
}));
vi.mock("../../../bench/snapshot/current/current-substrate-authority.js", () => ({
  assertCurrentPostFillCacheAuthority: mocks.snapshotAuthority,
  assertCurrentPostFillCacheAuthorityProof: mocks.snapshotAuthorityProof
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.events.length = 0;
  mocks.startDaemon.mockImplementation(async () => ({
    dataDir: "/tmp/runner-snapshot-order",
    runtime: {
      services: {
        reconciliationBasisStatus: { enabled: false }
      }
    },
    shutdown: vi.fn(async () => mocks.events.push("shutdown")),
    checkpointFieldProjection: mocks.fieldCheckpoint,
    checkpointRelationProjection: mocks.checkpoint
  }));
  mocks.prepare.mockImplementation(async ({ question }) => {
    mocks.events.push(`prepare:${question.question_id}`);
    return preparedQuestion(question.question_id);
  });
  mocks.prepareSnapshot.mockImplementation(async ({ question }) => {
    mocks.events.push(`prepare:${question.question_id}`);
    return { questionId: question.question_id };
  });
  mocks.recall.mockImplementation(async ({ question }) => {
    mocks.events.push(`recall:${question.question_id}`);
    return workerResult(question.question_id);
  });
  mocks.quiesce.mockImplementation(async () => {
    mocks.events.push("quiescence");
  });
  mocks.fieldCheckpoint.mockImplementation(async () => {
    mocks.events.push("field-checkpoint");
  });
  mocks.checkpoint.mockImplementation(async () => {
    mocks.events.push("checkpoint");
  });
  mocks.collectInventory.mockImplementation(async () => {
    mocks.events.push("inventory");
    return seedFuelInventory();
  });
  mocks.buildProvenance.mockImplementation(async () => {
    mocks.events.push("provenance");
    return {};
  });
  mocks.writeSnapshot.mockImplementation(async () => {
    mocks.events.push("snapshot");
  });
  mocks.snapshotAuthority.mockImplementation(() => undefined);
  mocks.snapshotAuthorityProof.mockImplementation(() => undefined);
});

afterEach(() => {
  mocks.events.length = 0;
});

describe("LongMemEval snapshot execution ordering", () => {
  it("freezes the full seed window and writes the snapshot without a recall pass", async () => {
    const result = await executeLongMemEvalRun(snapshotContext());

    expect(mocks.startDaemon).toHaveBeenCalledWith(expect.objectContaining({
      fieldProjectionAdmissionMode: "explicit_checkpoint",
      relationProjectionAdmissionMode: "explicit_checkpoint"
    }));
    expect(mocks.events).toEqual([
      "prepare:first",
      "prepare:second",
      "quiescence",
      "field-checkpoint",
      "checkpoint",
      "provenance",
      "snapshot",
      "shutdown"
    ]);
    expect(result.collected).toEqual([]);
    expect(result.seedFuelInventory).toEqual(emptySeedFuelInventory());
    expect(mocks.collectInventory).not.toHaveBeenCalled();
    expect(mocks.recall).not.toHaveBeenCalled();
    expect(mocks.runQuestion).not.toHaveBeenCalled();
  });

  it("uses the snapshot-only preparer and forwards snapshot questions", async () => {
    mocks.prepare.mockRejectedValue(
      new Error("snapshot execution retained the generic prepared-question graph")
    );

    await expect(executeLongMemEvalRun(snapshotContext())).resolves.toBeDefined();

    expect(mocks.prepareSnapshot).toHaveBeenCalledTimes(QUESTION_IDS.length);
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(mocks.writeSnapshot.mock.calls[0]?.[0].snapshotQuestions).toEqual([
      { questionId: "first" },
      { questionId: "second" }
    ]);
  });

  it("shuts down without freezing when producer quiescence fails", async () => {
    mocks.quiesce.mockImplementationOnce(async () => {
      mocks.events.push("quiescence");
      throw new Error("pending async writer");
    });

    await expect(executeLongMemEvalRun(snapshotContext()))
      .rejects.toThrow(/pending async writer/u);
    expect(mocks.events).toEqual([
      "prepare:first",
      "prepare:second",
      "quiescence",
      "shutdown"
    ]);
    expect(mocks.collectInventory).not.toHaveBeenCalled();
    expect(mocks.writeSnapshot).not.toHaveBeenCalled();
    expect(mocks.recall).not.toHaveBeenCalled();
  });

  it("does not freeze when a real audited producer side effect rejects", async () => {
    vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
    mocks.prepareSnapshot.mockImplementationOnce(async ({ question }) => {
      mocks.events.push(`prepare:${question.question_id}`);
      scheduleAuditedAsyncSideEffect(Promise.reject(new Error("producer write failed")), {
        source: "runner-snapshot-order",
        operation: "producer_write",
        subjectType: "fixture",
        subjectId: question.question_id,
        workspaceId: "fixture-workspace",
        warningCode: "ALAYA_FIXTURE_SIDE_EFFECT_FAILED",
        warningMessage: "fixture producer side effect failed"
      });
      return { questionId: question.question_id };
    });
    mocks.quiesce.mockImplementationOnce(async () => {
      mocks.events.push("quiescence");
      await drainAuditedAsyncSideEffects({ timeoutMs: 1_000 });
    });

    await expect(executeLongMemEvalRun(snapshotContext()))
      .rejects.toThrow(/producer_write: producer write failed/u);
    expect(mocks.writeSnapshot).not.toHaveBeenCalled();
    expect(mocks.recall).not.toHaveBeenCalled();
    await expect(drainAuditedAsyncSideEffects({ timeoutMs: 10 }))
      .resolves.toBeUndefined();
  });

  it.each([
    ["chat policy", { policyShape: "chat" }],
    ["simulated report", { simulateReport: "mixed" }],
    ["recall weights", {
      recallWeightOverrides: {
        source: "cli",
        summary: { source: "cli" }
      } satisfies BenchRecallWeightOverrides
    }],
    ["QA", { qa: true }],
    ["embedding treatment", { embeddingMode: "env" }]
  ] as const)("rejects %s before starting the producer daemon", async (_label, drift) => {
    await expect(executeLongMemEvalRun(snapshotContext(drift)))
      .rejects.toThrow(/snapshot production requires/u);
    expect(mocks.startDaemon).not.toHaveBeenCalled();
    expect(mocks.writeSnapshot).not.toHaveBeenCalled();
  });

  it("rejects seed-time edge formation before starting the producer daemon", async () => {
    vi.stubEnv("ALAYA_BENCH_RUN_EDGE_PLANE", "1");
    try {
      await expect(executeLongMemEvalRun(snapshotContext()))
        .rejects.toThrow(/edge formation must be disabled/u);
      expect(mocks.startDaemon).not.toHaveBeenCalled();
      expect(mocks.writeSnapshot).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it.each([
    ["non-product formation", "ALAYA_INGEST_RECONCILIATION_ENABLED", "0"],
    ["conflict LLM credential", "ALAYA_CONFLICT_LLM_API_KEY", "secret"]
  ])("rejects %s before starting the producer daemon", async (_label, key, value) => {
    vi.stubEnv(key, value);
    try {
      await expect(executeLongMemEvalRun(snapshotContext()))
        .rejects.toThrow(/product formation/u);
      expect(mocks.startDaemon).not.toHaveBeenCalled();
      expect(mocks.writeSnapshot).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("rejects an ineligible substrate before starting the producer daemon", async () => {
    mocks.snapshotAuthorityProof.mockImplementationOnce(() => {
      throw new Error("post-fill benchmark requires a complete v3 extraction manifest");
    });

    await expect(executeLongMemEvalRun(snapshotContext()))
      .rejects.toThrow(/complete v3 extraction manifest/u);
    expect(mocks.startDaemon).not.toHaveBeenCalled();
    expect(mocks.writeSnapshot).not.toHaveBeenCalled();
  });

  it("reuses the seed runner preflight proof without rescanning cache shards", async () => {
    await executeLongMemEvalRun(snapshotContext());

    expect(mocks.snapshotAuthorityProof).toHaveBeenCalledTimes(1);
    expect(mocks.snapshotAuthorityProof.mock.calls[0]?.[0]).toMatchObject({
      proof: EXTRACTION_CACHE_PREFLIGHT_PROOF,
      cacheRoot: "/tmp/cache",
      datasetSha256: "d".repeat(64),
      requiredTurnContents: [],
      requiredExtractionTurns: [],
      requiredQuestionWindow: { offset: 0, limit: 2 }
    });
    expect(mocks.snapshotAuthority).not.toHaveBeenCalled();
  });
});

function snapshotContext(drift: SnapshotPolicyDrift = {}): LongMemEvalRunContext {
  return {
    opts: snapshotOptions(drift),
    releaseEvidenceAuthority: {} as LongMemEvalRunContext["releaseEvidenceAuthority"],
    questions: [] as unknown as LongMemEvalRunContext["questions"],
    window: QUESTION_IDS.map((question_id) => ({
      question_id,
      haystack_sessions: []
    })) as
      unknown as LongMemEvalRunContext["window"],
    datasetQuestionCount: QUESTION_IDS.length,
    datasetSha256: "d".repeat(64),
    datasetChecksumSource: "fixture",
    datasetSourcePath: "/tmp/dataset.json",
    selectionContract: createLongMemEvalSelectionContractFromAssignments({
      datasetSha256: "d".repeat(64),
      assignments: QUESTION_IDS.map((question_id) => ({
        question_id,
        dataset_cohort: "answerable"
      }))
    }),
    alayaVersion: "test",
    commitInfo: {} as LongMemEvalRunContext["commitInfo"],
    commitSha7: "deadbee",
    runAt: new Date("2026-07-16T00:00:00.000Z"),
    embeddingProviderLabel: "none",
    policyShape: drift.policyShape ?? "stress",
    simulateReport: drift.simulateReport ?? "none",
    recallOptions: { maxResults: 10, conflictAwareness: true },
    seedRunner: {
      stats: seedStats(),
      extractionCachePreflightProof: EXTRACTION_CACHE_PREFLIGHT_PROOF
    } as unknown as
      LongMemEvalRunContext["seedRunner"],
    captureSnapshot: true,
    extractionCacheRoot: "/tmp/cache",
    recallWeightOverrides: drift.recallWeightOverrides,
    seedDataDirRoot: "/tmp/runner-snapshot-order",
    removeSeedDataDirRoot: false,
    diagnosticsSpool: {
      append: async (diagnostics: unknown) => diagnostics
    } as LongMemEvalRunContext["diagnosticsSpool"]
  };
}

function snapshotOptions(drift: SnapshotPolicyDrift): LongMemEvalRunOptions {
  return {
    variant: "longmemeval_s" as const,
    historyRoot: "/tmp/history",
    snapshotOut: "/tmp/snapshot.db",
    embeddingMode: drift.embeddingMode ?? "disabled",
    ...(drift.qa === true ? {
      qa: { chat: async () => "answer", answerModel: "fixture", judgeModel: "fixture" }
    } : {})
  };
}

function preparedQuestion(questionId: string) {
  return {
    questionId,
    snapshotQuestion: { questionId }
  };
}

function workerResult(questionId: string) {
  return {
    questionId,
    hitAt5: true,
    latencyMs: 1,
    diagnostics: {}
  };
}

function seedFuelInventory() {
  return {
    objects_total: 2,
    evidence_refs_total: 2,
    facet_anchors_total: 0,
    path_candidates_total: 0,
    support_bearing_candidates: 2
  };
}

function seedStats() {
  return {
    extractionPath: "official_api_compile",
    cacheHits: 2,
    llmCalls: 0,
    offlineFallbacks: 0,
    factsExtracted: 2,
    signalsDropped: 0,
    signalsDroppedByReason: { candidate_absent: 0, materialization_drop: 0 }
  };
}
