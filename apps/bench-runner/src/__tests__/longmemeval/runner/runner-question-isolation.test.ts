import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executeLongMemEvalRun } from "../../../longmemeval/runner/runner-execution.js";
import type { LongMemEvalRunContext } from "../../../longmemeval/runner/prepare-context.js";
import { LongMemEvalDiagnosticsSpool } from "../../../longmemeval/diagnostics/spool.js";
import { createLongMemEvalSelectionContractFromAssignments } from "../../../longmemeval/selection/contract.js";

const mocks = vi.hoisted(() => ({
  collectInventory: vi.fn(),
  runQuestion: vi.fn(),
  startDaemon: vi.fn()
}));

vi.mock("../../../harness/daemon.js", () => ({
  startBenchDaemon: mocks.startDaemon
}));
vi.mock("../../../longmemeval/extraction/seed-fuel/seed-fuel-collector.js", () => ({
  collectBenchSeedFuelInventory: mocks.collectInventory
}));
vi.mock("../../../longmemeval/runner/question/runner-question.js", () => ({
  runLongMemEvalQuestion: mocks.runQuestion
}));

const roots: string[] = [];
const spools: LongMemEvalDiagnosticsSpool[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.startDaemon.mockImplementation(async (options: { dataDirRoot: string }) =>
    daemonHandle(options.dataDirRoot, "rule_only")
  );
  mocks.runQuestion.mockImplementation(async ({ question }: { question: { question_id: string } }) => ({
    questionId: question.question_id,
    hitAt5: true,
    latencyMs: 1,
    diagnostics: {
      candidate_pool_complete: true,
      query_probes: { normalized_query: "retained" },
      candidates: [{ object_id: "full-only" }]
    }
  }));
  mocks.collectInventory.mockResolvedValue({
    objects_total: 1,
    evidence_refs_total: 1,
    facet_anchors_total: 1,
    path_candidates_total: 1,
    support_bearing_candidates: 1
  });
});

afterEach(async () => {
  await Promise.all(spools.splice(0).map((spool) => spool.dispose()));
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })
  ));
});

describe("ordinary LongMemEval question isolation", () => {
  it("uses and removes one daemon data root per question", async () => {
    const parent = await ownedRoot();
    const context = await runContext(parent, ["first", "second"]);
    const result = await executeLongMemEvalRun(context);
    const dataRoots = mocks.startDaemon.mock.calls.map(
      ([options]) => (options as { dataDirRoot: string }).dataDirRoot
    );

    expect(dataRoots).toHaveLength(2);
    expect(new Set(dataRoots).size).toBe(2);
    expect(result.collected.map((row) => (row as unknown as { questionId: string }).questionId))
      .toEqual(["first", "second"]);
    expect(result.collected.every((row) => row.diagnostics.candidates.length === 0)).toBe(true);
    expect(result.collected[0]?.diagnostics.query_probes?.normalized_query).toBe("retained");
    expect(context.diagnosticsSpool.questionCount).toBe(2);
    await Promise.all(dataRoots.map(async (root) =>
      expect(access(root)).rejects.toMatchObject({ code: "ENOENT" })
    ));
  });

  it("merges each per-question inventory into the run result", async () => {
    const result = await executeLongMemEvalRun(
      await runContext(await ownedRoot(), ["first", "second"])
    );

    expect(mocks.collectInventory).toHaveBeenCalledTimes(2);
    expect(result.seedFuelInventory).toEqual({
      objects_total: 2,
      evidence_refs_total: 2,
      facet_anchors_total: 1,
      path_candidates_total: 2,
      support_bearing_candidates: 2
    });
  });

  it("seals and reports the daemon-selected reconciliation basis", async () => {
    const context = await runContext(await ownedRoot(), ["first", "second"]);
    const sealedContext: LongMemEvalRunContext = {
      ...context,
      opts: { ...context.opts, expectedReconciliationBasis: "rule_only" }
    };

    const result = await executeLongMemEvalRun(sealedContext);

    expect(result.reconciliationBasis).toBe("rule_only");
    for (const [options] of mocks.startDaemon.mock.calls) {
      expect(options).toMatchObject({ expectedReconciliationBasis: "rule_only" });
    }
  });

  it("rejects inconsistent reconciliation bases across isolated daemons", async () => {
    mocks.startDaemon
      .mockImplementationOnce(async (options: { dataDirRoot: string }) =>
        daemonHandle(options.dataDirRoot, "rule_only"))
      .mockImplementationOnce(async (options: { dataDirRoot: string }) =>
        daemonHandle(options.dataDirRoot, "garden_llm"));

    await expect(executeLongMemEvalRun(
      await runContext(await ownedRoot(), ["first", "second"])
    )).rejects.toThrow("reconciliation basis changed across isolated daemons");
  });

  it("preserves the single-question worker result", async () => {
    const result = await executeLongMemEvalRun(
      await runContext(await ownedRoot(), ["solo"])
    );

    expect(result.collected).toEqual([expect.objectContaining({
      questionId: "solo",
      hitAt5: true,
      latencyMs: 1,
      diagnostics: expect.objectContaining({ candidates: [] })
    })]);
  });
  it("retains isolated databases with treatment-neutral formation", async () => {
    const context = await runContext(await ownedRoot(), ["first", "second"]);
    const materializationContext: LongMemEvalRunContext = {
      ...context,
      opts: { ...context.opts, materializeQuestionDbs: true },
      removeSeedDataDirRoot: false
    };

    await executeLongMemEvalRun(materializationContext);
    const dataRoots = mocks.startDaemon.mock.calls.map(([options]) => options.dataDirRoot);

    await Promise.all(dataRoots.map(async (root) =>
      expect(access(root)).resolves.toBeUndefined()
    ));
    for (const [input] of mocks.runQuestion.mock.calls) {
      expect(input).toEqual(expect.objectContaining({
        seedFormationMode: "treatment_neutral"
      }));
    }
  });

});

