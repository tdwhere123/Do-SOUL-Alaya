import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RecallEvalQuestionResult } from
  "../../../bench/lifecycle/recall-eval/recall-eval-contract.js";

const mocks = vi.hoisted(() => ({
  append: vi.fn(),
  archive: vi.fn(),
  captureCommitted: false,
  dispose: vi.fn(),
  events: [] as string[],
  finalizeOwnedRoot: vi.fn(),
  prepareContext: vi.fn(),
  profileEnabled: false,
  profileFailures: [] as Array<{ phase: string; name: string; code: string | null }>,
  profileSample: vi.fn(),
  profileMarkIncomplete: vi.fn(),
  published: vi.fn(),
  question: vi.fn(),
  selectionDispose: vi.fn(),
  shutdown: vi.fn(),
  writeEntry: vi.fn(),
  createSpool: vi.fn(),
  createPager: vi.fn()
}));

const spool = { append: mocks.append, dispose: mocks.dispose, rootPath: "/tmp/spool" };
const roots: string[] = [];

vi.mock("@do-soul/alaya-eval", () => ({
  buildDiffVsPrevious: vi.fn(() => null),
  diffKpis: vi.fn(() => ({})),
  isHistoryEntryCommittedError: vi.fn(() => false),
  renderFindings: vi.fn(() => null),
  writeEntry: mocks.writeEntry
}));
vi.mock("../../../harness/daemon.js", () => ({
  startBenchDaemon: vi.fn(async () => ({ shutdown: mocks.shutdown }))
}));
vi.mock(
  "../../../bench/lifecycle/recall-eval/recall-eval-process/ipc-client.js",
  async (importOriginal) => {
    const actual = await importOriginal<
      typeof import("../../../bench/lifecycle/recall-eval/recall-eval-process/ipc-client.js")
    >();
    return {
      ...actual,
      createRecallEvalPagerSession: mocks.createPager
    };
  }
);
vi.mock("../../../harness/recall/recall-weight-overrides.js", () => ({
  ALAYA_RECALL_WEIGHT_OVERRIDES_ENV: "ALAYA_RECALL_WEIGHT_OVERRIDES",
  formatBenchRecallWeightOverrides: vi.fn(),
  resolveBenchRecallWeightOverrides: vi.fn(() => undefined)
}));
vi.mock("../../../bench/recall-eval-kpi.js", () => ({
  assembleRecallEvalKpi: vi.fn(() => ({
    bench_name: "public", split: "fixture", run_at: "2026-08-12T00:00:00.000Z",
    alaya_commit: "1749d78", evaluated_count: 1, dataset: {}
  }))
}));
vi.mock("../../../bench/kpi/recall-eval-archive.js", () => ({
  buildPerQuestionDelivered: vi.fn(() => new Map()),
  buildRecallEvalArchiveSlug: vi.fn(() => "fixture-slug")
}));
vi.mock(
  "../../../bench/lifecycle/recall-eval/recall-eval-archive-impl.js",
  () => ({ selectRecallEvalBaseline: vi.fn(async () => null) })
);
vi.mock("../../../bench/snapshot/materialize.js", () => ({
  snapshotQuestionIdDigest: vi.fn(() => "a".repeat(64))
}));
vi.mock("../../../bench/lifecycle/owned-temp-root.js", () => ({
  finalizeOwnedTempRoot: mocks.finalizeOwnedRoot
}));
vi.mock("../../../bench/lifecycle/errors.js", () => ({
  boundLifecycleFailure: vi.fn((phase: string, error: unknown) => ({
    phase,
    name: error instanceof Error ? error.name : "UnknownError",
    code: (error as NodeJS.ErrnoException).code ?? null
  })),
  renderLifecycleFailure: vi.fn((failure) =>
    `phase=${failure.phase} name=${failure.name} code=${failure.code ?? "none"}`),
  throwLifecycleErrors: vi.fn((_message: string, errors: unknown[]) => {
    const error = errors.find((candidate) => candidate !== undefined);
    if (error !== undefined) throw error;
  })
}));
vi.mock(
  "../../../bench/lifecycle/recall-eval/recall-eval-progress.js",
  () => ({ writeRecallEvalProgress: vi.fn() })
);
vi.mock(
  "../../../bench/provenance/recall-eval/recall-eval-archive-bundle.js",
  () => ({ buildRecallEvalArchiveBundle: mocks.archive })
);
vi.mock(
  "../../../bench/provenance/recall-eval/recall-eval-run.js",
  () => ({
    buildRecallEvalRunProvenance: vi.fn(async () => ({
      code: {
        worktree_clean: true,
        worktree_state_sha256: "aa".repeat(32)
      }
    })),
    isRecallEvalRunEvidenceEligible: vi.fn(() => false)
  })
);
vi.mock("../../../bench/measurement/artifact-transaction.js", () => ({
  withPublishedDiagnosticsArtifact: mocks.published
}));
vi.mock("../../../bench/measurement/recall-eval-memory-profile.js", () => ({
  withRecallEvalMemoryProfile: vi.fn(async (_options, run) => {
    const profile = mocks.profileEnabled ? {
      sample: mocks.profileSample,
      markIncomplete: mocks.profileMarkIncomplete,
      completion: () => ({
        status: mocks.profileFailures.length === 0 ? "complete" : "incomplete",
        failures: [...mocks.profileFailures]
      })
    } : null;
    return {
      value: await run(profile),
      completion: profile?.completion() ?? { status: "disabled", failures: [] }
    };
  })
}));
vi.mock(
  "../../../bench/lifecycle/recall-eval/recall-eval-run-context.js",
  () => ({ prepareRecallEvalRunContext: mocks.prepareContext })
);
vi.mock("../../../bench/kpi/recall-eval-report.js", () => ({
  renderRecallEvalReport: vi.fn(() => "# report\n")
}));
vi.mock(
  "../../../bench/lifecycle/recall-eval/recall-eval-selection-replay.js",
  () => ({
    RECALL_EVAL_SELECTION_BOUNDARY_FILENAME: "selection.ndjson.gz",
    captureRecallEvalQuestion: vi.fn(async (_spool, _questionId, run) => {
      const result = await run(undefined);
      mocks.captureCommitted = true;
      return result;
    }),
    finalizeRecallEvalSelectionBoundarySpool: vi.fn(async () => null)
  })
);
vi.mock(
  "../../../bench/lifecycle/recall-eval/question/recall-eval-question.js",
  () => ({ recallEvalOneQuestion: mocks.question })
);
vi.mock(
  "../../../bench/provenance/recall-eval/recall-eval-diagnostics-spool.js",
  () => ({ RecallEvalDiagnosticsSpool: { create: mocks.createSpool } })
);

