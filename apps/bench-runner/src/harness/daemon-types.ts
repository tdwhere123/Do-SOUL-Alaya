import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { EdgeProposalKpiEventRow } from "@do-soul/alaya-eval";
import type {
  SoulMemorySearchResponse
} from "@do-soul/alaya-protocol";
import type {
  AlayaDaemonRuntime
} from "@do-soul/alaya";
import type { CoRecallWarmupSummary } from "./co-recall-warmup.js";
import type { BenchRecallWeightOverrides } from "./recall-weight-overrides.js";
import type { SeedObjectKind } from "./seed-rotation.js";

export interface BenchDaemonOptions {
  readonly dataDirRoot?: string;
  readonly workspaceId?: string;
  readonly runId?: string;
  readonly embeddingMode?: BenchEmbeddingMode;
  // Selects which provider the bench daemon points the embedding subsystem at
  // when embeddingMode === "env". Default "openai" preserves the historical
  // bench wiring; "local_onnx" drives the on-device ONNX provider so the same
  // harness can exercise both cosine spaces. Ignored when embeddingMode is
  // "disabled". see also: apps/core-daemon/src/daemon-embedding-runtime.ts
  readonly embeddingProviderKind?: BenchEmbeddingProviderKind;
  readonly recallWeightOverrides?: BenchRecallWeightOverrides;
}

export type BenchEmbeddingMode = "disabled" | "env";
export type BenchEmbeddingProviderKind = "openai" | "local_onnx";

export interface SeededMemoryResult {
  /** Durable memory object_id assigned by the signal materializer. */
  readonly memoryId: string;
  /** Signal id that produced the memory (audit trail anchor). */
  readonly signalId: string;
  /** Proposal id created by soul.propose_memory_update on the new memory. */
  readonly proposalId: string;
  /**
   * evidence_capsule object_id the same signal materialized, or null when
   * no evidence row was created. The session-level potential_synthesis seed
   * points its evidence_refs at these real evidence ids.
   */
  readonly evidenceId: string | null;
  /** true iff the source content exceeded SEED_CONTENT_MAX and was truncated. */
  readonly truncated: boolean;
  /** chars clipped from source content; 0 when not truncated. */
  readonly charsClipped: number;
}

/**
 * One session-level synthesis seed input. The bench, after seeding a
 * session's turns, emits one potential_synthesis signal so the L2
 * synthesis_capsule layer is exercised on the no-LLM bench path.
 */
export interface BenchSynthesisSeedInput {
  /** >= 2 real evidence_capsule object_ids the session's turns materialized. */
  readonly evidenceRefs: readonly string[];
  /** Deterministic, LLM-free digest of the session content → synthesis summary. */
  readonly summary: string;
  /** Topic key grouping the synthesis (bench session id). */
  readonly topicKey: string;
}

export interface SeededSynthesisResult {
  /** Durable synthesis_capsule object_id created by SynthesisService.create. */
  readonly synthesisId: string | null;
}

/**
 * Why one compile-seed signal failed to produce a durable memory_entry.
 *
 * - `candidate_absent`: the signal was received and triaged, but the
 *   MaterializationRouter routed it to evidence_only / deferred — no
 *   memory_entry was created. This is an expected sub-threshold outcome, not
 *   an error; it surfaces a seed-quality (candidate-absent) signal.
 * - `materialization_error`: the signal THREW before materializing a
 *   memory_entry. Historically this aborted the whole turn batch (its healthy
 *   batch-mates were lost too — the 1963-signal archive drop); it is now
 *   isolated per-signal so one bad pre-materialization signal never drops its
 *   mates. A failure after memory_entry creation is not a drop: the bench fails
 *   closed so scoring cannot include recallable but unscored seed memories.
 */
export type CompileSeedDropReason = "candidate_absent" | "materialization_error";

/**
 * One per-signal drop record from proposeMemoriesFromCompileSignals. `detail`
 * carries the routing_reason (candidate_absent) or the error message
 * (materialization_error) so the caller can persist a root-causable reason
 * into the run KPI instead of only logging to stderr. Post-materialization
 * accept/review failures throw and abort scoring instead.
 */
export interface CompileSeedSignalDrop {
  readonly reason: CompileSeedDropReason;
  readonly detail: string;
}

/**
 * Result of seeding ONE turn's batch of compile-extracted signals. Carries the
 * materialized seeds AND a per-signal drop ledger so the caller no longer
 * infers drops from a `inputs.length - seeds.length` subtraction (which could
 * not distinguish an expected candidate_absent skip from a thrown
 * materialization error, and which silently lost an entire batch when any one
 * signal threw).
 *
 * invariant: seeds.length + dropped.length === inputs.length. Every input is
 * accounted for exactly once.
 */
export interface CompileSeedBatchResult {
  readonly seeds: readonly SeededMemoryResult[];
  readonly dropped: readonly CompileSeedSignalDrop[];
}