async function ownedRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "alaya-run-isolation-test-"));
  roots.push(root);
  return root;
}

async function runContext(
  seedDataDirRoot: string,
  questionIds: readonly string[]
): Promise<LongMemEvalRunContext> {
  const diagnosticsSpool = await LongMemEvalDiagnosticsSpool.create();
  spools.push(diagnosticsSpool);
  return {
    opts: {
      variant: "longmemeval_s",
      embeddingMode: "disabled",
      historyRoot: join(seedDataDirRoot, "history")
    },
    releaseEvidenceAuthority: null,
    questions: [] as unknown as LongMemEvalRunContext["questions"],
    window: questionIds.map((question_id) => ({ question_id })) as unknown as LongMemEvalRunContext["window"],
    datasetSha256: "d".repeat(64),
    datasetChecksumSource: "fixture",
    datasetSourcePath: join(seedDataDirRoot, "dataset.json"),
    selectionContract: createLongMemEvalSelectionContractFromAssignments({
      datasetSha256: "d".repeat(64),
      assignments: questionIds.map((question_id) => ({
        question_id,
        dataset_cohort: "answerable"
      }))
    }),
    alayaVersion: "test",
    commitInfo: {} as LongMemEvalRunContext["commitInfo"],
    commitSha7: "deadbee",
    runAt: new Date("2026-07-11T00:00:00.000Z"),
    embeddingProviderLabel: "disabled",
    policyShape: "stress",
    simulateReport: "none",
    recallOptions: {} as LongMemEvalRunContext["recallOptions"],
    seedRunner: {} as LongMemEvalRunContext["seedRunner"],
    captureSnapshot: false,
    extractionCacheRoot: "/tmp/cache",
    recallWeightOverrides: undefined,
    seedDataDirRoot,
    removeSeedDataDirRoot: true,
    diagnosticsSpool
  };
}

function daemonHandle(dataDir: string, basis: "rule_only" | "garden_llm") {
  return {
    dataDir,
    runtime: {
      services: {
        reconciliationBasisStatus: { enabled: true as const, basis }
      }
    },
    shutdown: vi.fn(async () => undefined)
  };
}
