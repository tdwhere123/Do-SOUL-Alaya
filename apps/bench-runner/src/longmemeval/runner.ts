import { appendFileSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  RECALL_PIPELINE_VERSION,
  resolveBenchCommitSha7,
  resolveBenchRunnerVersion
} from "../version.js";
import {
  aggregateEdgeProposalAutoAccept,
  aggregateEdgeProposalRate,
  benchArchiveDiscriminator,
  buildDiffVsPrevious,
  diffKpis,
  entrySlug,
  renderFindings,
  renderReport,
  writeEntry,
  type BenchPolicyShape,
  type BenchSimulateReportMode,
  type BenchSplit,
  buildTokenEconomy,
  computeTokenSavedRatio,
  type EdgeProposalKpiEventRow,
  type HistoryLayout,
  type KpiPayload,
  type PerScenarioRow
} from "@do-soul/alaya-eval";
import {
  startBenchDaemon,
  type BenchDaemonHandle,
  type BenchEmbeddingWarmupSummary,
  type BenchEmbeddingMode,
  type BenchEmbeddingProviderKind,
  type BenchQueryEmbeddingWarmupSummary,
  type BenchRecallOptions,
  type BenchReportContextUsageInput,
  type BenchTokenMetrics,
  type BenchWorkspaceHandle
} from "../harness/daemon.js";
import { monotonicElapsedMs, monotonicNowNs } from "../monotonic.js";
import {
  aggregateBenchTokenMetrics,
  assertBenchTokenEconomyContract
} from "../harness/token-economy.js";
import {
  aggregateRecallTokenEconomy,
  extractRecallTokenEconomy
} from "./recall-token-economy.js";
import type { BenchRecallTokenEconomy } from "../harness/recall-diagnostics-schema.js";
import {
  ALAYA_RECALL_WEIGHT_OVERRIDES_ENV,
  formatBenchRecallWeightOverrides,
  resolveBenchRecallWeightOverrides
} from "../harness/recall-weight-overrides.js";
import {
  buildLongMemEvalQualityMetrics,
  buildQuestionDiagnostic,
  rAt5WithProviderReturned,
  renderCompactDiagnosticsSidecar,
  renderDiagnosticsSidecar,
  summarizeLongMemEvalRecallEvidence,
  summarizeLongMemEvalReportSideEffects,
  summarizeProviderStates,
  type LongMemEvalEmbeddingVectorCacheSummary,
  type LongMemEvalQueryEmbeddingCacheSummary,
  type LongMemEvalQuestionDiagnostic,
  type LongMemEvalReportSideEffectSnapshot
} from "./diagnostics.js";
import { writeExternalDiagnosticsArtifact } from "./diagnostics-artifacts.js";
import {
  MemoryGraphEdgeType,
  mapRelationKindToGraphEdgeType
} from "@do-soul/alaya-protocol";
import {
  buildLongMemEvalColdWarmComparisonSidecar,
  LONGMEMEVAL_COLD_WARM_COMPARISON_FILENAME,
  LONGMEMEVAL_DIAGNOSTICS_FILENAME,
  readLatestLongMemEvalOppositeArchive,
  renderLongMemEvalColdWarmComparisonSidecar
} from "./archive-evidence.js";
import {
  isAbstentionQuestionId,
  scoreAbstentionQuestion
} from "./abstention.js";
import { loadDataset, type FetchResult } from "./fetch.js";
import { pairSessionIntoRounds, type LongMemEvalVariant } from "./dataset.js";
import { collectDistinctTurnContents } from "./extraction-fill.js";
import { selectFullRunBaseline } from "./recall-eval-archive.js";
import {
  buildSessionSynthesisInput,
  computeNextTurnSeedRefs,
  createCompileSeedRunner,
  resolveBenchAllowLiveExtraction,
  toSeedExtractionPathKpi,
  type CompileSeedRunner,
  type SessionSeededTurn
} from "./compile-seed.js";
import {
  appendSeedExtractionReleaseBlockerToFindings,
  appendSeedExtractionReleaseBlockerToReport
} from "./seed-extraction-release-blocker.js";
import {
  BENCH_DAEMON_DB_FILENAME,
  RECALL_EVAL_SNAPSHOT_MANIFEST_VERSION,
  checkpointAndCopyBenchDb,
  readSchemaMigrationVersion,
  writeSnapshotManifest,
  writeSnapshotSidecar,
  type LongMemEvalSnapshotQuestion,
  type SnapshotExtractionProvenance
} from "./snapshot.js";
import { readExtractionCacheManifest } from "./extraction-cache-manifest.js";
import { EXTRACTION_CACHE_ROOT } from "./compile-seed.js";
import {
  aggregateQaVerdicts,
  scoreQaQuestion,
  type QaDeliveredCandidate,
  type QaQuestionVerdict
} from "./qa-harness.js";
import type { QaChatFn } from "./qa-chat.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_BENCH_EMBEDDING_MODEL = "text-embedding-3-small";
// Mirrors apps/bench-runner/src/harness/daemon.ts DEFAULT_LOCAL_ONNX_EMBEDDING_MODEL
// so the kpi provider label reflects the on-device model when
// --embedding-provider local_onnx is used (the OPENAI_* env vars describe a
// remote endpoint and do not apply to a local_onnx run).
const DEFAULT_LOCAL_ONNX_EMBEDDING_MODEL =
  "Xenova/paraphrase-multilingual-MiniLM-L12-v2";
const PINNED_META_ROOT = resolve(
  __dirname,
  "../../../../docs/bench-history/datasets"
);
const LONGMEMEVAL_SEED_POLICY = Object.freeze({
  mode: "label_independent_all_fact",
  label_independent: true,
  object_kind: "fact",
  description:
    "LongMemEval public recall evaluation seeds every haystack turn as a factual memory; has_answer labels are used only for scoring sidecars."
});

// End-to-end QA option, shape mirrors cli.ts qaOption (chat fn + model labels).
export interface LongMemEvalQaRunOption {
  readonly chat: QaChatFn;
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
}

export interface LongMemEvalRunResult {
  readonly slug: string;
  readonly kpiPath: string;
  readonly reportPath: string;
  readonly findingsPath: string;
  readonly diagnosticsPath: string | null;
  readonly payload: KpiPayload;
}

export interface LongMemEvalSidecarEntry {
  readonly objectId: string;
  readonly objectKind: "memory_entry" | "synthesis_capsule";
  readonly sessionId: string;
  readonly hasAnswer: boolean;
  // Seeded turn content, carried only when opts.qa is set so the QA harness can
  // stitch delivered recall into answer-model context; off => omitted (no bytes).
  readonly content?: string;
  // Session date (haystack_dates) this turn is from, QA-only. Lets the answer
  // model anchor temporal day-math; recall never reads it.
  readonly eventDate?: string;
}

export interface LongMemEvalHitScoringInput {
  readonly results: readonly {
    readonly object_id: string;
    readonly object_kind?: string;
    readonly relevance_score: number;
  }[];
  readonly sidecar: ReadonlyMap<string, LongMemEvalSidecarEntry>;
  readonly answerSessionIds: ReadonlySet<string>;
}