import { runRecallEval } from
  "../../../bench/lifecycle/recall-eval/recall-eval-impl.js";

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })));
});

beforeEach(() => {
  resetHarnessState();
  configureProfileHarness();
  configureRuntimeHarness();
  configureArchiveHarness();
});

describe("recall-eval diagnostics spool lifecycle", () => {

  it("appends after selection commit, retains compact rows, and archives via the same spool", async () => {
    await expect(runRecallEval(options())).resolves.toMatchObject({ slug: "fixture-slug" });

    expect(mocks.createSpool).toHaveBeenCalledTimes(1);
    expect(mocks.append).toHaveBeenCalledTimes(1);
    const archiveInput = mocks.archive.mock.calls[0]?.[0];
    expect(archiveInput.diagnosticsSpool).toBe(spool);
    expect(archiveInput.collected).toHaveLength(1);
    expect(archiveInput.collected[0].diagnostics.candidates).toEqual([]);
    expect(mocks.writeEntry.mock.calls[0]?.[6].fileSidecars[0].identity).toEqual({
      sha256: "a".repeat(64), bytes: 7
    });
    expect(mocks.dispose).toHaveBeenCalledTimes(1);
  });

  it("disposes the spool when append fails after selection commit", async () => {
    mocks.append.mockRejectedValueOnce(new Error("synthetic append failure"));

    await expect(runRecallEval(options())).rejects.toThrow("synthetic append failure");
    expect(mocks.captureCommitted).toBe(true);
    expect(mocks.createSpool).toHaveBeenCalledTimes(1);
    expect(mocks.dispose).toHaveBeenCalledTimes(1);
    expect(mocks.archive).not.toHaveBeenCalled();
  });
});

