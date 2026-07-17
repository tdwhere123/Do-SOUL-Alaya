import type {
  BenchPolicyShape,
  BenchSimulateReportMode,
  KpiPayload,
  VerifiedLongMemEvalEvidenceContext
} from "@do-soul/alaya-eval";
import type {
  BenchEmbeddingMode,
  BenchEmbeddingProviderKind
} from "../harness/daemon.js";
import {
  ALAYA_RECALL_WEIGHT_OVERRIDES_ENV,
  formatBenchRecallWeightOverrides,
  resolveBenchRecallWeightOverrides
} from "../harness/recall/recall-weight-overrides.js";
import type { FetchResult } from "./ingestion/fetch.js";
import type { LongMemEvalVariant } from "./ingestion/dataset.js";
import type { QaChatFn } from "./qa/qa-chat.js";
import { finalizeLongMemEvalRun } from "./runner/archive/runner-archive.js";
import {
  runLongMemEvalConcurrent,
  shouldFanOutLongMemEvalWorkers
} from "./runner/runner-concurrency.js";
import { executeLongMemEvalRun } from "./runner/runner-execution.js";
import { prepareLongMemEvalRun } from "./runner/prepare-context.js";
import {
  withLongMemEvalDiagnosticsSpool,
  type LongMemEvalDiagnosticsSpool
} from "./diagnostics/spool.js";
import { assertExpansionRunAuthority } from
  "./promotion/expansion/authority/expansion-run-authority.js";
import type { LongMemEvalExpansionCapability } from
  "./promotion/expansion/expansion-capability.js";
export {
  buildLongMemEvalReportContextUsage,
  buildLongMemEvalSidecarKey,
  deriveLongMemEvalGoldMemoryIds,
  resolveBenchEmbeddingProviderLabel,
  resolveLongMemEvalHitVerdict,
  runLongMemEvalRecallCycle,
  scoreLongMemEvalRecallHits,
  type LongMemEvalBenchRecallResult,
  type LongMemEvalHitScoringInput,
  type LongMemEvalHitScoringResult,
  type LongMemEvalReportSimulationStats,
  type LongMemEvalSidecarEntry
} from "./runner/runner-helpers.js";

export interface LongMemEvalQaRunOption {
  readonly chat: QaChatFn;
  /** Judge chat fn; defaults to `chat` (answer model) when omitted. */
  readonly judgeChat?: QaChatFn;
  readonly answerModel: string;
  readonly judgeModel: string;
}

export interface LongMemEvalRunOptions {
  readonly variant: LongMemEvalVariant;
  readonly limit?: number;
  readonly historyRoot: string;
  readonly dataDir?: string;
  readonly fetchResult?: FetchResult;
  readonly embeddingMode?: BenchEmbeddingMode;
  readonly embeddingProviderKind?: BenchEmbeddingProviderKind;
  readonly policyShape?: BenchPolicyShape;
  readonly simulateReport?: BenchSimulateReportMode;
  readonly weightOverridesJson?: string;
  // Override the pinned-checksum lookup root (test-only). Production
  // callers should leave this undefined so the canonical
  // docs/bench-history/datasets path is used.
  readonly pinnedMetaRoot?: string;
  readonly questionManifest?: string;
  // @anchor longmemeval-offset: skip the first N questions before
  // `limit`. Pairs with process-level sharding in
  // apps/bench-runner/scripts/run-full-public-bench.sh.
  readonly offset?: number;
  // @anchor longmemeval-datadir-root: pin the bench daemon's DB to a fixed
  // directory instead of a throwaway mkdtemp, so the seeded DB can be
  // snapshotted for the recall-eval fast loop. Defaults to undefined (the
  // daemon allocates its own mkdtemp), preserving existing behaviour.
  // see also: apps/bench-runner/src/harness/daemon.ts startBenchDaemon
  //   (dataDirRoot)
  readonly dataDirRoot?: string;
  // @anchor longmemeval-snapshot-out: when set, after the run completes the
  // seeded DB is WAL-checkpointed + copied to this path, and the per-question
  // scoring sidecar + a version-binding manifest are written beside it, so a
  // later recall-eval --snapshot run skips both extraction and
  // materialization. see also: apps/bench-runner/src/longmemeval/snapshot.ts
  readonly snapshotOut?: string;
  // Override the extraction-cache root the run-start preflight validates and
  // the snapshot sidecar records provenance from (test-only). Production
  // callers leave this undefined so the canonical EXTRACTION_CACHE_ROOT is
  // used. Tests point it at an isolated dir so the run validates a hand-built
  // cache + arbitrary model instead of the committed production manifest,
  // decoupling the integration tests from the live extraction model.
  readonly extractionCacheRoot?: string;
  // @anchor longmemeval-qa: end-to-end QA scoring (answer-LLM + LLM-judge over
  // delivered recall). Undefined => zero LLM calls and byte-identical kpi/sidecar.
  readonly qa?: LongMemEvalQaRunOption;
  // @anchor longmemeval-concurrency: process-backed worker count. Each worker
  // owns one daemon process; values > 1 fan out via child CLI processes and
  // merge shard archives into historyRoot.
  readonly concurrency?: number;
  readonly expansionCapability?: LongMemEvalExpansionCapability;
  readonly promotionContractPath?: string;
}