/**
 * One production-extracted candidate signal to seed as a memory_entry.
 *
 * The compile-based LongMemEval seed path (longmemeval/compile-seed.ts) runs
 * each haystack turn through the production OfficialApiGardenProvider.compile,
 * then feeds each resulting CandidateMemorySignal here. signalKind /
 * objectKind are the kinds the production extractor actually chose;
 * distilledFact is the resolved one-assertion fact it produced.
 */
export interface BenchSignalSeedInput {
  /** signal_kind from the production-extracted CandidateMemorySignal. */
  readonly signalKind: string;
  /** object_kind from the production-extracted CandidateMemorySignal. */
  readonly objectKind: string;
  /** confidence from the production-extracted CandidateMemorySignal. */
  readonly confidence: number;
  /** Resolved one-assertion fact → memory_entry.content via buildDistilledFact. */
  readonly distilledFact: string;
  /** The full source turn → evidence_capsule gist/excerpt (non-lossy layer). */
  readonly turnContent: string;
  /** Verbatim triggering span, when the extractor supplied one. */
  readonly matchedText?: string;
  /**
   * The exact raw_payload the production OfficialApiGardenProvider.compile
   * attached to this signal — matched_text / turn_content_excerpt /
   * schema_grounding / detected_object / field_candidates /
   * validation_result. When present it is emitted verbatim so the bench
   * signal is byte-faithful to the production POST_TURN_EXTRACT signal:
   * materialization's buildSignalSummary reads field_candidates[0].value
   * (the matched_text span) and the bench evidence_capsule carries that
   * SAME span, not a richer full-turn excerpt. Absent only on the
   * no-credentials / extraction-failure fallback, where the bench builds a
   * full-turn payload (that path is the degraded one and is labelled so).
   */
  readonly productionRawPayload?: Readonly<Record<string, unknown>>;
  /** Distinct evidence ref so the per-fact materialized object_id stays 1:1. */
  readonly evidenceRef: string;
  /**
   * Monotonic per-turn index within the bench run's daemon. One source turn
   * fans out into N fact signals; every signal of the same turn carries the
   * same turnSeedIndex. The token-economy fold uses it to count one turn's
   * full-turn token size exactly ONCE, not once per fact.
   */
  readonly turnSeedIndex: number;
  /** Which extraction path produced this fact (audit / report disclosure). */
  readonly extractionProvider: "official_api_compile" | "no_credentials_fallback";
  /**
   * @anchor bench-derives-from-injection
   *
   * Memory-entry object_ids whose previous-turn seed this signal derives
   * from. The harness stamps top-level `source_memory_refs = [...]` so
   * materialization-router/router.ts createAllMemoryRefEdges builds derives_from
   * proposals between adjacent turns of the same session. The rule is
   * holistic: any conversational memory system should treat adjacent
   * turns within one session as derives_from neighbors. Empty / absent
   * means no inherited refs (e.g. session's first turn).
   *
   * These refs are first-class CandidateMemorySignal fields, not
   * raw_payload conventions; every memory-creating materialization branch
   * consumes them.
   * see also: packages/soul/src/garden/materialization-router/router.ts
   *   createAllMemoryRefEdges
   */
  readonly sourceMemoryRefs?: readonly string[];
}

export interface BenchContextUsageObject {
  readonly objectId: string;
  readonly objectKind?: string;
  readonly usageStatus: "used" | "skipped" | "not_applicable";
}

export interface BenchReportContextUsageInput {
  readonly deliveryId: string;
  readonly usageState: "used" | "skipped" | "not_applicable";
  readonly usedObjectIds?: readonly string[];
  readonly deliveredObjects?: readonly BenchContextUsageObject[];
  readonly turnIndex?: number;
  readonly turnDigest?: {
    readonly lastMessages: readonly {
      readonly role: string;
      readonly contentExcerpt: string;
    }[];
  };
  readonly reason?: string;
}

/**
 * @anchor BenchTokenMetrics — event-sourced token-economy figures.
 *
 * Every field is DERIVED from the bench run's EventLog, never recomputed
 * ad hoc against in-memory state. The reader (queryTokenMetrics) scans:
 *
 * - SOUL_SIGNAL_EMITTED — every seed signal carries a bench-stamped KPI
 *   block in raw_payload: `bench_full_turn_content` is the verbatim full
 *   ingested turn, `bench_stored_content` is the durable fact the harness
 *   seeded as memory_entry.content, `bench_turn_seed_index` is the source
 *   turn's index. raw_history_tokens counts `bench_full_turn_content`
 *   exactly ONCE per distinct turn index (a turn that fans out into N fact
 *   signals is not counted N times); stored_memory_tokens sums
 *   `bench_stored_content` over every fact signal (each is a distinct
 *   memory_entry). These keys are written on BOTH the credentialled
 *   compile path and the no-credentials fallback, so the figure is correct
 *   regardless of which seed path ran.
 * - SOUL_CONTEXT_LENS_ASSEMBLED — its total_token_estimate is the tokens
 *   actually delivered for one recall. The harness emits this event from
 *   the bench recall path (the bench bypasses ContextLensAssembler).
 *
 * raw_history_tokens   — token size of the full ingested haystack: what an
 *                        agent would otherwise carry as raw context,
 *                        counted once per source turn.
 * stored_memory_tokens — tokens held in the materialized durable memory,
 *                        summed over every seeded fact.
 * recalled_context_tokens_total — tokens delivered summed over all recalls.
 * recall_event_count   — number of SOUL_CONTEXT_LENS_ASSEMBLED events.
 * recalled_context_tokens_mean — total / count (0 when count is 0): the
 *                        tokens an agent receives for ONE recall.
 */
