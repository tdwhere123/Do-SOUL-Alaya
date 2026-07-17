import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { EdgeProposalKpiEventRow } from "@do-soul/alaya-eval";
import type {
  SoulMemorySearchResponse
} from "@do-soul/alaya-protocol";
import type {
  AlayaDaemonRuntime
} from "@do-soul/alaya";
import type { CoRecallWarmupSummary } from "../embedding/co-recall-warmup.js";
import type { BenchRecallWeightOverrides } from "../recall/recall-weight-overrides.js";
import type { SeedObjectKind } from "../seeding/seed-rotation.js";
import type {
  BenchEmbeddingWarmupOptions,
  BenchEmbeddingWarmupSummary,
  BenchQueryEmbeddingWarmupSummary
} from "../embedding/embedding-warmup.js";
import type {
  BenchReportContextUsageInput,
  BenchSignalSeedInput,
  BenchSynthesisSeedInput,
  CompileSeedBatchResult,
  SeededMemoryResult,
  SeededSynthesisResult
} from "./seed/daemon-seed-types.js";
import type { BenchTokenMetrics } from "../token/token-metrics.js";
export type {
  BenchContextUsageObject,
  BenchReportContextUsageInput,
  BenchSignalSeedInput,
  BenchSynthesisSeedInput,
  CompileSeedBatchResult,
  CompileSeedDropReason,
  CompileSeedSignalDrop,
  SeededMemoryResult,
  SeededSynthesisResult
} from "./seed/daemon-seed-types.js";
export type {
  BenchEmbeddingWarmupOptions,
  BenchEmbeddingWarmupSummary,
  BenchQueryEmbeddingWarmupSummary,
  DrainEmbeddingWarmupPassesInput,
  DrainEmbeddingWarmupPassesResult
} from "../embedding/embedding-warmup.js";
export {
  drainEmbeddingWarmupPasses,
  formatEmbeddingWarmupNotReadyError
} from "../embedding/embedding-warmup.js";
export type { BenchTokenMetrics } from "../token/token-metrics.js";

export interface BenchDaemonOptions {
  readonly dataDirRoot?: string;
  readonly workspaceId?: string;
  readonly runId?: string;
  readonly embeddingMode?: BenchEmbeddingMode;
  // Selects which provider the bench daemon points the embedding subsystem at
  // when embeddingMode === "env". OpenAI is explicit opt-in; the local ONNX
  // provider is the product default. Ignored when embeddingMode is "disabled".
  readonly embeddingProviderKind?: BenchEmbeddingProviderKind;
  readonly recallWeightOverrides?: BenchRecallWeightOverrides;
  readonly reviewerIdentity?: string;
  readonly reviewerToken?: string;
}

export type BenchEmbeddingMode = "disabled" | "env";
export type BenchEmbeddingProviderKind = "openai" | "local_onnx";
export const DEFAULT_BENCH_EMBEDDING_PROVIDER_KIND = "local_onnx" as const;

export interface BenchRecallOptions {
  readonly maxResults?: number;
  readonly conflictAwareness?: boolean;
  readonly referenceTime?: string;
}

export interface BenchEdgeFormationMember {
  readonly memoryId: string;
  readonly sessionId: string;
  readonly formationKey: string;
}