export interface LongMemEvalHitScoringResult {
  readonly hitAt1: boolean;
  readonly hitAt5: boolean;
  readonly hitAt10: boolean;
  readonly firstTier: "hot" | "warm" | "cold";
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
 * see also: packages/eval/src/report.ts — report.md "Scoring contract"
 *   section; its LongMemEval-S text must mirror this measurement-basis
 *   note (the report.md prose lives there, not in this package).
 */

// @anchor BENCH_PROFILE_TIMER: env-gated per-question phase timer. Default
// OFF; set ALAYA_BENCH_PROFILE=1 to emit one [bench_profile] line per
// question on stderr. Consumed by smoke runs that need to diff per-phase
// distribution (e.g. before/after SQLite tuning). The timer uses
// hrtime.bigint() (ns); rendering converts to ms with one-decimal
// precision. Phases are optional — only those `record`-ed appear in
// the line.
const BENCH_PROFILE_ENV = "ALAYA_BENCH_PROFILE";

function isBenchProfileEnabled(): boolean {
  const raw = process.env[BENCH_PROFILE_ENV];
  if (raw === undefined) return false;
  const normalized = raw.trim().toLowerCase();
  return normalized !== "" && normalized !== "0" && normalized !== "false" && normalized !== "off" && normalized !== "no";
}

interface PhaseTimer {
  readonly tick: () => bigint;
  readonly record: (name: string, started: bigint) => void;
  readonly format: () => string;
}

function createPhaseTimer(): PhaseTimer {
  const samples: Array<{ name: string; ms: number }> = [];
  return {
    tick: () => process.hrtime.bigint(),
    record: (name: string, started: bigint) => {
      const elapsedNs = process.hrtime.bigint() - started;
      const ms = Number(elapsedNs) / 1_000_000;
      samples.push({ name, ms });
    },
    format: () => samples.map((s) => `${s.name}=${s.ms.toFixed(1)}ms`).join(" ")
  };
}

export async function runLongMemEval(
  opts: LongMemEvalRunOptions
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

  const questions = await loadDataset(opts.variant, {
    dataDir: opts.dataDir,
    pinnedMetaRoot: opts.pinnedMetaRoot
  });
  // The run-start preflight (createCompileSeedRunner) and the snapshot sidecar
  // provenance both read this cache root. Default to the canonical production
  // cache; a test override points it at an isolated dir.
  const extractionCacheRoot = opts.extractionCacheRoot ?? EXTRACTION_CACHE_ROOT;
  const offset = Math.max(0, opts.offset ?? 0);
  const sliceEnd =
    opts.limit !== undefined ? offset + opts.limit : questions.length;
  const window = questions.slice(offset, sliceEnd);

  const alayaVersion = resolveBenchRunnerVersion();
  const commitSha7 = resolveCommitSha7();
  const runAt = new Date();
  const embeddingProviderLabel = resolveBenchEmbeddingProviderLabel(
    opts.embeddingMode ?? "disabled",
    process.env,
    opts.embeddingProviderKind ?? "openai"
  );
  const policyShape = opts.policyShape ?? "stress";
  const simulateReport = opts.simulateReport ?? "none";
  const recallOptions = recallOptionsForPolicyShape(policyShape);

  type WorkerResult = {
    questionId: string;
    hitAt1: boolean;
    hitAt5: boolean;
    hitAt10: boolean;
    // Full-gold coverage counters (see runOneQuestion): goldTotal is this
    // question's gold-memory count (0 for abstention), goldInTop{5,10} how many
    // of them ranked within the window. Aggregated into full_gold_at_k KPIs.
    goldTotal: number;
    goldInTop5: number;
    goldInTop10: number;
    firstTier: "hot" | "warm" | "cold";
    latencyMs: number;
    degradationReason: string | null;
    seedTurnsTruncated: number;
    answerTurnsTruncated: number;
    seedCharsClipped: number;
    diagnostics: LongMemEvalQuestionDiagnostic;
    embeddingWarmup: BenchEmbeddingWarmupSummary | null;
    queryEmbeddingWarmup: BenchQueryEmbeddingWarmupSummary | null;
    reportUsageStats: LongMemEvalReportSimulationStats;
    reportSideEffectSnapshot: LongMemEvalReportSideEffectSnapshot;
    tokenMetrics: BenchTokenMetrics;
    // Per-recall structural token-economy sample from
    // recallResult.diagnostics.token_economy. Null when the degraded
    // recall path (any non-null degradation_reason) omits the
    // token_economy block in core, so the bench extractor returns null
    // and the run-level aggregator drops the sample before computing
    // distribution stats.
    recallTokenEconomy: BenchRecallTokenEconomy | null;
    // Per-question EventLog rows for the K3.2 / K3.4 edge proposal
    // KPI: SOUL_GRAPH_EDGE_PROPOSAL_CREATED + _REVIEWED. Empty when
    // the run produced no proposals; the aggregator still returns
    // undefined in that case so the KPI omits the block.
    edgeProposalKpiRows: readonly EdgeProposalKpiEventRow[];
    // @anchor longmemeval-snapshot-capture: per-question persisted scoring
    // sidecar, populated only when opts.snapshotOut is set. Undefined on a
    // normal run so the snapshot path adds zero cost.
    snapshotQuestion?: LongMemEvalSnapshotQuestion;
    // End-to-end QA verdict, present only when opts.qa is set (else no LLM call).
    qaVerdict?: QaQuestionVerdict;
  };

  async function runOneQuestion(
    daemon: BenchDaemonHandle,
    question: typeof window[number],
    turnIndex: number,
    seedRunner: CompileSeedRunner
  ): Promise<WorkerResult> {
    // @anchor bench-profile-instrumentation: per-question phase timing,
    // gated by ALAYA_BENCH_PROFILE.
    const profileEnabled = isBenchProfileEnabled();
    const phase = createPhaseTimer();
    const tAttach = phase.tick();
    const workspace: BenchWorkspaceHandle = await daemon.attachWorkspace({
      workspaceId: `lme-${question.question_id.slice(0, 8)}`,
      runId: `run-${question.question_id.slice(0, 8)}`
    });
    phase.record("workspace_attach", tAttach);
    try {
      const tSeedLoop = phase.tick();
      const sidecar = new Map<string, LongMemEvalSidecarEntry>();
      const answerSessionSet = new Set(question.answer_session_ids);
      let seedTurnsTruncated = 0;
      let answerTurnsTruncated = 0;
      let seedCharsClipped = 0;

      let seedIndex = 0;
      // anchor: question-level coherence members. Collects every seeded
      // memory_entry id + its session across ALL sessions, for the
      // experimental ingestion-time coheres_with crystallization
      // (ALAYA_EXP_COHERENCE_EDGES) — cross-session pairs need the full set.
      const coherenceMembers: { memoryId: string; sessionId: string }[] = [];
      for (let si = 0; si < question.haystack_sessions.length; si++) {
        const session = question.haystack_sessions[si];
        const sessionId = question.haystack_session_ids[si] ?? `session-${si}`;
        if (session === undefined) continue;

        // invariant: extract per ROUND (a user message + its assistant
        // response), not per bare message — production POST_TURN_EXTRACT
        // extracts per round and a lone message gives the extractor no
        // context to resolve pronouns/dates. round.hasAnswer is true iff
        // any covered message is answer-bearing, so the sidecar still maps
        // every answer round and recall scoring stays accurate.
        const rounds = pairSessionIntoRounds(session);
        // Per-session turns collected for the L2 synthesis seed below.
        const sessionTurns: SessionSeededTurn[] = [];
        // anchor: same-session co-recall members. Collects every seeded
        // memory_entry id of THIS session in seed order so the post-loop
        // earned co-recall accrual selects co-occurring pairs. Order is
        // session-deterministic (seed order), never gold-derived.
        // see also: apps/bench-runner/src/harness/co-recall-warmup.ts planSessionCoRecallWarmup
        const sessionMemberMemoryIds: string[] = [];
        let sessionHasAnswer = false;
        // anchor: session-adjacent derives_from. Carries the prior turn's
        // seeded memory_entry ids so the next turn's signal carries
        // top-level source_memory_refs.
        // see also: packages/soul/src/garden/materialization-router.ts
        //   createAllMemoryRefEdges
        let previousTurnSeedMemoryIds: readonly string[] = [];
        for (let ri = 0; ri < rounds.length; ri++) {
          const round = rounds[ri];
          if (round === undefined) continue;

          const evidenceRef = `${question.question_id}-s${si}-r${ri}`;
          const seedResult = await seedRunner.seedTurn({
            daemon: workspace,
            turnContent: round.content,
            evidenceRefBase: evidenceRef,
            seedIndex,
            workspaceId: workspace.workspaceId,
            runId: workspace.runId,
            ...(previousTurnSeedMemoryIds.length === 0
              ? {}
              : { sourceMemoryRefs: previousTurnSeedMemoryIds })
          });
          seedIndex += 1;
          if (seedResult.turnTruncated) {
            seedTurnsTruncated += 1;
            seedCharsClipped += seedResult.charsClipped;
            if (round.hasAnswer) {
              answerTurnsTruncated += 1;
            }
          }
          if (round.hasAnswer) {
            sessionHasAnswer = true;
          }
          for (const seed of seedResult.seeds) {
            sidecar.set(buildLongMemEvalSidecarKey("memory_entry", seed.memoryId), {
              objectId: seed.memoryId,
              objectKind: "memory_entry",
              sessionId,
              hasAnswer: round.hasAnswer,
              // QA-only: carry the seeded turn content + its session date so
              // delivered recall can be stitched into answer-model context with a
              // temporal anchor. Off => omitted (byte-identical).
              ...(opts.qa === undefined
                ? {}
                : {
                    content: round.content,
                    ...(question.haystack_dates[si] === undefined
                      ? {}
                      : { eventDate: question.haystack_dates[si] })
                  })
            });
            sessionTurns.push({
              turnContent: round.content,
              evidenceId: seed.evidenceId
            });
            sessionMemberMemoryIds.push(seed.memoryId);
            coherenceMembers.push({ memoryId: seed.memoryId, sessionId });
          }
          // invariant: single-id D-1 fan-out. see also:
          //   apps/bench-runner/src/longmemeval/compile-seed.ts computeNextTurnSeedRefs
          //   apps/bench-runner/src/locomo/runner.ts previousTurnSeedMemoryIds
          previousTurnSeedMemoryIds = computeNextTurnSeedRefs(seedResult);
        }

        // invariant: same-session EARNED co-recall accrual. Drives the
        // production onCoUsage counter gate over a bounded gold-blind pair set
        // so THIS session earns a SPARSE set of recalls-tier co_recalled
        // PathRelations (at most BENCH_CO_RECALL_WARMUP_PAIR_CAP), mirroring
        // what production grows from B-1 cross-link over live
        // report_context_usage co-usage (which the bench cannot exercise — no
        // attached agent reports usage). Session membership (seed order) is the
        // ONLY pair-selection signal; no gold turn is consulted.
        // see also: apps/bench-runner/src/harness/co-recall-warmup.ts planSessionCoRecallWarmup
        await workspace.accrueSessionCoRecall(sessionMemberMemoryIds);

        // L2 synthesis seed: emit ONE session-level synthesis capsule pointing
        // at this session's real evidence_capsule ids. It is sidecar-tracked
        // for diagnostics, but memory-gold scoring remains memory_entry-only.
        const synthesisInput = buildSessionSynthesisInput({
          topicKey: `${question.question_id}-s${si}`,
          turns: sessionTurns
        });
        if (synthesisInput !== null) {
          const synthesisResult = await workspace.proposeSynthesis(synthesisInput);
          if (synthesisResult.synthesisId !== null) {
            sidecar.set(buildLongMemEvalSidecarKey("synthesis_capsule", synthesisResult.synthesisId), {
              objectId: synthesisResult.synthesisId,
              objectKind: "synthesis_capsule",
              sessionId,
              hasAnswer: sessionHasAnswer
            });
          }
        }
      }

      phase.record("seed_loop", tSeedLoop);

      const tEmbeddingWarmup = phase.tick();
      const embeddingWarmup =
        opts.embeddingMode === "env"
          ? await workspace.warmEmbeddingCache(deriveLongMemEvalMemoryObjectIds(sidecar))
          : null;
      const queryEmbeddingWarmup =
        opts.embeddingMode === "env"
          ? await workspace.warmQueryEmbeddingCache([question.question])
          : null;
      phase.record("embedding_warmup", tEmbeddingWarmup);

      // EXPERIMENT (design S, ALAYA_EXP_COHERENCE_EDGES): ingestion-time
      // coheres_with crystallization. After embedding vectors are warm,
      // crystallize a SPARSE set of cross-session high-cosine edges (co_recalled
      // carrier prototype) so path_expansion can bridge paraphrased
      // cross-session gold. Default OFF => bit-identical. Reverted before merge
      // unless positive on K1.1 AND K4.
      if (
        opts.embeddingMode === "env" &&
        process.env.ALAYA_EXP_COHERENCE_EDGES === "1"
      ) {
        const coherenceSummary = await workspace.accrueCoherenceCoRecall(
          coherenceMembers,
          {
            floor: Number(process.env.ALAYA_EXP_COHERENCE_FLOOR ?? "0.6"),
            capPerNode: Number(process.env.ALAYA_EXP_COHERENCE_CAP ?? "3"),
            crossSessionOnly: process.env.ALAYA_EXP_COHERENCE_XSESSION !== "0"
          }
        );
        console.error(
          `[coherence-edges] q=${question.question_id} ` +
            `coherent=${coherenceSummary.coherentPairs} ` +
            `kept=${coherenceSummary.keptPairs} minted=${coherenceSummary.minted}`
        );
      }

      const goldMemoryIds = deriveLongMemEvalGoldMemoryIds(sidecar, answerSessionSet);

      const tRecall = phase.tick();
      const recallCycle = await runLongMemEvalRecallCycle({
        daemon: workspace,
        query: question.question,
        recallOptions,
        simulateReport,
        goldMemoryIds,
        turnIndex,
        questionText: question.question
      });
      phase.record("recall", tRecall);
      const recallResult = recallCycle.scoredRecallResult;
      const latencyMs = recallCycle.scoredRecallLatencyMs;
      const results = recallResult.results;
      const activeConstraintResults = (recallResult.active_constraints ?? []).map((constraint, index) => ({
        object_id: constraint.object_id,
        rank: index + 1
      }));
      const deliveredResults = results.slice(0, BENCH_RECALL_MAXK).map((pointer, index) => ({
        object_id: pointer.object_id,
        object_kind: pointer.object_kind,
        rank: index + 1,
        relevance_score: pointer.relevance_score,
        score_factors: pointer.score_factors ?? null
      }));

      // Diagnostic: where do this question's gold memories rank in the full
      // (maxK-capped) recall list? Distinguishes "gold just past rank 10"
      // (coverage) from "gold missing entirely" (ranking miss). Default off.
      if (process.env.ALAYA_BENCH_GOLD_RANK_DUMP !== undefined) {
        const rankById = new Map(results.map((p, i) => [p.object_id, i + 1]));
        const ranks = goldMemoryIds
          .map((id) => rankById.get(id) ?? -1)
          .sort((a, b) => (a < 0 ? 1 : b < 0 ? -1 : a - b));
        const inK = ranks.filter((r) => r > 0).length;
        // Per gold session: the BEST (min) rank among its gold members. A
        // session with no ranked member (best=-1) has NO foothold in the
        // candidate pool, so session-sibling expansion cannot bootstrap it.
        const sessionBest = new Map<string, number>();
        for (const id of goldMemoryIds) {
          const sid =
            sidecar.get(buildLongMemEvalSidecarKey("memory_entry", id))?.sessionId ?? "?";
          const r = rankById.get(id) ?? -1;
          const cur = sessionBest.get(sid);
          if (cur === undefined || (r > 0 && (cur < 0 || r < cur))) sessionBest.set(sid, r);
        }
        const footholds = [...sessionBest.values()].filter((r) => r > 0).length;
        console.error(
          `[gold-rank] q=${question.question_id} sess=${question.answer_session_ids.length} ` +
            `gold=${goldMemoryIds.length} inK=${inK} ranks=[${ranks.join(",")}] ` +
            `sessFootholds=${footholds}/${sessionBest.size} ` +
            `sessBest=[${[...sessionBest.values()].sort((a, b) => (a < 0 ? 1 : b < 0 ? -1 : a - b)).join(",")}]`
        );
      }

      // Diagnostic: dump the FULL ranked candidate pool (content + gold flag +
      // event date + fusion rank) as JSONL for offline re-ranking experiments —
      // tests whether a structural signal can lift gold above co-topical
      // distractors without touching the recall hot path. API-free (recall only).
      // Default off; set ALAYA_BENCH_POOL_DUMP to a writable file path.
      if (process.env.ALAYA_BENCH_POOL_DUMP !== undefined) {
        const goldSet = new Set(goldMemoryIds);
        const candidates = results.map((p, i) => {
          const entry = sidecar.get(buildLongMemEvalSidecarKey("memory_entry", p.object_id));
          return {
            rank: i + 1,
            objectId: p.object_id,
            isGold: goldSet.has(p.object_id),
            sessionId: entry?.sessionId ?? null,
            eventDate: entry?.eventDate ?? null,
            content: (entry?.content ?? "").replace(/\s+/gu, " ").slice(0, 400)
          };
        });
        appendFileSync(
          process.env.ALAYA_BENCH_POOL_DUMP,
          JSON.stringify({
            questionId: question.question_id,
            questionType: question.question_type,
            question: question.question,
            questionDate: question.question_date,
            goldAnswer: question.answer,
            goldCount: goldMemoryIds.length,
            poolSize: results.length,
            candidates
          }) + "\n"
        );
      }

      // End-to-end QA scoring: answer-LLM over delivered recall content, then
      // LLM-judge vs gold. Gated on opts.qa so a normal run makes zero LLM calls.
      // Build candidates from delivered top-k memory_entry results in rank order,
      // resolving each id back to its seeded content via the sidecar.
      let qaVerdict: QaQuestionVerdict | undefined;
      if (opts.qa !== undefined) {
        let delivered: QaDeliveredCandidate[] = deliveredResults
          .filter((result) => (result.object_kind ?? "memory_entry") === "memory_entry")
          .map((result) => {
            const entry = sidecar.get(
              buildLongMemEvalSidecarKey("memory_entry", result.object_id)
            );
            return {
              objectId: result.object_id,
              content: entry?.content ?? "",
              ...(entry?.eventDate === undefined ? {} : { eventDate: entry.eventDate })
            };
          });
        // Diagnostic oracle: replace delivered recall with ONLY the materialized
        // gold memories (no distractors), to test whether the materialized gold
        // is sufficient for the answer model — isolates ingestion-drop from recall
        // ranking/noise. Gold not materialized at ingestion is absent here too.
        if (process.env.ALAYA_BENCH_DELIVER_GOLD_ONLY !== undefined) {
          delivered = goldMemoryIds.map((id) => {
            const entry = sidecar.get(buildLongMemEvalSidecarKey("memory_entry", id));
            return {
              objectId: id,
              content: entry?.content ?? "",
              ...(entry?.eventDate === undefined ? {} : { eventDate: entry.eventDate })
            };
          });
        }
        // Diagnostic: session-cohort QA delivery. Anchor on the top-N recall
        // results, then deliver every materialized fact whose session appears
        // among those anchors (capped) — tests whether gathering session-coherent
        // context recovers the scattered multi-fact gold (offline: top-5 gold
        // coverage 32%->79%). Needs a wide recall pool (ALAYA_BENCH_RECALL_MAXK).
        // Mutually exclusive with the gold-only oracle; default off.
        if (
          process.env.ALAYA_BENCH_QA_SESSION_COHORT !== undefined &&
          process.env.ALAYA_BENCH_DELIVER_GOLD_ONLY === undefined
        ) {
          const anchorN = Math.max(
            1,
            Math.floor(Number(process.env.ALAYA_BENCH_QA_SESSION_COHORT) || 5)
          );
          const cohortCap = 60;
          const sessionOf = (id: string): string | null =>
            sidecar.get(buildLongMemEvalSidecarKey("memory_entry", id))?.sessionId ?? null;
          const anchorSessions = new Set(
            results
              .slice(0, anchorN)
              .map((pointer) => sessionOf(pointer.object_id))
              .filter((session): session is string => session !== null)
          );
          delivered = results
            .filter((pointer) => {
              const session = sessionOf(pointer.object_id);
              return session !== null && anchorSessions.has(session);
            })
            .slice(0, cohortCap)
            .map((pointer) => {
              const entry = sidecar.get(
                buildLongMemEvalSidecarKey("memory_entry", pointer.object_id)
              );
              return {
                objectId: pointer.object_id,
                content: entry?.content ?? "",
                ...(entry?.eventDate === undefined ? {} : { eventDate: entry.eventDate })
              };
            });
        }
        // Diagnostic: route-B proxy — session-CONSOLIDATION delivery. Offline sim
        // (route-b-is-consolidation-not-rerank) showed a summary node packing a
        // whole session's facts into one slot lifts gold coverage@5 39%->91%,
        // because multi-fact gold (mean 5.5/q) can't fit 5 raw-fact slots but does
        // fit as ~2.6-gold-per-session summary blocks. Unlike the flood cohort
        // (60 raw scattered facts, hurt QA), this delivers K DENSE, coherent,
        // dated per-session blocks. Faithful proxy for production route B
        // (synthesis_capsule consolidation) without touching the recall hot path.
        // Value = K session blocks; per-session fact cap keeps each block dense.
        // Mutually exclusive with gold-only and session-cohort. Default off.
        if (
          process.env.ALAYA_BENCH_QA_SESSION_DIGEST !== undefined &&
          process.env.ALAYA_BENCH_DELIVER_GOLD_ONLY === undefined &&
          process.env.ALAYA_BENCH_QA_SESSION_COHORT === undefined
        ) {
          const sessionsK = Math.max(
            1,
            Math.floor(Number(process.env.ALAYA_BENCH_QA_SESSION_DIGEST) || 6)
          );
          const factsPerSession = 8;
          const metaOf = (id: string) =>
            sidecar.get(buildLongMemEvalSidecarKey("memory_entry", id));
          // Group recall pool by session, preserving rank order within a session.
          const bySession = new Map<
            string,
            { date: string | null; facts: string[]; bestRank: number }
          >();
          results.forEach((pointer, rank) => {
            const meta = metaOf(pointer.object_id);
            const session = meta?.sessionId ?? null;
            if (session === null || meta === undefined) return;
            const content = (meta.content ?? "").trim();
            if (content.length === 0) return;
            const group = bySession.get(session);
            if (group === undefined) {
              bySession.set(session, {
                date: meta.eventDate ?? null,
                facts: [content],
                bestRank: rank
              });
            } else if (group.facts.length < factsPerSession && !group.facts.includes(content)) {
              group.facts.push(content);
            }
          });
          // Top-K sessions by best member rank → one dense dated block each.
          const topSessions = [...bySession.entries()]
            .sort((a, b) => a[1].bestRank - b[1].bestRank)
            .slice(0, sessionsK);
          if (process.env.ALAYA_BENCH_QA_SESSION_DIGEST_LLM !== undefined && opts.qa !== undefined) {
            // Query-focused map-reduce: each session's facts are summarized by the
            // LLM to ONLY the question-relevant facts (dates/names/numbers kept),
            // denoising the raw block before the answer model reduces over them.
            // This is the "intelligent summary node" — compression, not concat.
            const sys =
              "You extract from a set of memories ONLY the facts needed to answer a question. " +
              "Preserve exact dates, names, numbers, and event details verbatim. " +
              "Output a terse bullet list of the relevant facts, each with its date. " +
              "If nothing in these memories is relevant, output exactly: NONE";
            const summaries = await Promise.all(
              topSessions.map(async ([session, group], i) => {
                const user =
                  `Question: ${question.question}\nCurrent date: ${question.question_date}\n` +
                  `Memories recorded on ${group.date ?? "unknown date"}:\n` +
                  group.facts.map((f) => `- ${f}`).join("\n");
                const out = (await opts.qa!.chat(sys, user)).trim();
                return { session, i, date: group.date, out };
              })
            );
            delivered = summaries
              .filter((s) => s.out.length > 0 && !/^none$/iu.test(s.out))
              .map((s) => ({
                objectId: `session-digest-llm-${s.i}-${s.session}`,
                content: s.out,
                ...(s.date === null ? {} : { eventDate: s.date })
              }));
          } else {
            delivered = topSessions.map(([session, group], i) => ({
              objectId: `session-digest-${i}-${session}`,
              content: group.facts.map((f) => `- ${f}`).join("\n"),
              ...(group.date === null ? {} : { eventDate: group.date })
            }));
          }
        }
        qaVerdict = await scoreQaQuestion(
          {
            questionId: question.question_id,
            questionType: question.question_type,
            question: question.question,
            questionDate: question.question_date,
            goldAnswer: question.answer,
            delivered
          },
          opts.qa.chat
        );
        // Diagnostic: dump the actual QA context the answer model saw, to tell
        // a date↔event binding failure (right dates present, wrong fact) from a
        // pure model failure. Default off.
        if (process.env.ALAYA_BENCH_QA_DUMP !== undefined) {
          const ctx = delivered
            .map(
              (c, i) =>
                `   [${i + 1}] date=${c.eventDate ?? "-"} :: ${c.content.replace(/\s+/gu, " ").slice(0, 140)}`
            )
            .join("\n");
          console.error(
            `\n[qa-dump] q=${question.question_id} type=${question.question_type} ` +
              `correct=${qaVerdict.correct}\n  Q: ${question.question}\n  now: ${question.question_date}\n` +
              `  GOLD: ${question.answer}\n  MODEL: ${qaVerdict.modelAnswer.replace(/\s+/gu, " ").slice(0, 240)}\n` +
              `  ctx(${delivered.length}):\n${ctx}`
          );
        }
      }

      // Numerator rule: answerable questions score by id-equality hits;
      // abstention (`_abs`) questions score by calibrated confidence — the
      // top-k must stay below the false-confident threshold. The recall@k
      // denominator stays at the full question count for both.
      const isAbstention = isAbstentionQuestionId(question.question_id);
      const scoredHits = resolveLongMemEvalHitVerdict({
        isAbstention,
        results,
        sidecar,
        answerSessionIds: answerSessionSet
      });
      // Full-gold coverage (distinct from the official-hit hitAt5, which is true
      // when ANY gold session is in top-5). A multi-fact question needs ALL its
      // gold memories delivered; official-hit hides that. goldTotal is 0 for
      // abstention questions (no gold), so those are excluded from coverage.
      const goldRankById = new Map(results.map((p, i) => [p.object_id, i + 1]));
      const goldRanks = goldMemoryIds.map((id) => goldRankById.get(id) ?? -1);
      const goldTotal = goldMemoryIds.length;
      const goldInTop5 = goldRanks.filter((r) => r > 0 && r <= 5).length;
      const goldInTop10 = goldRanks.filter((r) => r > 0 && r <= 10).length;
      const diagnostics = buildQuestionDiagnostic({
        questionId: question.question_id,
        goldMemoryIds,
        answerSessionIds: question.answer_session_ids,
        deliveredResults,
        activeConstraintResults,
        hitAt1: scoredHits.hitAt1,
        hitAt5: scoredHits.hitAt5,
        hitAt10: scoredHits.hitAt10,
        isAbstention,
        degradationReason: recallResult.degradation_reason ?? null,
        recallResult,
        embeddingMode: opts.embeddingMode ?? "disabled"
      });
      const tKpiQuery = phase.tick();
      const reportSideEffectSnapshot =
        await readLongMemEvalReportSideEffectSnapshot(
          question.question_id,
          daemon,
          workspace.workspaceId
        );
      // Event-sourced token-economy figures for this question's run: read
      // back from the EventLog after the seed loop and every recall, so
      // each contributing SOUL_SIGNAL_EMITTED / SOUL_CONTEXT_LENS_ASSEMBLED
      // row is already persisted. Must run before the finally-shutdown.
      const tokenMetrics = await workspace.queryTokenMetrics();
      // Per-recall STRUCTURAL token-economy sample. Pulled directly off
      // the already-parsed BenchRecallDiagnostics. A null here means
      // RecallService skipped the instrument because the recall was
      // degraded (any non-null degradation_reason — warm/cold cascade
      // or recall_explainability_partial), so diagnostics carry no
      // token_economy block. The aggregator drops nulls before the
      // distribution stats so degraded recalls don't dilute the run.
      // see also: packages/core/src/recall-service.ts
      // (computeRecallTokenEconomy call site).
      const recallTokenEconomy = extractRecallTokenEconomy(recallResult);
      // K3.2 / K3.4 edge proposal KPI rows for this question's run:
      // SOUL_GRAPH_EDGE_PROPOSAL_CREATED + _REVIEWED EventLog rows.
      // Read back after seeding + recall so every auto-accept policy
      // decision is durably persisted before aggregation.
      // see also: packages/eval/src/edge-proposal-kpi.ts
      const edgeProposalKpiRows = await workspace.queryEdgeProposalKpiRows();
      phase.record("kpi_query", tKpiQuery);

      return {
        questionId: question.question_id,
        hitAt1: scoredHits.hitAt1,
        hitAt5: scoredHits.hitAt5,
        hitAt10: scoredHits.hitAt10,
        goldTotal,
        goldInTop5,
        goldInTop10,
        firstTier: scoredHits.firstTier,
        latencyMs,
        degradationReason: recallResult.degradation_reason ?? null,
        seedTurnsTruncated,
        answerTurnsTruncated,
        seedCharsClipped,
        diagnostics,
        embeddingWarmup,
        queryEmbeddingWarmup,
        reportUsageStats: recallCycle.reportUsageStats,
        reportSideEffectSnapshot,
        tokenMetrics,
        recallTokenEconomy,
        edgeProposalKpiRows,
        ...(qaVerdict === undefined ? {} : { qaVerdict }),
        ...(opts.snapshotOut === undefined
          ? {}
          : {
              snapshotQuestion: {
                questionId: question.question_id,
                question: question.question,
                answerSessionIds: [...question.answer_session_ids],
                workspaceId: workspace.workspaceId,
                runId: workspace.runId,
                sidecar: [...sidecar.values()].map((entry) => ({
                  objectId: entry.objectId,
                  objectKind: entry.objectKind,
                  sessionId: entry.sessionId,
                  hasAnswer: entry.hasAnswer
                }))
              }
            })
      };
    } finally {
      const tDetach = phase.tick();
      await workspace.detach();
      phase.record("workspace_detach", tDetach);
      if (profileEnabled) {
        process.stderr.write(
          `[bench_profile] question=${question.question_id} ${phase.format()}\n`
        );
      }
    }
  }

  // @anchor longmemeval-sequential: intra-process concurrency races
  // on the process.env mutated by startBenchDaemon (DATA_DIR /
  // ALAYA_CONFIG_DIR / HOME / ALAYA_REVIEWER_*).
  // see also: apps/bench-runner/scripts/run-full-public-bench.sh for
  // safe process-level sharding.
  // invariant: one seed runner for the whole run so the on-disk extraction
  // cache and stats accumulate across every question. Extraction happens at
  // seed time only — never on the recall path below.
  // @anchor longmemeval-daemon-per-run: one bench daemon spans the run;
  // per-question isolation is via daemon.attachWorkspace (BenchDaemonHandle).
  // createCompileSeedRunner() runs a ~1s run-start fail-loud preflight against
  // the extraction cache manifest (model / prompt-sha / coverage); a mismatch
  // throws here instead of silently degrading to a 466h live run.
  // see also: apps/bench-runner/src/longmemeval/compile-seed.ts
  //   preflightExtractionCache
  // @anchor longmemeval-window-containment-preflight: hand the preflight THIS
  // run's flattened question window so it validates window-containment (every
  // turn this run needs has an on-disk fixture) rather than trusting the
  // manifest coverage scalar, which is only relative to the last
  // extraction-fill's window. cross-file: compile-seed.ts preflightExtractionCache
  const requiredTurnContents = collectDistinctTurnContents(window);
  const seedRunner = createCompileSeedRunner({
    requiredTurnContents,
    cacheRoot: extractionCacheRoot,
    ...(resolveBenchAllowLiveExtraction() ? { allowLiveExtraction: true } : {})
  });
  const collected: WorkerResult[] = [];
  // @anchor longmemeval-snapshot-capture: when seeding for a recall-eval
  // snapshot, capture each question's scoring sidecar + workspace ids so they
  // can be persisted beside the DB (the seed loop otherwise discards them).
  const snapshotQuestions: LongMemEvalSnapshotQuestion[] = [];
  const captureSnapshot = opts.snapshotOut !== undefined;
  const benchRunId = `lme-bench-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  // dataDirRoot is pinned (not the daemon's throwaway mkdtemp) when a fixed
  // dataDirRoot is requested OR a snapshot is being produced, so the seeded DB
  // lands at a known path to checkpoint + copy.
  const seedDataDirRoot =
    opts.dataDirRoot ??
    (captureSnapshot
      ? await mkdtemp(join(tmpdir(), "alaya-bench-seed-"))
      : undefined);
  const removeSeedDataDirRoot = opts.dataDirRoot === undefined && captureSnapshot;
  let daemon: BenchDaemonHandle | undefined;
  try {
    daemon = await startBenchDaemon({
      workspaceId: `${benchRunId}-default`,
      runId: `${benchRunId}-default-run`,
      embeddingMode: opts.embeddingMode ?? "disabled",
      ...(opts.embeddingProviderKind === undefined
        ? {}
        : { embeddingProviderKind: opts.embeddingProviderKind }),
      ...(seedDataDirRoot === undefined ? {} : { dataDirRoot: seedDataDirRoot }),
      recallWeightOverrides
    });
    for (let i = 0; i < window.length; i++) {
      const q = window[i];
      if (q === undefined) continue;
      const res = await runOneQuestion(daemon, q, i + 1, seedRunner);
      collected.push(res);
      if (captureSnapshot && res.snapshotQuestion !== undefined) {
        snapshotQuestions.push(res.snapshotQuestion);
      }
      process.stdout.write(
        `[${i + 1}/${window.length}] ${q.question_id.slice(0, 8)} ` +
          `R@5=${res.hitAt5 ? "✓" : "✗"} latency=${res.latencyMs}ms\n`
      );
    }
    // @anchor longmemeval-seed-then-snapshot: emit the recall-eval snapshot
    // while the daemon DB connection is still open, so wal_checkpoint flushes
    // every committed frame before the file copy. Runs only with --snapshot-out.
    if (opts.snapshotOut !== undefined && seedDataDirRoot !== undefined) {
      writeRecallEvalSnapshot({
        snapshotOut: opts.snapshotOut,
        seedDataDirRoot,
        variant: opts.variant,
        commitSha7,
        snapshotQuestions,
        extractionCacheRoot
      });
      process.stdout.write(
        `[longmemeval snapshot] wrote ${snapshotQuestions.length} questions -> ${opts.snapshotOut}\n`
      );
    }
  } finally {
    try {
      await daemon?.shutdown();
    } finally {
      if (removeSeedDataDirRoot && seedDataDirRoot !== undefined) {
        await rm(seedDataDirRoot, { recursive: true, force: true });
      }
    }
  }
  const extractionStats = seedRunner.stats;
  // Disclose which seed path ran: official_api_compile (production garden
  // extraction) vs no_credentials_fallback (degraded full-turn single-fact).
  process.stdout.write(
    `[longmemeval compile-seed] path=${extractionStats.path} ` +
      `cache_hits=${extractionStats.cacheHits} ` +
      `llm_calls=${extractionStats.llmCalls} ` +
      `offline_fallbacks=${extractionStats.offlineFallbacks} ` +
      `facts=${extractionStats.factsProduced} ` +
      `signals_dropped=${extractionStats.signalsDropped}\n`
  );

  const perScenario: PerScenarioRow[] = [];
  const latencies: number[] = [];
  let tierHot = 0;
  let tierWarm = 0;
  let tierCold = 0;
  let degradeNone = 0;
  let degradeWarm = 0;
  let degradeCold = 0;
  let degradePartial = 0;
  let totalHitAt1 = 0;
  let totalHitAt10 = 0;
  // Full-gold coverage accumulators (over questions with gold; abstention has
  // none). fullGoldQuestions counts the denominator; fullGoldAt{5,10} count
  // questions where EVERY gold memory landed in the window; coverage{5,10}Sum
  // sums the per-question delivered fraction for a mean.
  let fullGoldQuestions = 0;
  let fullGoldAt5 = 0;
  let fullGoldAt10 = 0;
  let coverage5Sum = 0;
  let coverage10Sum = 0;
  let truncSeedTotal = 0;
  let truncAnswerTotal = 0;
  let truncCharsTotal = 0;
  let reportsAttempted = 0;
  let reportsUsed = 0;
  let reportsSkipped = 0;
  let reportUsedObjectCount = 0;
  const questionDiagnostics: LongMemEvalQuestionDiagnostic[] = [];
  const tokenMetricsPerQuestion: BenchTokenMetrics[] = [];
  const recallTokenEconomySamples: BenchRecallTokenEconomy[] = [];
  const reportSideEffectSnapshots: LongMemEvalReportSideEffectSnapshot[] = [];
  const embeddingWarmups: BenchEmbeddingWarmupSummary[] = [];
  const queryEmbeddingWarmups: BenchQueryEmbeddingWarmupSummary[] = [];
  // @anchor edge-proposal-rate-per-question: keep per-question row chunks
  // so aggregateEdgeProposalRate can emit the proposals_per_question
  // distribution. K3.2's "40-80/workspace/day" target is uninterpretable
  // off per_workspace_per_day_* alone because the bench harness uses
  // one workspaceId per run. see also: packages/eval/src/kpi-schema.ts.
  // The flat across-questions list is derived by flattening these chunks at
  // the aggregator call site rather than stored a second time.
  const edgeProposalKpiRowsPerQuestion: EdgeProposalKpiEventRow[][] = [];
  // QA verdicts collected only when opts.qa is set; empty otherwise.
  const qaVerdicts: QaQuestionVerdict[] = [];

  for (let i = 0; i < collected.length; i++) {
    const res = collected[i];
    if (res === null || res === undefined) continue;
    questionDiagnostics.push(res.diagnostics);
    if (res.embeddingWarmup !== null) {
      embeddingWarmups.push(res.embeddingWarmup);
    }
    if (res.queryEmbeddingWarmup !== null) {
      queryEmbeddingWarmups.push(res.queryEmbeddingWarmup);
    }
    latencies.push(res.latencyMs);
    if (res.hitAt1) totalHitAt1++;
    if (res.hitAt10) totalHitAt10++;
    if (res.goldTotal > 0) {
      fullGoldQuestions++;
      coverage5Sum += res.goldInTop5 / res.goldTotal;
      coverage10Sum += res.goldInTop10 / res.goldTotal;
      if (res.goldInTop5 === res.goldTotal) fullGoldAt5++;
      if (res.goldInTop10 === res.goldTotal) fullGoldAt10++;
    }
    if (res.firstTier === "hot") tierHot++;
    else if (res.firstTier === "warm") tierWarm++;
    else tierCold++;
    if (res.degradationReason === "warm_cascade_engaged") degradeWarm++;
    else if (res.degradationReason === "cold_cascade_engaged") degradeCold++;
    else if (res.degradationReason === "recall_explainability_partial") degradePartial++;
    else degradeNone++;
    truncSeedTotal += res.seedTurnsTruncated;
    truncAnswerTotal += res.answerTurnsTruncated;
    truncCharsTotal += res.seedCharsClipped;
    reportsAttempted += res.reportUsageStats.reportsAttempted;
    reportsUsed += res.reportUsageStats.reportsUsed;
    reportsSkipped += res.reportUsageStats.reportsSkipped;
    reportUsedObjectCount += res.reportUsageStats.usedObjectCount;
    reportSideEffectSnapshots.push(res.reportSideEffectSnapshot);
    tokenMetricsPerQuestion.push(res.tokenMetrics);
    if (res.recallTokenEconomy !== null) {
      recallTokenEconomySamples.push(res.recallTokenEconomy);
    }
    edgeProposalKpiRowsPerQuestion.push([...res.edgeProposalKpiRows]);
    if (res.qaVerdict !== undefined) {
      qaVerdicts.push(res.qaVerdict);
    }
    perScenario.push({
      id: res.questionId,
      version: 1,
      hit_at_5: res.hitAt5,
      tier: res.firstTier,
      latency_ms: res.latencyMs
    });
  }

  const n = perScenario.length;
  const rAt1 = n === 0 ? 0 : totalHitAt1 / n;
  const rAt5 = n === 0 ? 0 : perScenario.filter((r) => r.hit_at_5).length / n;
  const rAt10 = n === 0 ? 0 : totalHitAt10 / n;
  // Full-gold coverage: the honest multi-fact口径. fullGoldAt5Rate = fraction of
  // gold-bearing questions with EVERY gold memory in top-5 (vs rAt5's any-gold);
  // goldCoverageAt5 = mean delivered-gold fraction. These expose the multi-fact
  // delivery gap the official-hit rAt5 hides. see [[r5-dual-kpi-trap]].
  const fullGoldAt5Rate = fullGoldQuestions === 0 ? 0 : fullGoldAt5 / fullGoldQuestions;
  const fullGoldAt10Rate = fullGoldQuestions === 0 ? 0 : fullGoldAt10 / fullGoldQuestions;
  const goldCoverageAt5 = fullGoldQuestions === 0 ? 0 : coverage5Sum / fullGoldQuestions;
  const goldCoverageAt10 = fullGoldQuestions === 0 ? 0 : coverage10Sum / fullGoldQuestions;
  const latencyP50 = computePercentile(latencies, 50);
  const latencyP95 = computePercentile(latencies, 95);
  const providerSummary = summarizeProviderStates(questionDiagnostics);
  const rAt5EmbeddingReturned = rAt5WithProviderReturned(questionDiagnostics);
  const embeddingVectorCache = summarizeEmbeddingVectorCache(embeddingWarmups);
  const queryEmbeddingCache = summarizeQueryEmbeddingCache(queryEmbeddingWarmups);

  const datasetSize = opts.fetchResult?.questionCount ?? questions.length;
  const pinnedMeta = readLongMemEvalPinnedMeta(
    opts.variant,
    opts.pinnedMetaRoot
  );

  // @anchor variant-to-split: exhaustive Record so a new
  // LongMemEvalVariant without a split mapping is a compile error.
  // see also: packages/eval/src/kpi-schema.ts BenchSplit enum.
  const VARIANT_TO_SPLIT: Record<typeof opts.variant, BenchSplit> = {
    longmemeval_oracle: "longmemeval-oracle",
    longmemeval_s: "longmemeval-s",
    longmemeval_m: "longmemeval-m"
  };
  const split = VARIANT_TO_SPLIT[opts.variant];

  // Event-sourced token economy: aggregate the per-question EventLog-derived
  // figures into one run total, then derive the headline saved ratio.
  const tokenEconomyInput = aggregateBenchTokenMetrics(tokenMetricsPerQuestion);
  // Harness-level contract: a seeded run with no full-turn marker fails closed.
  // see also: apps/bench-runner/src/harness/token-economy.ts assertBenchTokenEconomyContract
  assertBenchTokenEconomyContract("public", tokenEconomyInput);
  const tokenEconomy = buildTokenEconomy(tokenEconomyInput);
  const tokenSavedRatio = computeTokenSavedRatio(tokenEconomyInput);
  // Per-recall STRUCTURAL token-economy distribution (p50/p95/mean
  // across all recall calls in the run). Null when no question produced
  // diagnostics — the KPI omits the block in that case so consumers do
  // not see a zero-filled section that looks like real data.
  const recallTokenEconomy = aggregateRecallTokenEconomy(
    recallTokenEconomySamples
  );
  // K3.2 / K3.4: aggregate edge proposal create/review EventLog rows
  // collected from every per-question bench daemon into one run total.
  // Each aggregator returns undefined when no events were observed —
  // the KPI omits the block in that case (honest reporting).
  const edgeProposalKpiRowsAcrossQuestions = edgeProposalKpiRowsPerQuestion.flat();
  const edgeProposalRate = aggregateEdgeProposalRate(
    edgeProposalKpiRowsAcrossQuestions,
    edgeProposalKpiRowsPerQuestion
  );
  const edgeProposalAutoAccept = aggregateEdgeProposalAutoAccept(
    edgeProposalKpiRowsAcrossQuestions
  );

  // QA accuracy block: emitted only when --qa ran and produced verdicts, so a
  // normal recall run leaves kpi.qa_metrics absent (byte-identical).
  const qaMetrics =
    opts.qa !== undefined && qaVerdicts.length > 0
      ? {
          ...aggregateQaVerdicts(qaVerdicts),
          answer_model: opts.qa.answerModel,
          judge_model: opts.qa.judgeModel
        }
      : undefined;

  const payload: KpiPayload = {
    bench_name: "public",
    split,
    run_at: runAt.toISOString(),
    alaya_commit: commitSha7,
    alaya_version: alayaVersion,
    recall_pipeline_version: RECALL_PIPELINE_VERSION,
    embedding_provider: embeddingProviderLabel,
    chat_provider: "none",
    policy_shape: policyShape,
    simulate_report: simulateReport,
    ...(recallWeightOverrides === undefined
      ? {}
      : { recall_weight_overrides: recallWeightOverrides.summary }),
    seed_policy: LONGMEMEVAL_SEED_POLICY,
    dataset: {
      name: opts.variant,
      size: datasetSize,
      source: "https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned",
      checksum_sha256: pinnedMeta.sha256,
      checksum_source: pinnedMeta.source
    },
    sample_size: datasetSize,
    evaluated_count: window.length,
    harness_mode: "mcp_propose_review",
    kpi: {
      r_at_1: rAt1,
      r_at_5: rAt5,
      r_at_10: rAt10,
      ...(fullGoldQuestions === 0
        ? {}
        : {
            full_gold_coverage: {
              gold_bearing_questions: fullGoldQuestions,
              full_gold_at_5: fullGoldAt5Rate,
              full_gold_at_10: fullGoldAt10Rate,
              gold_coverage_at_5: goldCoverageAt5,
              gold_coverage_at_10: goldCoverageAt10
            }
          }),
      ...(opts.embeddingMode === "env"
        ? {
            r_at_5_overall: rAt5,
            ...(rAt5EmbeddingReturned === undefined
              ? {}
              : { r_at_5_with_embedding_returned: rAt5EmbeddingReturned }),
            provider_returned_rate: providerSummary.provider_returned_rate,
            provider_pending_rate: providerSummary.provider_pending_rate,
            provider_failed_rate: providerSummary.provider_failed_rate,
            provider_not_requested_rate:
              providerSummary.provider_not_requested_rate,
            ...(embeddingVectorCache === null
              ? {}
              : {
                  embedding_vector_cache_ready_rate:
                    embeddingVectorCache.ready_rate
                }),
            ...(queryEmbeddingCache === null
              ? {}
              : {
                  query_embedding_cache_ready_rate:
                    queryEmbeddingCache.ready_rate
                })
          }
        : {}),
      latency_ms_p50: latencyP50,
      latency_ms_p95: latencyP95,
      latency_source: "exact",
      token_saved_ratio_vs_full_prompt: tokenSavedRatio,
      token_economy: tokenEconomy,
      ...(recallTokenEconomy === null
        ? {}
        : { recall_token_economy: recallTokenEconomy }),
      tier_distribution: { hot: tierHot, warm: tierWarm, cold: tierCold },
      degradation_reasons: {
        none: degradeNone,
        warm_cascade_engaged: degradeWarm,
        cold_cascade_engaged: degradeCold,
        recall_explainability_partial: degradePartial
      },
      seed_truncation: {
        seed_turns_truncated: truncSeedTotal,
        answer_turns_truncated: truncAnswerTotal,
        seed_chars_clipped: truncCharsTotal
      },
      seed_extraction_path: toSeedExtractionPathKpi(extractionStats),
      quality_metrics: buildLongMemEvalQualityMetrics(questionDiagnostics),
      ...(edgeProposalRate === undefined
        ? {}
        : { edge_proposal_rate: edgeProposalRate }),
      ...(edgeProposalAutoAccept === undefined
        ? {}
        : { edge_proposal_auto_accept: edgeProposalAutoAccept }),
      ...(qaMetrics === undefined ? {} : { qa_metrics: qaMetrics }),
      per_scenario: perScenario
    }
  };

  const layout: HistoryLayout = { historyRoot: opts.historyRoot };
  // Diff against the latest PASSING full-run entry of the SAME split. Oracle vs
  // S are not comparable retrieval evaluations (Oracle's session filter is
  // no-op, S's is meaningful). See packages/eval/src/history.ts
  // @anchor read-latest-split-aware. selectFullRunBaseline additionally
  // excludes fast-loop recall-eval archives, which share this public/ bucket +
  // passing pointer but never paid extraction/materialization.
  // cross-file: apps/bench-runner/src/longmemeval/recall-eval-archive.ts
  const previous = await selectFullRunBaseline(layout, "public", {
    split: payload.split,
    policyShape,
    simulateReport,
    embeddingProvider: payload.embedding_provider
  });
  const diff = diffKpis(payload, previous);
  payload.diff_vs_previous = buildDiffVsPrevious(
    payload,
    previous,
    previous?.run_at ?? ""
  );
  const slug = entrySlug(
    runAt,
    commitSha7,
    benchArchiveDiscriminator(policyShape, simulateReport)
  );

  const report = appendSeedExtractionReleaseBlockerToReport(
    renderReport(payload, previous, diff),
    payload
  );
  const findings = appendSeedExtractionReleaseBlockerToFindings(
    renderFindings(payload, diff),
    payload
  );
  const reportSideEffects = summarizeLongMemEvalReportSideEffects({
    mode: simulateReport,
    snapshots: reportSideEffectSnapshots
  });
  const scoredRecallEvidence =
    summarizeLongMemEvalRecallEvidence(questionDiagnostics);

  const diagnosticsPayload = {
    schema_version: 1,
    bench_name: "public",
    split,
    run_at: payload.run_at,
    alaya_commit: payload.alaya_commit,
    recall_pipeline_version: payload.recall_pipeline_version,
    embedding_provider: payload.embedding_provider,
    embedding_mode: opts.embeddingMode ?? "disabled",
    policy_shape: policyShape,
    simulate_report: simulateReport,
    report_usage: {
      mode: simulateReport,
      reports_attempted: reportsAttempted,
      reports_used: reportsUsed,
      reports_skipped: reportsSkipped,
      used_object_count: reportUsedObjectCount
    },
    report_side_effects: reportSideEffects,
    scored_recall_evidence: scoredRecallEvidence,
    ...(embeddingVectorCache === null
      ? {}
      : { embedding_vector_cache: embeddingVectorCache }),
    ...(queryEmbeddingCache === null
      ? {}
      : { query_embedding_cache: queryEmbeddingCache }),
    provider_state_summary: providerSummary,
    questions: questionDiagnostics
  } as const;
  const diagnosticsSidecar = renderDiagnosticsSidecar(diagnosticsPayload);
  const diagnosticsArtifactPath = await writeExternalDiagnosticsArtifact({
    historyRoot: opts.historyRoot,
    benchName: "public",
    slug,
    filename: LONGMEMEVAL_DIAGNOSTICS_FILENAME,
    contents: diagnosticsSidecar
  });
  const compactDiagnosticsSidecar = renderCompactDiagnosticsSidecar(
    diagnosticsPayload,
    diagnosticsArtifactPath
  );
  const currentEvidence = {
    report_side_effects: reportSideEffects,
    scored_recall_evidence: scoredRecallEvidence
  };
  const opposite = await readLatestLongMemEvalOppositeArchive({
    layout,
    current: payload
  });
  const comparisonSidecar = renderLongMemEvalColdWarmComparisonSidecar(
    buildLongMemEvalColdWarmComparisonSidecar({
      currentSlug: slug,
      current: payload,
      currentEvidence,
      opposite
    })
  );
  const entry = await writeEntry(layout, "public", slug, payload, report, findings, {
    sidecars: [
      {
        filename: LONGMEMEVAL_DIAGNOSTICS_FILENAME,
        contents: compactDiagnosticsSidecar
      },
      {
        filename: LONGMEMEVAL_COLD_WARM_COMPARISON_FILENAME,
        contents: comparisonSidecar
      }
    ]
  });
  return {
    slug,
    kpiPath: entry.kpiPath,
    reportPath: entry.reportPath,
    findingsPath: entry.findingsPath,
    diagnosticsPath: entry.sidecarPaths[LONGMEMEVAL_DIAGNOSTICS_FILENAME] ?? null,
    payload
  };
}

interface LongMemEvalReportSimulationStats {
  readonly reportsAttempted: number;
  readonly reportsUsed: number;
  readonly reportsSkipped: number;
  readonly usedObjectCount: number;
}

export type LongMemEvalBenchRecallResult = Awaited<
  ReturnType<BenchDaemonHandle["recall"]>
>;

export interface LongMemEvalRecallCycleResult {
  readonly scoredRecallResult: LongMemEvalBenchRecallResult;
  readonly scoredRecallLatencyMs: number;
  readonly reportUsageStats: LongMemEvalReportSimulationStats;
}

export async function runLongMemEvalRecallCycle(input: {
  readonly daemon: Pick<BenchDaemonHandle, "recall" | "reportContextUsage">;
  readonly query: string;
  readonly recallOptions: BenchRecallOptions;
  readonly simulateReport: BenchSimulateReportMode;
  readonly goldMemoryIds: readonly string[];
  readonly turnIndex: number;
  readonly questionText: string;
}): Promise<LongMemEvalRecallCycleResult> {
  if (input.simulateReport === "none") {
    const recallStart = monotonicNowNs();
    const scoredRecallResult = await input.daemon.recall(
      input.query,
      input.recallOptions
    );
    return {
      scoredRecallResult,
      scoredRecallLatencyMs: monotonicElapsedMs(recallStart),
      reportUsageStats: {
        reportsAttempted: 0,
        reportsUsed: 0,
        reportsSkipped: 0,
        usedObjectCount: 0
      }
    };
  }

  const preReportRecallResult = await input.daemon.recall(
    input.query,
    input.recallOptions
  );
  const reportUsage = buildLongMemEvalReportContextUsage({
    simulateReport: input.simulateReport,
    deliveryId: preReportRecallResult.delivery_id,
    results: preReportRecallResult.results,
    goldMemoryIds: input.goldMemoryIds,
    turnIndex: input.turnIndex,
    questionText: input.questionText
  });
  if (reportUsage.reportInput !== null) {
    await input.daemon.reportContextUsage(reportUsage.reportInput);
  }

  const recallStart = monotonicNowNs();
  const scoredRecallResult = await input.daemon.recall(
    input.query,
    input.recallOptions
  );
  return {
    scoredRecallResult,
    scoredRecallLatencyMs: monotonicElapsedMs(recallStart),
    reportUsageStats: reportUsage.stats
  };
}

async function readLongMemEvalReportSideEffectSnapshot(
  questionId: string,
  daemon: Pick<BenchDaemonHandle, "runtime">,
  workspaceId: string
): Promise<LongMemEvalReportSideEffectSnapshot> {
  const status = await daemon.runtime.services.graphHealthService.getStatus(
    workspaceId
  );
  // invariant: memory_graph_edges_by_type aliases the unified path plane
  // (path_relations_by_kind / _total) and must carry every canonical
  // edge_type key (defaulting to 0) so historical-archive deltas keep a stable
  // key set. graphHealthService groups by raw constitution.relation_kind, so
  // a recalls-tier kind (co_recalled / shares_entity / signal_graph_ref) lands
  // under its own key, NOT under "recalls". mapRelationKindToGraphEdgeType folds
  // each kind into its canonical graph edge_type bucket — the SAME fold
  // graph-explore-service applies when it counts inbound recalls — so the
  // archive's recalls_edge_count reflects the recalls TIER (what production
  // grows from B-1 cross-link as co_recalled), not just literal "recalls".
  // Without the fold, the bench co-recall hub's co_recalled paths would be
  // invisible to recalls_edge_count and the plane would read dead again.
  // canonical key set: @do-soul/alaya-protocol MemoryGraphEdgeType.
  // see also: packages/core/src/graph-explore-service.ts (recalls-tier count)
  const byKind: Record<string, number> = Object.fromEntries(
    Object.values(MemoryGraphEdgeType).map((edgeType) => [edgeType, 0])
  );
  for (const [kind, count] of Object.entries(status.path_relations_by_kind)) {
    const edgeType = mapRelationKindToGraphEdgeType(kind);
    byKind[edgeType] = (byKind[edgeType] ?? 0) + count;
  }
  return {
    question_id: questionId,
    workspace_id: status.workspace_id,
    memory_graph_edges_total: status.path_relations_total,
    memory_graph_edges_by_type: byKind,
    recalls_edge_count: byKind.recalls ?? 0,
    path_relations_total: status.path_relations_total,
    latest_path_event_at: status.latest_path_event_at,
    warnings: status.warnings
  };
}

export function buildLongMemEvalReportContextUsage(input: {
  readonly simulateReport: BenchSimulateReportMode;
  readonly deliveryId: string;
  readonly results: readonly {
    readonly object_id: string;
    readonly object_kind?: string;
  }[];
  readonly goldMemoryIds: readonly string[];
  readonly turnIndex: number;
  readonly questionText: string;
}): {
  readonly reportInput: BenchReportContextUsageInput | null;
  readonly stats: LongMemEvalReportSimulationStats;
} {
  if (input.simulateReport === "none") {
    return {
      reportInput: null,
      stats: {
        reportsAttempted: 0,
        reportsUsed: 0,
        reportsSkipped: 0,
        usedObjectCount: 0
      }
    };
  }

  const deliveredResults = input.results.slice(0, 10);
  const deliveredMemoryResults = deliveredResults.filter(isLongMemEvalGoldEligibleResult);
  const deliveredMemoryIds = new Set(deliveredMemoryResults.map((result) => result.object_id));
  const goldIds = new Set(input.goldMemoryIds);
  const deliveredGoldIds = deliveredMemoryResults
    .map((result) => result.object_id)
    .filter((objectId) => goldIds.has(objectId));

  let usedObjectIds: string[] = [];
  if (input.simulateReport === "gold-only") {
    usedObjectIds = deliveredGoldIds;
  } else if (input.simulateReport === "mixed") {
    if (deliveredGoldIds.length > 0) {
      const firstNonGold = deliveredMemoryResults.find(
        (result) => !goldIds.has(result.object_id)
      );
      usedObjectIds =
        firstNonGold === undefined
          ? deliveredGoldIds
          : [...deliveredGoldIds, firstNonGold.object_id];
    } else {
      usedObjectIds =
        deliveredMemoryResults[0] === undefined ? [] : [deliveredMemoryResults[0].object_id];
    }
  } else if (input.simulateReport === "always-used") {
    usedObjectIds =
      deliveredMemoryResults[0] === undefined ? [] : [deliveredMemoryResults[0].object_id];
  }

  const safeUsedObjectIds = usedObjectIds.filter((objectId) => deliveredMemoryIds.has(objectId));
  const usedSet = new Set(safeUsedObjectIds);
  const usageState = safeUsedObjectIds.length > 0 ? "used" : "skipped";
  const reportInput: BenchReportContextUsageInput = {
    deliveryId: input.deliveryId,
    usageState,
    ...(safeUsedObjectIds.length === 0
      ? {}
      : { usedObjectIds: safeUsedObjectIds }),
    deliveredObjects: deliveredResults.map((result) => ({
      objectId: result.object_id,
      objectKind: result.object_kind ?? "memory_entry",
      usageStatus:
        isLongMemEvalGoldEligibleResult(result) &&
        usedSet.has(result.object_id)
          ? "used"
          : "skipped"
    })),
    turnIndex: input.turnIndex,
    turnDigest: {
      lastMessages: [
        {
          role: "user",
          contentExcerpt: truncateExcerpt(input.questionText)
        }
      ]
    },
    reason:
      usageState === "used"
        ? `LongMemEval simulate_report=${input.simulateReport}: reported delivered object usage.`
        : `LongMemEval simulate_report=${input.simulateReport}: no delivered object selected.`
  };

  return {
    reportInput,
    stats: {
      reportsAttempted: 1,
      reportsUsed: usageState === "used" ? 1 : 0,
      reportsSkipped: usageState === "skipped" ? 1 : 0,
      usedObjectCount: safeUsedObjectIds.length
    }
  };
}

export function resolveBenchEmbeddingProviderLabel(
  embeddingMode: BenchEmbeddingMode,
  env: Readonly<Record<string, string | undefined>> = process.env,
  providerKind: BenchEmbeddingProviderKind = "openai"
): string {
  if (embeddingMode === "disabled") {
    return "none";
  }

  // local_onnx is an on-device provider; the OPENAI_* env vars describe a
  // remote endpoint and do not apply. Label it by the resolved local model.
  if (providerKind === "local_onnx") {
    const localModel =
      env.ALAYA_LOCAL_EMBEDDING_MODEL?.trim() || DEFAULT_LOCAL_ONNX_EMBEDDING_MODEL;
    return `local_onnx:${localModel}`;
  }

  const model = env.OPENAI_EMBEDDING_MODEL?.trim() || DEFAULT_BENCH_EMBEDDING_MODEL;
  const providerUrl = env.OPENAI_EMBEDDING_PROVIDER_URL?.trim();
  if (providerUrl === undefined || providerUrl.length === 0) {
    return `openai:${model}`;
  }

  return `${labelEmbeddingProviderUrl(providerUrl)}:${model}`;
}

function labelEmbeddingProviderUrl(providerUrl: string): string {
  try {
    const hostname = new URL(providerUrl).hostname.toLowerCase();
    if (hostname.includes("yunwu")) {
      return "yunwu";
    }
  } catch {
    return "openai-compatible";
  }

  return "openai-compatible";
}

/**
 * Diagnostic-only delivery breadth. Default 10 reproduces production口径; an
 * env override widens recall delivery + the QA context to test whether
 * multi-fact (e.g. temporal) questions fail because the needed gold facts sit
 * just past rank 10 (a coverage problem) vs a genuine ranking miss. Does NOT
 * touch fusion weights.
 */
const BENCH_RECALL_MAXK =
  Math.max(10, Math.floor(Number(process.env.ALAYA_BENCH_RECALL_MAXK ?? "10")) || 10);

function recallOptionsForPolicyShape(
  policyShape: BenchPolicyShape
): { readonly maxResults: number; readonly conflictAwareness: boolean } {
  return {
    maxResults: BENCH_RECALL_MAXK,
    conflictAwareness: policyShape === "stress"
  };
}

/**
 * @anchor longmemeval-seed-then-snapshot — produce a recall-eval snapshot.
 *
 * Checkpoints + copies the seeded daemon DB to `snapshotOut`, then writes the
 * per-question scoring sidecar + a version-binding manifest beside it. Reads
 * the schema migration version off the live DB and the extraction-cache
 * manifest's provenance so recall-eval can bind the snapshot and inherit
 * gate-only fields. MUST be called before daemon.shutdown() (the DB connection
 * must be open for the checkpoint).
 *
 * see also: apps/bench-runner/src/longmemeval/snapshot.ts
 * see also: apps/bench-runner/src/longmemeval/recall-eval.ts (consumer)
 */
function writeRecallEvalSnapshot(input: {
  readonly snapshotOut: string;
  readonly seedDataDirRoot: string;
  readonly variant: LongMemEvalVariant;
  readonly commitSha7: string;
  readonly snapshotQuestions: readonly LongMemEvalSnapshotQuestion[];
  readonly extractionCacheRoot: string;
}): void {
  const liveDbPath = resolve(input.seedDataDirRoot, BENCH_DAEMON_DB_FILENAME);
  const schemaMigrationVersion = readSchemaMigrationVersion(liveDbPath);
  checkpointAndCopyBenchDb(liveDbPath, input.snapshotOut);

  const extractionManifest = readExtractionCacheManifest(input.extractionCacheRoot);
  const extractionProvenance: SnapshotExtractionProvenance | null =
    extractionManifest === undefined
      ? null
      : {
          extraction_model: extractionManifest.extraction_model,
          provider_url: extractionManifest.provider_url,
          system_prompt_sha256: extractionManifest.system_prompt_sha256,
          dataset: extractionManifest.dataset,
          dataset_revision: extractionManifest.dataset_revision,
          ...(extractionManifest.coverage === undefined
            ? {}
            : { coverage: extractionManifest.coverage }),
          ...(extractionManifest.cached_turns === undefined
            ? {}
            : { cached_turns: extractionManifest.cached_turns }),
          ...(extractionManifest.requested_turns === undefined
            ? {}
            : { requested_turns: extractionManifest.requested_turns })
        };

  writeSnapshotSidecar(input.snapshotOut, {
    schema_version: RECALL_EVAL_SNAPSHOT_MANIFEST_VERSION,
    variant: input.variant,
    questions: input.snapshotQuestions
  });
  writeSnapshotManifest(input.snapshotOut, {
    schema_version: RECALL_EVAL_SNAPSHOT_MANIFEST_VERSION,
    variant: input.variant,
    question_count: input.snapshotQuestions.length,
    recall_pipeline_version: RECALL_PIPELINE_VERSION,
    schema_migration_version: schemaMigrationVersion,
    bench_runner_version: resolveBenchRunnerVersion(),
    alaya_commit: input.commitSha7,
    db_filename: basename(input.snapshotOut),
    sidecar_filename: `${basename(input.snapshotOut)}.sidecar.json`,
    built_at: new Date().toISOString(),
    extraction_provenance: extractionProvenance
  });
}

/**
 * Resolve the per-k hit verdict for one LongMemEval question.
 *
 * Answerable questions keep the byte-identical id-equality scoring of
 * {@link scoreLongMemEvalRecallHits}. Abstention questions are re-scored by
 * calibrated confidence (see longmemeval/abstention.ts): "hit at k" means
 * recall stayed appropriately unconfident across the top-k. `firstTier` is
 * always derived from the actual top-1 relevance_score so tier reporting is
 * unchanged.
 */
export function resolveLongMemEvalHitVerdict(
  input: LongMemEvalHitScoringInput & { readonly isAbstention: boolean }
): LongMemEvalHitScoringResult {
  if (!input.isAbstention) {
    return scoreLongMemEvalRecallHits(input);
  }
  const abstention = scoreAbstentionQuestion({ results: input.results });
  const firstResult = input.results[0];
  return {
    hitAt1: abstention.correctAt1,
    hitAt5: abstention.correctAt5,
    hitAt10: abstention.correctAt10,
    firstTier:
      firstResult === undefined
        ? "cold"
        : inferTier(firstResult.relevance_score)
  };
}

export function scoreLongMemEvalRecallHits(
  input: LongMemEvalHitScoringInput
): LongMemEvalHitScoringResult {
  let hitAt1 = false;
  let hitAt5 = false;
  let hitAt10 = false;
  let firstTier: "hot" | "warm" | "cold" = "cold";

  for (let rank = 0; rank < input.results.length && rank < 10; rank++) {
    const pointer = input.results[rank];
    if (pointer === undefined) continue;
    if (rank === 0) {
      firstTier = inferTier(pointer.relevance_score);
    }
    if (!isLongMemEvalGoldEligibleResult(pointer)) {
      continue;
    }
    const meta = input.sidecar.get(
      buildLongMemEvalSidecarKey("memory_entry", pointer.object_id)
    );
    const isHit =
      meta !== undefined &&
      meta.hasAnswer &&
      input.answerSessionIds.has(meta.sessionId);
    if (isHit) {
      if (rank === 0) hitAt1 = true;
      if (rank < 5) hitAt5 = true;
      hitAt10 = true;
    }
  }

  return { hitAt1, hitAt5, hitAt10, firstTier };
}

function isLongMemEvalGoldEligibleResult(result: Readonly<{
  readonly object_kind?: string | null;
}>): boolean {
  return (result.object_kind ?? "memory_entry") === "memory_entry";
}

export function buildLongMemEvalSidecarKey(
  objectKind: LongMemEvalSidecarEntry["objectKind"],
  objectId: string
): string {
  return `${objectKind}:${objectId}`;
}

export function deriveLongMemEvalGoldMemoryIds(
  sidecar: ReadonlyMap<string, LongMemEvalSidecarEntry>,
  answerSessionIds: ReadonlySet<string>
): readonly string[] {
  return Object.freeze(
    [...sidecar.values()]
      .filter(
        (entry) =>
          entry.objectKind === "memory_entry" &&
          entry.hasAnswer &&
          answerSessionIds.has(entry.sessionId)
      )
      .map((entry) => entry.objectId)
  );
}

function deriveLongMemEvalMemoryObjectIds(
  sidecar: ReadonlyMap<string, LongMemEvalSidecarEntry>
): readonly string[] {
  return Object.freeze(
    [...sidecar.values()]
      .filter((entry) => entry.objectKind === "memory_entry")
      .map((entry) => entry.objectId)
  );
}

function readLongMemEvalPinnedMeta(
  variant: LongMemEvalVariant,
  root?: string
): { readonly sha256: string; readonly source: string } {
  const source = resolve(root ?? PINNED_META_ROOT, `${variant}.meta.json`);
  const parsed = JSON.parse(readFileSync(source, "utf8")) as {
    sha256?: unknown;
  };
  if (typeof parsed.sha256 !== "string" || parsed.sha256.length === 0) {
    throw new Error(`LongMemEval pinned meta missing sha256: ${source}`);
  }
  return { sha256: parsed.sha256, source };
}

function inferTier(relevanceScore: number): "hot" | "warm" | "cold" {
  if (relevanceScore >= 0.7) return "hot";
  if (relevanceScore >= 0.4) return "warm";
  return "cold";
}

function computePercentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)] ?? 0;
}

function summarizeEmbeddingVectorCache(
  summaries: readonly BenchEmbeddingWarmupSummary[]
): LongMemEvalEmbeddingVectorCacheSummary | null {
  const readySummaries = summaries.filter((summary) => summary.status === "ready");
  if (readySummaries.length === 0) {
    return null;
  }

  const expectedCount = readySummaries.reduce(
    (sum, summary) => sum + summary.expected_count,
    0
  );
  const readyCount = readySummaries.reduce(
    (sum, summary) => sum + summary.ready_count,
    0
  );
  const maxPassCount = readySummaries.reduce(
    (max, summary) => Math.max(max, summary.pass_count),
    0
  );

  return {
    expected_count: expectedCount,
    ready_count: readyCount,
    not_ready_count: Math.max(0, expectedCount - readyCount),
    ready_rate: ratio(readyCount, expectedCount),
    max_pass_count: maxPassCount
  };
}

function summarizeQueryEmbeddingCache(
  summaries: readonly BenchQueryEmbeddingWarmupSummary[]
): LongMemEvalQueryEmbeddingCacheSummary | null {
  const readySummaries = summaries.filter((summary) => summary.status === "ready");
  if (readySummaries.length === 0) {
    return null;
  }

  const requestedCount = readySummaries.reduce(
    (sum, summary) => sum + summary.requested_count,
    0
  );
  const readyCount = readySummaries.reduce(
    (sum, summary) => sum + summary.ready_count,
    0
  );
  const cacheHitCount = readySummaries.reduce(
    (sum, summary) => sum + summary.cache_hit_count,
    0
  );
  const providerRequestedCount = readySummaries.reduce(
    (sum, summary) => sum + summary.provider_requested_count,
    0
  );
  const lastError = [...readySummaries].reverse().find((summary) => summary.last_error !== undefined)?.last_error;

  return {
    requested_count: requestedCount,
    ready_count: readyCount,
    not_ready_count: Math.max(0, requestedCount - readyCount),
    ready_rate: ratio(readyCount, requestedCount),
    cache_hit_count: cacheHitCount,
    provider_requested_count: providerRequestedCount,
    ...(lastError === undefined ? {} : { last_error: lastError })
  };
}

function ratio(count: number, total: number): number {
  return total === 0 ? 0 : count / total;
}

function truncateExcerpt(value: string): string {
  return value.length <= 500 ? value : `${value.slice(0, 497)}...`;
}

// see also: apps/bench-runner/src/version.ts

function resolveCommitSha7(): string {
  return resolveBenchCommitSha7();
}

export type { LongMemEvalVariant };