export interface BenchTokenMetrics {
  readonly raw_history_tokens: number;
  readonly stored_memory_tokens: number;
  readonly recalled_context_tokens_total: number;
  readonly recall_event_count: number;
  readonly recalled_context_tokens_mean: number;
  /** Count of SOUL_SIGNAL_EMITTED events the reader derived seeds from. */
  readonly seed_event_count: number;
}

export interface BenchEmbeddingWarmupOptions {
  readonly maxPasses?: number;
}

export interface BenchEmbeddingWarmupSummary {
  readonly status: "not_requested" | "ready";
  readonly expected_count: number;
  readonly ready_count: number;
  readonly ready_rate: number;
  readonly pass_count: number;
  readonly missing_object_ids: readonly string[];
  readonly provider_kind: string | null;
  readonly model_id: string | null;
}

export interface DrainEmbeddingWarmupPassesInput {
  readonly maxPasses: number;
  readonly maxStallPasses: number;
  readonly runPass: () => Promise<void>;
  readonly readSummary: (passCount: number) => Promise<BenchEmbeddingWarmupSummary>;
}

export interface DrainEmbeddingWarmupPassesResult {
  readonly summary: BenchEmbeddingWarmupSummary;
  readonly lastPassError: string | null;
}

export function formatEmbeddingWarmupNotReadyError(
  summary: BenchEmbeddingWarmupSummary,
  lastPassError: string | null
): string {
  const preview = summary.missing_object_ids.slice(0, 5).join(", ");
  return (
    `embedding warm cache not ready after ${summary.pass_count} pass(es): ` +
    `ready=${summary.ready_count} expected=${summary.expected_count} ` +
    `missing=${summary.missing_object_ids.length}` +
    (preview.length === 0 ? "" : ` first_missing=${preview}`) +
    (lastPassError === null ? "" : ` last_error=${lastPassError}`)
  );
}

// invariant: drains by progress against an injected runPass(). For embedding
// warmup, runPass() is runGardenEmbeddingBackfillPass — a targeted
// EMBEDDING_BACKFILL-only drain whose O(n) handler embeds the whole workspace
// hot corpus in one productive pass (no single-Librarian-slot competition with
// other Garden kinds). A pass that raises ready_count resets the stall budget;
// a pass that does not (a stuck or failing embedding) spends one stall unit.
// Exits when ready_count === expected_count, or the stall budget / maxPasses
// ceiling is hit; both guarantee termination on a stuck embedding.
// see also: apps/core-daemon/src/garden-runtime.ts runEmbeddingBackfillPass
export async function drainEmbeddingWarmupPasses(
  input: DrainEmbeddingWarmupPassesInput
): Promise<DrainEmbeddingWarmupPassesResult> {
  let passCount = 0;
  let stallPasses = 0;
  let lastPassError: string | null = null;
  let summary = await input.readSummary(passCount);

  while (
    summary.ready_count < summary.expected_count &&
    passCount < input.maxPasses &&
    stallPasses < input.maxStallPasses
  ) {
    const readyBefore = summary.ready_count;
    try {
      await input.runPass();
      lastPassError = null;
    } catch (error) {
      lastPassError = error instanceof Error ? error.message : String(error);
    }
    passCount++;
    summary = await input.readSummary(passCount);
    stallPasses = summary.ready_count > readyBefore ? 0 : stallPasses + 1;
  }

  return { summary, lastPassError };
}

export interface BenchQueryEmbeddingWarmupSummary {
  readonly status: "not_requested" | "ready";
  readonly requested_count: number;
  readonly ready_count: number;
  readonly cache_hit_count: number;
  readonly provider_requested_count: number;
  readonly missing_count: number;
  readonly provider_kind: string | null;
  readonly model_id: string | null;
  readonly last_error?: string;
}

export interface BenchRecallOptions {
  readonly maxResults?: number;
  readonly conflictAwareness?: boolean;
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
   * see also: apps/bench-runner/src/harness/seed-rotation.ts
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
   * reason=materialization_error — one bad pre-materialization signal never
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
   * see also: apps/bench-runner/src/harness/co-recall-warmup.ts planSessionCoRecallWarmup
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
    members: readonly { readonly memoryId: string; readonly sessionId: string }[],
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
  queryTokenMetrics: BenchDaemonHandle["queryTokenMetrics"];
  queryEdgeProposalKpiRows: BenchDaemonHandle["queryEdgeProposalKpiRows"];
  detach(): Promise<void>;
}