export interface BenchDaemonHandle {
  readonly runtime: AlayaDaemonRuntime;
  readonly mcpClient: Client;
  readonly workspaceId: string;
  readonly runId: string;
  readonly dataDir: string;
  dispatchCli(argv: readonly string[]): Promise<{ exitCode: number; json?: unknown }>;
  recall(
    query: string,
    opts?: BenchRecallOptions
  ): Promise<SoulMemorySearchResponse & { readonly diagnostics?: unknown }>;
  warmEmbeddingCache(
    objectIds: readonly string[],
    opts?: BenchEmbeddingWarmupOptions
  ): Promise<BenchEmbeddingWarmupSummary>;
  warmQueryEmbeddingCache(
    queryTexts: readonly string[]
  ): Promise<BenchQueryEmbeddingWarmupSummary>;
  /**
   * @anchor runEdgePlanePassIfConfigured — bench-only targeted edge-plane drain.
   *
   * Default no-op. When ALAYA_BENCH_RUN_EDGE_PLANE is enabled, drains only the
   * current workspace's BULK_ENRICH worker loop so the graph/edge plane can
   * materialize before recall without advancing unrelated Garden maintenance on
   * sibling workspaces. Shared handle-level seam so runners do not duplicate
   * env parsing or call runtime methods ad hoc.
   */
  runEdgePlanePassIfConfigured(): Promise<void>;
  reportContextUsage(input: BenchReportContextUsageInput): Promise<void>;
  /**
   * @anchor proposeMemory — full propose+review chain
   *
   * Steps (production-correct audit trail, no direct DB write):
   *   1. soul.emit_candidate_signal — signal_kind=potential_preference,
   *      confidence=0.9, raw_payload.excerpt=content. The daemon's
   *      MaterializationRouter synchronously routes by object_kind
   *      (see packages/soul/src/garden/materialization-router/inputs.ts
   *      routeByObjectKind): claim-capable kinds (preference / decision /
   *      constraint / etc.) land in memory_and_claim_draft and persist
   *      both a memory_entry AND a draft claim_form; non-claim kinds
   *      (fact / outcome / reference / task_state) land in
   *      memory_entry_only and persist only the memory_entry.
   *   2. Read SOUL_SIGNAL_MATERIALIZED event from event_log to recover
   *      the durable memory object_id created by the materializer.
   *   3. soul.propose_memory_update — propose adding a domain_tag on the
   *      new memory so the propose+review event chain fires.
   *   4. soul.review_memory_proposal — verdict=accept, identity+token
   *      bound to ALAYA_REVIEWER_IDENTITY / ALAYA_REVIEWER_TOKEN.
   *
   * Returns { memoryId, signalId, proposalId } so callers can build a
   * sidecar keyed on the durable memory object_id (recall pointers carry
   * the same object_id, so scoring is by id equality — never by string
   * preview overlap).
   *
   * The optional objectKind param diversifies the producer chain so
   * bench archives witness BOTH router branches (memory_entry_only +
   * memory_and_claim_draft). Callers rotate the kind across the seed
   * stream so the archive proves derivePrecedenceBasis / claim_status=draft
   * lock / claim_form persistence end-to-end. Default "fact" preserves
   * legacy memory_entry_only behavior for tests that pin the shape.
   * see also: apps/bench-runner/src/harness/seeding/seed-rotation.ts
   */
  proposeMemory(
    content: string,
    evidenceRef: string,
    options?: {
      readonly objectKind?: SeedObjectKind;
      readonly distilledFact?: string;
      // see also: BenchSignalSeedInput.sourceMemoryRefs
      readonly sourceMemoryRefs?: readonly string[];
    }
  ): Promise<SeededMemoryResult>;
  /**
   * @anchor proposeMemoryFromSignal — degraded-path seed tail
   *
   * Seeds one candidate signal as a durable memory_entry through the MCP
   * soul.emit_candidate_signal tool. That handler stamps
   * source = SignalSource.MODEL_TOOL — an agent-style proposal, not a
   * garden extraction. Used ONLY for the no-credentials / extraction-failure
   * fallback, where a full-turn fact genuinely IS an agent-style proposal,
   * so model_tool / inferred is the production-honest source. The
   * credentialled compile path uses proposeMemoriesFromCompileSignals
   * instead so its signals carry source = garden_compile.
   *
   * see also: apps/bench-runner/src/longmemeval/compile-seed.ts
   */
  proposeMemoryFromSignal(
    input: BenchSignalSeedInput
  ): Promise<SeededMemoryResult>;
  /**
   * @anchor proposeMemoriesFromCompileSignals — production-faithful compile seed
   *
   * Seeds a round's production-extracted candidate signals as durable
   * memory_entry rows through the SAME in-process seam production
   * POST_TURN_EXTRACT completion uses: garden-runtime.ts
   * processPostTurnExtractTask calls `input.signalReceiver.receiveSignal` on
   * each compile() signal; this method calls the daemon's own
   * `signalService.receiveSignal` directly.
   *
   * The bench builds each signal with source = SignalSource.GARDEN_COMPILE
   * (which `receiveSignal` preserves on the emitted event) and runs
   * `normalizeSchemaGroundedSignal` — the same normalization the production
   * POST_TURN_EXTRACT path applies — so the bench signal is byte-faithful
   * to the production
   * POST_TURN_EXTRACT signal. soul.emit_candidate_signal would instead
   * hardcode source = model_tool, which downstream toFormationKind maps to
   * `inferred` (confidence base 0.4) rather than `extracted` (0.6), seeding
   * ~33% lower retention than production.
   *
   * Going direct (rather than enqueue -> garden.claim_task ->
   * garden.complete_task) drops the per-turn garden_task rows and the MCP
   * round-trips — pure overhead for a benchmark that already drives Garden
   * deterministically. `receiveSignal`'s return carries
   * `materialization.created_objects`, so the memory_entry object_id is read
   * straight from the result with no event-log scan.
   *
   * Returns one SeededMemoryResult per signal that materialized a durable
   * memory_entry PLUS a per-signal drop ledger for every signal that did not.
   * A signal the MaterializationRouter routed to evidence_only / deferred (no
   * memory_entry) is recorded with reason=candidate_absent; a signal that
   * THREW before creating memory_entry is isolated per-signal and recorded with
   * reason=materialization_drop — one bad pre-materialization signal never
   * aborts its healthy batch-mates. If accept/review fails after memory_entry
   * creation, the harness fails closed because that memory is recallable but
   * absent from the seed sidecar.
   *
   * invariant: seeds.length + dropped.length === inputs.length.
   *
   * see also: apps/bench-runner/src/longmemeval/compile-seed.ts
   * see also: apps/core-daemon/src/garden-runtime.ts processPostTurnExtractTask
   */
  proposeMemoriesFromCompileSignals(
    inputs: readonly BenchSignalSeedInput[]
  ): Promise<CompileSeedBatchResult>;
  /**
   * @anchor proposeSynthesis — session-level L2 synthesis seed
   *
   * Emits one potential_synthesis candidate signal so the L2
   * synthesis_capsule layer is exercised on the no-LLM bench path. The
   * MaterializationRouter routes a potential_synthesis signal with
   * evidence_refs.length >= 2 to synthesisService.create (see
   * packages/soul/src/garden/materialization-router/router.ts route /
   * materializeSynthesis). raw_payload.distilled_fact becomes the synthesis
   * summary via buildDistilledFact.
   *
   * The synthesis summary is a deterministic, LLM-free digest of the
   * session's seeded turn content — the bench never calls an LLM here.
   *
   * see also: apps/bench-runner/src/longmemeval/compile-seed.ts seedSynthesis
   */
  proposeSynthesis(input: BenchSynthesisSeedInput): Promise<SeededSynthesisResult>;
  /**
   * @anchor accrueSessionCoRecall — same-session EARNED co-recall accrual
   *
   * EARNS recalls-tier co_recalled PathRelations among ONE session's member
   * memory ids by driving the PRODUCTION counter gate
   * (PathRelationProposalService.onCoUsage -> accrueCoOccurrence ->
   * co_usage_threshold -> proposeCoRecalled with CO_RECALLED_SEED_PROFILE). A
   * bounded, gold-blind set of adjacent member pairs (planSessionCoRecallWarmup)
   * is replayed `threshold` times so each pair clears the production threshold
   * and mints exactly one co_recalled edge — earned, not minted on sight. The
   * resulting topology is SPARSE: at most BENCH_CO_RECALL_WARMUP_PAIR_CAP edges
   * per session. Faithfully approximates B-1 cross-link's live
   * report_context_usage co-usage, which the bench cannot grow (no attached
   * agent reports usage). The earned edges are ACCEPTED/materialized and
   * recall-eligible at the born band (recall_bias +0.5, active lifecycle).
   *
   * Pair selection uses ONLY session membership in seed order — never
   * gold/answer knowledge.
   *
   * see also: apps/bench-runner/src/harness/embedding/co-recall-warmup.ts planSessionCoRecallWarmup
   * see also: packages/core/src/path-graph/path-relation-proposal-service.ts onCoUsage
   */
  accrueSessionCoRecall(
    memberMemoryIds: readonly string[]
  ): Promise<CoRecallWarmupSummary>;
  /**
   * @anchor accrueCoherenceCoRecall — EXPERIMENT (design S): ingestion-time
   * coheres_with crystallization (ALAYA_EXP_COHERENCE_EDGES).
   *
   * After embedding vectors are warm, crystallizes a SPARSE set of
   * embedding-coherent edges among the question's seeded memory_entry ids by
   * driving the SAME production counter gate as accrueSessionCoRecall
   * (onCoUsage -> co_recalled carrier). Unlike session co-recall, pairs are
   * selected by OBJECT-vs-OBJECT cosine (>= floor) — the gold-blind coherence
   * signal — and (by default) restricted to CROSS-SESSION pairs, so
   * path_expansion can bridge paraphrased cross-session gold the lexical/
   * adjacency topology cannot reach. Sparsified by a per-node cap so the
   * topology stays few-and-high-quality, not a dense vector graph.
   *
   * This is the prototype carrier for a future first-class coheres_with edge
   * kind; recall-side behavior (attention_only, recall_bias +0.5, born-weak)
   * is identical, so the KPI faithfully measures the mechanism.
   *
   * see also: packages/core/src/embedding-recall/service.ts:EmbeddingRecallService.coherentPairKeys
   */
  accrueCoherenceCoRecall(
    members: readonly BenchEdgeFormationMember[],
    options: {
      readonly floor: number;
      readonly capPerNode: number;
      readonly crossSessionOnly: boolean;
    }
  ): Promise<{
    readonly coherentPairs: number;
    readonly keptPairs: number;
    readonly minted: number;
  }>;
  /**
   * Mints sparse answer-relation edges among seeded memory_entry ids whose
   * pooled HQ content-token sets overlap. Requires memory_hq to be pre-filled.
   *
   * see also: packages/core/src/path-graph/hq-answer-overlap.ts
   */
  accrueAnswersWithCoRelevance(
    members: readonly BenchEdgeFormationMember[],
    options: {
      readonly bar: number;
      readonly capPerNode: number;
      readonly crossSessionOnly: boolean;
    }
  ): Promise<{
    readonly coRelevantPairs: number;
    readonly keptPairs: number;
    readonly minted: number;
  }>;
  /**
   * @anchor queryTokenMetrics — event-sourced token-economy reader.
   *
   * Re-reads the bench run's EventLog (the SAME read pattern as
   * readMaterializedMemoryId) and derives the token-economy figures from
   * SOUL_SIGNAL_EMITTED + SOUL_CONTEXT_LENS_ASSEMBLED events. Call it after
   * the seed loop and all recalls so every contributing event is present.
   */
  queryTokenMetrics(): Promise<BenchTokenMetrics>;
  /**
   * @anchor queryEdgeProposalKpiRows — event-sourced edge proposal reader
   * for K3.2 / K3.4 aggregation.
   *
   * Re-reads SOUL_GRAPH_EDGE_PROPOSAL_CREATED + SOUL_GRAPH_EDGE_PROPOSAL_REVIEWED
   * rows from the bench DB. Returns the minimal row shape the aggregator
   * in @do-soul/alaya-eval needs; the bench-runner aggregates them into
   * KpiCore.edge_proposal_rate and KpiCore.edge_proposal_auto_accept.
   *
   * Call after the run completes so every contributing event is durably
   * written.
   *
   * see also: packages/eval/src/metrics/edge-proposal-kpi.ts
   */
  queryEdgeProposalKpiRows(): Promise<readonly EdgeProposalKpiEventRow[]>;
  /**
   * @anchor attachWorkspace — bind the daemon's active workspace/run pair.
   *
   * The bench daemon is long-running across a full bench; per-question
   * isolation is achieved by switching workspaces, not restarting the
   * daemon. Returned handle exposes the same per-workspace method surface
   * (recall, propose*, warm*, query*) as the daemon handle, bound to the
   * workspace it was attached for. Call detach() before binding another
   * workspace.
   *
   * see also: packages/core/src/recall/recall-service.ts (workspace_id filter)
   */
  attachWorkspace(input: {
    readonly workspaceId: string;
    readonly runId: string;
  }): Promise<BenchWorkspaceHandle>;
  shutdown(): Promise<void>;
}