describe("recall-eval diagnostics artifact profile lifecycle", () => {
  it("removes staged diagnostics when archive-staged profiling fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "recall-eval-lifecycle-artifact-"));
    roots.push(root);
    const stagedPath = join(root, "staged.json.gz");
    const finalPath = join(root, "final.json.gz");
    await writeFile(stagedPath, "staged");
    mocks.archive.mockResolvedValueOnce({
      sidecars: [], diagnosticsFilename: "diagnostics.json.gz",
      diagnosticsArtifact: {
        stagedPath, finalPath,
        identity: { sha256: "b".repeat(64), bytes: 6 }
      }
    });
    enableProfileFailure("archive_staged");

    await expect(runRecallEval(options())).rejects.toThrow("archive_staged profile failure");
    await expect(access(stagedPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(finalPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(mocks.writeEntry).not.toHaveBeenCalled();
  });

  it.each(["archive_complete", "cleanup_complete"] as const)(
    "does not turn a committed run into failure when %s profiling fails",
    async (phase) => {
      enableProfileFailure(phase);

      await expect(runRecallEval(options())).resolves.toMatchObject({
        slug: "fixture-slug",
        memoryProfile: {
          status: "incomplete",
          failures: [{ phase, name: "Error", code: null }]
        }
      });
      expect(mocks.writeEntry).toHaveBeenCalledTimes(1);
      expect(mocks.dispose).toHaveBeenCalledTimes(1);
    }
  );
});

describe("recall-eval committed cleanup status", () => {
  it.each([
    ["data_root_cleanup", () => mocks.finalizeOwnedRoot.mockRejectedValueOnce(eio())],
    ["selection_spool_cleanup", () => mocks.selectionDispose.mockRejectedValueOnce(eio())],
    ["diagnostics_spool_cleanup", () => mocks.dispose.mockRejectedValueOnce(eio())]
  ])("reports %s without losing the committed result", async (phase, fail) => {
    fail();

    await expect(runRecallEval(options())).resolves.toMatchObject({
      slug: "fixture-slug",
      completion: {
        status: "incomplete",
        failures: [{ phase, name: "Error", code: "EIO" }]
      }
    });
    expect(mocks.writeEntry).toHaveBeenCalledTimes(1);
  });
});

describe("recall-eval diagnostics resource acquisition", () => {
  it("acquires the diagnostics spool before context resources", async () => {
    await runRecallEval(options());

    expect(mocks.events.slice(0, 2)).toEqual(["spool", "context"]);
  });

  it("disposes an acquired spool when context acquisition fails", async () => {
    mocks.prepareContext.mockImplementationOnce(async () => {
      mocks.events.push("context");
      throw new Error("synthetic context acquisition failure");
    });

    await expect(runRecallEval(options())).rejects.toThrow(
      "synthetic context acquisition failure"
    );
    expect(mocks.events).toEqual(["spool", "context"]);
    expect(mocks.dispose).toHaveBeenCalledTimes(1);
    expect(mocks.finalizeOwnedRoot).not.toHaveBeenCalled();
  });
});

function resetHarnessState(): void {
  vi.clearAllMocks();
  mocks.captureCommitted = false;
  mocks.events.length = 0;
  mocks.profileEnabled = false;
  mocks.profileFailures.length = 0;
  mocks.profileSample.mockResolvedValue(undefined);
  mocks.shutdown.mockResolvedValue(undefined);
  mocks.dispose.mockResolvedValue(undefined);
  mocks.selectionDispose.mockResolvedValue(undefined);
  mocks.finalizeOwnedRoot.mockResolvedValue(undefined);
}

function configureProfileHarness(): void {
  mocks.profileMarkIncomplete.mockImplementation((phase: string, error: unknown) => {
    const failure = {
      phase,
      name: error instanceof Error ? error.name : "UnknownError",
      code: null
    };
    mocks.profileFailures.push(failure);
    return failure;
  });
}

function configureRuntimeHarness(): void {
  mocks.prepareContext.mockImplementation(async (_options, _weights, _env, profile) => {
    mocks.events.push("context");
    return { ...runContext(), memoryProfile: profile };
  });
  mocks.createSpool.mockImplementation(async () => {
    mocks.events.push("spool");
    return spool;
  });
  mocks.append.mockImplementation(async (result: RecallEvalQuestionResult) => {
    expect(mocks.captureCommitted).toBe(true);
    return compact(result);
  });
  mocks.question.mockResolvedValue(fullQuestion());
  mocks.createPager.mockImplementation(() => ({
    open: async () => ({
      ok: true,
      pid: 1,
      mapsHint: {
        pid: 1,
        comm: "stub",
        alaya_db_mappings: 0,
        onnxruntime_mappings: 0
      }
    }),
    recall: async () => {
      mocks.captureCommitted = true;
      return mocks.question();
    },
    close: async () => null,
    pid: 1,
    lastMapsHint: null
  }));
}

function configureArchiveHarness(): void {
  mocks.archive.mockResolvedValue({
    sidecars: [], diagnosticsFilename: "diagnostics.json.gz",
    diagnosticsArtifact: {
      stagedPath: "/tmp/staged", finalPath: "/tmp/final",
      identity: { sha256: "a".repeat(64), bytes: 7 }
    }
  });
  mocks.published.mockImplementation(async (artifact, run) => {
    try {
      return await run();
    } catch (error) {
      await rm(artifact.stagedPath, { force: true });
      throw error;
    }
  });
  mocks.writeEntry.mockResolvedValue({
    kpiPath: "kpi.json", reportPath: "report.md", findingsPath: "findings.md"
  });
}

function enableProfileFailure(phase: string): void {
  mocks.profileEnabled = true;
  mocks.profileSample.mockImplementation(async (sample: { phase: string }) => {
    if (sample.phase === phase) throw new Error(`${phase} profile failure`);
  });
}

function options() {
  return {
    snapshotDbPath: "/tmp/snapshot.sqlite",
    variant: "longmemeval_s" as const,
    historyRoot: "/tmp/history"
  };
}

function runContext() {
  return {
    options: options(),
    manifest: { question_count: 1 },
    window: [{ questionId: "q-1", question: "question" }],
    sidecarQuestionCount: 1,
    dataDirRoot: "/tmp/data",
    ownsDataDirRoot: true,
    policyShape: "stress",
    simulateReport: "none",
    recallOptions: { maxResults: 10, conflictAwareness: true },
    alayaVersion: "0.3.11",
    commitSha7: "1749d78",
    runAt: new Date("2026-08-12T00:00:00.000Z"),
    recallWeightOverrides: undefined,
    daemonLaunch: { embeddingMode: "disabled", embeddingProviderKind: "openai" },
    runtimeAttribution: { embedding_provider_label: "none" },
    datasetSha256: null,
    measurementForQuestion: null,
    extractionAuthority: null,
    derivedEvidenceProjectionRebuild: null,
    warmDerivedSnapshot: null,
    selectionBoundarySpool: { dispose: mocks.selectionDispose },
    querySemanticFactorCache: null,
    memoryProfile: null,
    runtimeAttribution: {},
    sourceExtractionSystemPromptSha256: undefined
  };
}

function fullQuestion(): RecallEvalQuestionResult {
  return {
    questionId: "q-1",
    hitAt1: true, hitAt5: true, hitAt10: true, firstTier: "hot",
    latencyMs: 1, degradationReason: null,
    diagnostics: { candidates: [{ object_id: "large-candidate" }], delivered_results: [] } as
      RecallEvalQuestionResult["diagnostics"],
    tokenMetrics: {} as RecallEvalQuestionResult["tokenMetrics"],
    recallTokenEconomy: null, edgeProposalKpiRows: [], embeddingWarmup: null,
    queryEmbeddingWarmup: null, documentEmbeddingWarmupLatencyMs: null,
    deliveredObjectIds: []
  };
}

function compact(result: RecallEvalQuestionResult): RecallEvalQuestionResult {
  return {
    ...result,
    diagnostics: { ...result.diagnostics, candidates: [] }
  };
}

function eio(): Error {
  return Object.assign(new Error("synthetic cleanup failure"), { code: "EIO" });
}