export interface LongMemEvalRunResult {
  readonly slug: string;
  readonly kpiPath: string;
  readonly reportPath: string;
  readonly findingsPath: string;
  readonly diagnosticsPath: string | null;
  readonly payload: KpiPayload;
  readonly evidenceContext: VerifiedLongMemEvalEvidenceContext | null;
}

/**
 * @anchor longmemeval-runner — per-question workspace, seed-then-recall
 *
 * Scoring: object_id sidecar. Each haystack turn is run through the
 * production garden extraction (OfficialApiGardenProvider.compile) into N
 * typed candidate signals, each seeded as a durable memory_entry row via the
 * MCP propose+review chain (see harness/daemon.ts proposeMemoryFromSignal
 * and longmemeval/compile-seed.ts). Every returned memoryId is the durable
 * object_id that soul.recall returns in pointer.object_id, so scoring is by
 * id equality — never by string preview overlap.
 *
 * Hit rule: a recall result is a hit iff it is a memory_entry whose object_id
 * maps in the sidecar to a seed whose hasAnswer === true AND whose sessionId
 * is in question.answer_session_ids. Because one answer turn now seeds N
 * extracted facts, an answer turn maps to N gold object_ids, and a hit means
 * recalling ANY one fact of that answer turn.
 *
 * Synthesis seed: each session also seeds one L2 synthesis_capsule
 * (potential_synthesis -> synthesisService.create). Its durable object_id is
 * tracked in the sidecar under an object-kind namespace so diagnostics can
 * prove it competed in recall without counting it as memory gold.
 *
 * Measurement-basis note: an answer turn seeds N gold objects (the
 * extraction fan-out), not 1. R@K is measured on that basis ("did any
 * extracted fact of the answer turn surface") and is NOT directly
 * comparable to the pre-extraction 110623Z baseline. The first
 * post-extraction full run is the reference baseline for later
 * recall-optimization runs.
 *
 * `active_constraints[]` is an independent governance channel and is
 * recorded in diagnostics only; it is never counted toward R@K.
 *
 * see also: apps/bench-runner/src/harness/daemon.ts — proposeMemoryFromSignal
 * see also: packages/eval/src/reporting/report.ts — report.md "Scoring contract"
 *   section; its LongMemEval-S text must mirror this measurement-basis
 *   note (the report.md prose lives there, not in this package).
 */
export async function runLongMemEval(
  opts: LongMemEvalRunOptions
): Promise<LongMemEvalRunResult> {
  await assertExpansionRunAuthority(opts);
  if (shouldFanOutLongMemEvalWorkers(opts)) {
    return runLongMemEvalConcurrent(opts);
  }
  return withLongMemEvalDiagnosticsSpool((diagnosticsSpool) =>
    runSingleLongMemEval(opts, diagnosticsSpool)
  );
}

async function runSingleLongMemEval(
  opts: LongMemEvalRunOptions,
  diagnosticsSpool: LongMemEvalDiagnosticsSpool
): Promise<LongMemEvalRunResult> {
  const recallWeightOverrides = resolveBenchRecallWeightOverrides({
    cliJson: opts.weightOverridesJson,
    envJson: process.env[ALAYA_RECALL_WEIGHT_OVERRIDES_ENV]
  });
  if (recallWeightOverrides !== undefined) {
    process.stdout.write(
      `[longmemeval weights] ${formatBenchRecallWeightOverrides(recallWeightOverrides)}\n`
    );
  }

  const context = await prepareLongMemEvalRun(
    opts,
    recallWeightOverrides,
    diagnosticsSpool
  );
  const execution = await executeLongMemEvalRun(context);
  return finalizeLongMemEvalRun({
    opts,
    questionsLength: context.questions.length,
    windowLength: context.window.length,
    datasetSha256: context.datasetSha256,
    datasetChecksumSource: context.datasetChecksumSource,
    datasetSourcePath: context.datasetSourcePath,
    releaseEvidenceAuthority: context.releaseEvidenceAuthority,
    selectionContract: context.selectionContract,
    collected: execution.collected,
    extractionStats: context.seedRunner.stats,
    seedFuelInventory: execution.seedFuelInventory,
    alayaVersion: context.alayaVersion,
    commitInfo: context.commitInfo,
    commitSha7: context.commitSha7,
    runAt: context.runAt,
    embeddingProviderLabel: context.embeddingProviderLabel,
    policyShape: context.policyShape,
    simulateReport: context.simulateReport,
    recallWeightOverrides,
    questionFailures: execution.questionFailures,
    failedQuestionIds: execution.failedQuestionIds,
    diagnosticsSpool
  });
}

export type { LongMemEvalVariant };