/**
 * @anchor BenchWorkspaceHandle — per-question / per-conversation workspace
 * scoped view of an already-running bench daemon. Calls route through the
 * same daemon resources but read activeContext for workspace_id / run_id.
 */
export interface BenchWorkspaceHandle {
  readonly workspaceId: string;
  readonly runId: string;
  recall: BenchDaemonHandle["recall"];
  warmEmbeddingCache: BenchDaemonHandle["warmEmbeddingCache"];
  warmQueryEmbeddingCache: BenchDaemonHandle["warmQueryEmbeddingCache"];
  reportContextUsage: BenchDaemonHandle["reportContextUsage"];
  proposeMemory: BenchDaemonHandle["proposeMemory"];
  proposeMemoryFromSignal: BenchDaemonHandle["proposeMemoryFromSignal"];
  proposeMemoriesFromCompileSignals: BenchDaemonHandle["proposeMemoriesFromCompileSignals"];
  proposeSynthesis: BenchDaemonHandle["proposeSynthesis"];
  accrueSessionCoRecall: BenchDaemonHandle["accrueSessionCoRecall"];
  accrueCoherenceCoRecall: BenchDaemonHandle["accrueCoherenceCoRecall"];
  accrueAnswersWithCoRelevance: BenchDaemonHandle["accrueAnswersWithCoRelevance"];
  queryTokenMetrics: BenchDaemonHandle["queryTokenMetrics"];
  queryEdgeProposalKpiRows: BenchDaemonHandle["queryEdgeProposalKpiRows"];
  detach(): Promise<void>;
}
