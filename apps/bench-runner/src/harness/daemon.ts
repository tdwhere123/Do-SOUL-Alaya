import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { resolveBenchRunnerVersion } from "../version.js";
import { type SeedObjectKind } from "./seed-rotation.js";
export { rotatingSeedObjectKind, type SeedObjectKind, BENCH_SEED_ROTATION } from "./seed-rotation.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  CandidateMemorySignalSchema,
  ControlPlaneObjectKind,
  GraphAuditorEventType,
  RecallContextEventType,
  RunMode,
  RunState,
  ScopeClass,
  SignalEventType,
  SignalSource,
  SoulContextLensAssembledPayloadSchema,
  SoulSignalMaterializedPayloadSchema,
  RetentionPolicy,
  SoulMemorySearchResponseSchema,
  TaskObjectSurfaceSchema,
  WorkspaceKind,
  WorkspaceState,
  type CandidateMemorySignal,
  type MemorySearchResult,
  type RecallPolicy,
  type RecallBudgetState,
  type RecallCandidate,
  type RecallScoreFactors,
  type SoulEmitCandidateSignalResponse,
  type SoulActiveConstraint,
  type SoulMemorySearchResponse,
  type SoulRecallStrategyMix,
  type SoulProposeMemoryUpdateResponse,
  type SoulReportContextUsageResponse,
  type SoulReviewMemoryProposalResponse
} from "@do-soul/alaya-protocol";
import type { EdgeProposalKpiEventRow } from "@do-soul/alaya-eval";
import { normalizeSchemaGroundedSignal } from "@do-soul/alaya-soul";
import {
  initDatabase,
  SqliteEventLogRepo,
  SqliteMemoryEmbeddingRepo,
  SqliteRunRepo,
  SqliteWorkspaceRepo
} from "@do-soul/alaya-storage";
import {
  createAlayaDaemonRuntime,
  resolveSecretRef,
  type AlayaDaemonRuntime,
  type ResolveSecretError
} from "@do-soul/alaya";
import { createAlayaMcpServer } from "@do-soul/alaya/mcp-server";
import { createAlayaCliBridge } from "@do-soul/alaya/cli/bridge";
import { registerAlayaCliCommands } from "@do-soul/alaya/cli/register";
import {
  applyBenchRecallWeightOverrides,
  type BenchRecallWeightOverrides
} from "./recall-weight-overrides.js";
import { BenchRecallDiagnosticsSchema } from "./recall-diagnostics-schema.js";
import {
  BENCH_FULL_TURN_CONTENT_KEY,
  BENCH_SEED_MARKER_KEY,
  BENCH_STORED_CONTENT_KEY,
  BENCH_TURN_SEED_INDEX_KEY,
  deriveBenchTokenMetrics
} from "../longmemeval/token-economy.js";

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
   * materialization-router.ts createAllMemoryRefEdges builds derives_from
   * proposals between adjacent turns of the same session. The rule is
   * holistic: any conversational memory system should treat adjacent
   * turns within one session as derives_from neighbors. Empty / absent
   * means no inherited refs (e.g. session's first turn).
   *
   * These refs are first-class CandidateMemorySignal fields, not
   * raw_payload conventions; every memory-creating materialization branch
   * consumes them.
   * see also: packages/soul/src/garden/materialization-router.ts
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
  reportContextUsage(input: BenchReportContextUsageInput): Promise<void>;
  /**
   * @anchor proposeMemory — full propose+review chain
   *
   * Steps (production-correct audit trail, no direct DB write):
   *   1. soul.emit_candidate_signal — signal_kind=potential_preference,
   *      confidence=0.9, raw_payload.excerpt=content. The daemon's
   *      MaterializationRouter synchronously routes by object_kind
   *      (see packages/soul/src/garden/materialization-router.ts
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
   * memory_entry. A signal the MaterializationRouter routed to evidence_only
   * / deferred (no memory_entry) is skipped, so the returned list may be
   * SHORTER than `inputs`; the shortfall is the caller's drop count.
   *
   * see also: apps/bench-runner/src/longmemeval/compile-seed.ts
   * see also: apps/core-daemon/src/garden-runtime.ts processPostTurnExtractTask
   */
  proposeMemoriesFromCompileSignals(
    inputs: readonly BenchSignalSeedInput[]
  ): Promise<readonly SeededMemoryResult[]>;
  /**
   * @anchor proposeSynthesis — session-level L2 synthesis seed
   *
   * Emits one potential_synthesis candidate signal so the L2
   * synthesis_capsule layer is exercised on the no-LLM bench path. The
   * MaterializationRouter routes a potential_synthesis signal with
   * evidence_refs.length >= 2 to synthesisService.create (see
   * packages/soul/src/garden/materialization-router.ts route /
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
   * see also: packages/eval/src/edge-proposal-kpi.ts
   */
  queryEdgeProposalKpiRows(): Promise<readonly EdgeProposalKpiEventRow[]>;
  shutdown(): Promise<void>;
}

const MANAGED_ENV_KEYS = [
  "DATA_DIR",
  "OPENAI_API_KEY",
  "OPENAI_EMBEDDING_MODEL",
  "OPENAI_EMBEDDING_PROVIDER_URL",
  "ALAYA_OPENAI_SECRET_REF",
  "ALAYA_ENABLE_EMBEDDING_SUPPLEMENT",
  "ALAYA_EMBEDDING_PROVIDER",
  "ALAYA_LOCAL_EMBEDDING_CACHE_DIR",
  "ALAYA_LOCAL_EMBEDDING_MODEL",
  "ALAYA_CONFIG_DIR",
  "CODEX_HOME",
  "HOME",
  "ALAYA_REVIEWER_IDENTITY",
  "ALAYA_REVIEWER_TOKEN"
] as const;

type ManagedEnvKey = (typeof MANAGED_ENV_KEYS)[number];

const REVIEWER_IDENTITY = "user:bench-runner";
const REVIEWER_TOKEN = "bench-review-token";
const DEFAULT_BENCH_EMBEDDING_PROVIDER_KIND: BenchEmbeddingProviderKind = "openai";
const DEFAULT_LOCAL_ONNX_EMBEDDING_MODEL = "Xenova/paraphrase-multilingual-MiniLM-L12-v2";
const DEFAULT_BENCH_EMBEDDING_MODEL = "text-embedding-3-small";
const BENCH_EMBEDDING_SCHEMA_VERSION = 1;
const DEFAULT_EMBEDDING_WARMUP_PASSES = 10;
let activeBenchDaemonCount = 0;

export async function startBenchDaemon(
  opts: BenchDaemonOptions = {}
): Promise<BenchDaemonHandle> {
  const workspaceId = opts.workspaceId ?? "bench-workspace-1";
  const runId = opts.runId ?? "bench-run-1";
  const embeddingMode = opts.embeddingMode ?? "disabled";
  const embeddingProviderKind: BenchEmbeddingProviderKind =
    opts.embeddingProviderKind ?? DEFAULT_BENCH_EMBEDDING_PROVIDER_KIND;
  // The bench recall path supplies its own RecallPolicy via policyOverride
  // (see recall(...) below) which bypasses RecallService.buildDefaultPolicy
  // — and therefore bypasses the daemon's defaultPolicyDecorator that
  // otherwise injects fusion_weights.embedding_similarity = 6 in embedding-on
  // mode. To make bench numbers reflect the same fusion as live recall, we
  // mirror the decorator here when embeddingMode === "env": inject the same
  // override into recallWeightOverrides so applyBenchRecallWeightOverrides
  // pushes it into the bench policy's scoring_weight_overrides.
  // In embeddingMode === "disabled" we leave recallWeightOverrides untouched
  // — the embedding-off red line requires bit-identical recall behavior.
  const recallWeightOverrides =
    embeddingMode === "env"
      ? withEmbeddingFusionWeightInjected(opts.recallWeightOverrides)
      : opts.recallWeightOverrides;

  const dataDir =
    opts.dataDirRoot ?? (await mkdtemp(join(tmpdir(), "alaya-bench-")));

  const savedEnv: Partial<Record<ManagedEnvKey, string | undefined>> = {};
  for (const key of MANAGED_ENV_KEYS) {
    savedEnv[key] = process.env[key];
  }

  const effectiveOpenAiSecretRef =
    embeddingMode === "env" && embeddingProviderKind === "openai"
      ? resolveBenchOpenAiSecretRef(savedEnv)
      : "env:OPENAI_API_KEY";
  if (embeddingMode === "env" && embeddingProviderKind === "openai") {
    requireBenchOpenAiSecretRef(effectiveOpenAiSecretRef);
  }
  if (activeBenchDaemonCount > 0) {
    throw new Error(
      "startBenchDaemon supports only one active daemon per process; use process-level shards for LongMemEval parallelism"
    );
  }
  activeBenchDaemonCount++;
  let activeReleased = false;
  const releaseActive = () => {
    if (!activeReleased) {
      activeReleased = true;
      activeBenchDaemonCount = Math.max(0, activeBenchDaemonCount - 1);
    }
  };

  let runtime: AlayaDaemonRuntime | undefined;
  let server: ReturnType<typeof createAlayaMcpServer> | undefined;
  let mcpClient: Client | undefined;
  let dispatchCliFn:
    | ((argv: readonly string[]) => Promise<{ exitCode: number; json?: unknown }>)
    | undefined;

  try {
    process.env.DATA_DIR = dataDir;
    if (embeddingMode === "env") {
      process.env.ALAYA_ENABLE_EMBEDDING_SUPPLEMENT = "true";
      if (embeddingProviderKind === "local_onnx") {
        process.env.ALAYA_EMBEDDING_PROVIDER = "local_onnx";
        // Forward caller-supplied cache dir / model. Either may be unset; the
        // LocalOnnxEmbeddingClient defaults pick a built-in MiniLM model and
        // a transformers.js-managed cache when these are absent.
        if (savedEnv.ALAYA_LOCAL_EMBEDDING_CACHE_DIR !== undefined) {
          process.env.ALAYA_LOCAL_EMBEDDING_CACHE_DIR = savedEnv.ALAYA_LOCAL_EMBEDDING_CACHE_DIR;
        } else {
          delete process.env.ALAYA_LOCAL_EMBEDDING_CACHE_DIR;
        }
        if (savedEnv.ALAYA_LOCAL_EMBEDDING_MODEL !== undefined) {
          process.env.ALAYA_LOCAL_EMBEDDING_MODEL = savedEnv.ALAYA_LOCAL_EMBEDDING_MODEL;
        } else {
          delete process.env.ALAYA_LOCAL_EMBEDDING_MODEL;
        }
        // local_onnx has no API secret; keep the OpenAI secret slot inert so
        // the daemon's openai branch is never accidentally taken.
        process.env.ALAYA_OPENAI_SECRET_REF = "env:OPENAI_API_KEY";
        process.env.OPENAI_API_KEY = "test-openai-key";
      } else {
        delete process.env.ALAYA_EMBEDDING_PROVIDER;
        delete process.env.ALAYA_LOCAL_EMBEDDING_CACHE_DIR;
        delete process.env.ALAYA_LOCAL_EMBEDDING_MODEL;
        process.env.ALAYA_OPENAI_SECRET_REF = effectiveOpenAiSecretRef;
        if (savedEnv.OPENAI_API_KEY === undefined) {
          delete process.env.OPENAI_API_KEY;
        } else {
          process.env.OPENAI_API_KEY = savedEnv.OPENAI_API_KEY;
        }
      }
    } else {
      delete process.env.ALAYA_EMBEDDING_PROVIDER;
      delete process.env.ALAYA_LOCAL_EMBEDDING_CACHE_DIR;
      delete process.env.ALAYA_LOCAL_EMBEDDING_MODEL;
      process.env.ALAYA_OPENAI_SECRET_REF = "env:OPENAI_API_KEY";
      process.env.OPENAI_API_KEY = "test-openai-key";
      process.env.ALAYA_ENABLE_EMBEDDING_SUPPLEMENT = "false";
    }
    process.env.ALAYA_CONFIG_DIR = join(dataDir, "config");
    process.env.CODEX_HOME = join(dataDir, "codex-home");
    process.env.HOME = join(dataDir, "home");
    process.env.ALAYA_REVIEWER_IDENTITY = REVIEWER_IDENTITY;
    process.env.ALAYA_REVIEWER_TOKEN = REVIEWER_TOKEN;

    runtime = await createAlayaDaemonRuntime();
    // The bench daemon deliberately does NOT call runtime.startBackgroundServices().
    // That would start the daemon's autonomous GardenScheduler (a 60s setInterval
    // plus a startup pass), which peekPendings POST_TURN_EXTRACT tasks across all
    // workspaces and would fire mid-seed-loop — racing the bench's explicit
    // in-process compile-signal seed path. A benchmark needs deterministic
    // Garden control: the bench drives
    // every garden task explicitly, and runs an explicit garden background pass
    // via runtime.runGardenBackgroundPass() (e.g. for embedding warmup) after the
    // seed loop completes, when no bench-enqueued task is in flight.
    // runGardenBackgroundPass() does not depend on startBackgroundServices() having
    // run, so suppressing the autonomous interval keeps the explicit path intact.

    server = createAlayaMcpServer({
      memoryToolHandler: runtime.services.mcpMemoryToolHandler,
      contextProvider: () => ({
        workspaceId,
        runId,
        agentTarget: "bench-runner",
        sessionId: `bench-session-${Date.now()}`,
        surfaceId: "bench"
      })
    });

    mcpClient = new Client(
      { name: "alaya-bench-runner", version: resolveBenchRunnerVersion() },
      { capabilities: {} }
    );

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await mcpClient.connect(clientTransport);

    dispatchCliFn = makeDispatchCli(runtime);

    const install = await dispatchCliFn([
      "install",
      "--non-interactive",
      JSON.stringify({
        db_path: join(dataDir, "alaya.db"),
        embedding_enabled: embeddingMode === "env",
        default_workspace: workspaceId,
        worktree_enabled: false
      }),
      "--json"
    ]);
    if (install.exitCode !== 0) {
      throw new Error(`alaya install failed with exitCode=${install.exitCode}`);
    }

    const attach = await dispatchCliFn(["attach", "codex", "--yes", "--json"]);
    if (attach.exitCode !== 0) {
      throw new Error(`alaya attach failed with exitCode=${attach.exitCode}`);
    }

    // @anchor bench-workspace-seed: signals.workspace_id / signals.run_id are
    // FK-constrained to workspaces / runs (migration 003-signals.sql). The
    // install command writes the daemon config but does not create rows in
    // those tables. Seed the bench workspace + run directly so the MCP
    // call context (which binds these ids from the trusted context provider)
    // resolves to existing FK rows.
    // see also: apps/core-daemon/src/__tests__/phase6-agent-use-protocol.test.ts
    //   workspace + run seeding fixture using the same repos.
    await seedBenchWorkspaceAndRun(dataDir, workspaceId, runId);
  } catch (err) {
    try {
      await closeBenchDaemonResources({ mcpClient, server, runtime });
    } finally {
      restoreEnv(savedEnv);
      releaseActive();
    }
    throw err;
  }

  if (
    runtime === undefined ||
    server === undefined ||
    mcpClient === undefined ||
    dispatchCliFn === undefined
  ) {
    restoreEnv(savedEnv);
    releaseActive();
    throw new Error("bench daemon startup did not initialize required resources");
  }

  const activeRuntime = runtime;
  const activeServer = server;
  const activeMcpClient = mcpClient;
  const activeDispatchCli = dispatchCliFn;

  async function recall(
    query: string,
    recallOpts: BenchRecallOptions = {}
  ): Promise<SoulMemorySearchResponse & { readonly diagnostics?: unknown }> {
    const maxResults = recallOpts.maxResults ?? 10;
    const conflictAwareness = recallOpts.conflictAwareness ?? true;
    const taskSurface = TaskObjectSurfaceSchema.parse({
      runtime_id: randomUUID(),
      object_kind: ControlPlaneObjectKind.TASK_OBJECT_SURFACE,
      task_surface_ref: null,
      expires_at: null,
      derived_from: null,
      retention_policy: RetentionPolicy.SESSION_ONLY,
      surface_kind: "bench_recall",
      display_name: query,
      context_refs: []
    });
    const policy = applyBenchRecallWeightOverrides(
      buildBenchDiagnosticRecallPolicy(
        taskSurface.runtime_id,
        maxResults,
        conflictAwareness
      ),
      recallWeightOverrides
    );
    const diagnosticRuntime = activeRuntime as unknown as {
      readonly services: {
        readonly recallService: {
          recall(params: {
            readonly taskSurface: ReturnType<typeof TaskObjectSurfaceSchema.parse>;
            readonly workspaceId: string;
            readonly strategy: "chat";
            readonly runId: string;
            readonly policyOverride: Readonly<RecallPolicy>;
          }): Promise<Readonly<{
            readonly candidates: readonly Readonly<RecallCandidate>[];
            readonly active_constraints: readonly Readonly<SoulActiveConstraint>[];
            readonly active_constraints_count: number;
            readonly fine_assessment_count: number;
            readonly degradation_reason?: SoulMemorySearchResponse["degradation_reason"];
            readonly diagnostics?: unknown;
          }>>;
        };
        readonly trustStateRecorder: {
          recordDelivery(input: {
            readonly delivery_id: string;
            readonly agent_target: string;
            readonly workspace_id: string;
            readonly run_id: string;
            readonly delivered_object_ids: readonly string[];
            readonly delivered_objects?: readonly {
              readonly object_id: string;
              readonly object_kind: string;
            }[];
            readonly delivered_at: string;
          }): Promise<unknown>;
        };
      };
    };
    const recallResult = await diagnosticRuntime.services.recallService.recall({
      taskSurface,
      workspaceId,
      strategy: "chat",
      runId,
      policyOverride: policy
    });
    // usedTokens (the lens event's total_token_estimate) sums only the
    // recalled fact candidates — active constraints are delivered context
    // but are governance rails, not recalled facts, so they are excluded
    // from the token-economy figure by design.
    let usedTokens = 0;
    const activeConstraintIds = new Set(recallResult.active_constraints.map((constraint) => constraint.object_id));
    const resultCandidates = recallResult.candidates
      .filter((candidate) => !activeConstraintIds.has(candidate.object_id))
      .slice(0, maxResults);
    const results = resultCandidates.map((candidate, index) => {
      const result = buildBenchMemorySearchResult(candidate, policy, index, usedTokens);
      usedTokens += candidate.token_estimate;
      return result;
    });
    const deliveryId = `delivery_${randomUUID()}`;
    const deliveredObjects = [
      ...results.map((result) => ({
        object_id: result.object_id,
        object_kind: result.object_kind
      })),
      ...recallResult.active_constraints.map((constraint) => ({
        object_id: constraint.object_id,
        object_kind: constraint.object_kind
      }))
    ];
    await diagnosticRuntime.services.trustStateRecorder.recordDelivery({
      delivery_id: deliveryId,
      agent_target: "bench-runner",
      workspace_id: workspaceId,
      run_id: runId,
      delivered_object_ids: [...new Set(deliveredObjects.map((object) => object.object_id))],
      delivered_objects: [...new Map(
        deliveredObjects.map((object) => [`${object.object_kind}\0${object.object_id}`, object])
      ).values()],
      delivered_at: new Date().toISOString()
    });
    // @anchor bench-lens-event: the bench recall path drives recallService
    // directly and does NOT route through ContextLensAssembler, so the
    // SOUL_CONTEXT_LENS_ASSEMBLED event the production assembler emits is
    // absent here. The token-economy KPI is event-sourced (S6), so the
    // harness emits the SAME event type with the SAME payload schema after
    // each bench recall: total_token_estimate is usedTokens — the summed
    // token_estimate of the candidates actually delivered to the agent
    // (recalled context). It uses the SAME summed-token-estimate
    // construction the production assembler uses, but reuses each recall
    // candidate's pre-computed token_estimate rather than re-estimating a
    // lens-entry snapshot; same estimator and content, so the figures
    // agree. The event is the single source of truth queryTokenMetrics
    // reads back.
    emitBenchContextLensAssembledEvent(dataDir, {
      taskSurfaceRef: taskSurface.runtime_id,
      lensEntryCount: results.length,
      totalTokenEstimate: usedTokens,
      runId,
      workspaceId
    });
    const response = SoulMemorySearchResponseSchema.parse({
      delivery_id: deliveryId,
      results,
      active_constraints: recallResult.active_constraints,
      active_constraints_count: recallResult.active_constraints_count,
      total_count: resultCandidates.length,
      strategy_mix: buildBenchRecallStrategyMix(policy, results),
      degradation_reason: recallResult.degradation_reason ?? null
    });
    const diagnostics = recallResult.diagnostics === undefined
      ? undefined
      : BenchRecallDiagnosticsSchema.parse(recallResult.diagnostics);
    return Object.freeze({
      ...response,
      diagnostics
    });
  }

  async function reportContextUsage(input: BenchReportContextUsageInput): Promise<void> {
    await callMcpTool<SoulReportContextUsageResponse>(
      activeMcpClient,
      "soul.report_context_usage",
      {
        delivery_id: input.deliveryId,
        usage_state: input.usageState,
        ...(input.usedObjectIds === undefined
          ? {}
          : { used_object_ids: input.usedObjectIds }),
        ...(input.deliveredObjects === undefined
          ? {}
          : {
              delivered_objects: input.deliveredObjects.map((item) => ({
                object_id: item.objectId,
                ...(item.objectKind === undefined ? {} : { object_kind: item.objectKind }),
                usage_status: item.usageStatus
              }))
            }),
        ...(input.turnIndex === undefined ? {} : { turn_index: input.turnIndex }),
        ...(input.turnDigest === undefined
          ? {}
          : {
              turn_digest: {
                last_messages: input.turnDigest.lastMessages.map((message) => ({
                  role: message.role,
                  content_excerpt: message.contentExcerpt
                }))
              }
            }),
        ...(input.reason === undefined ? {} : { reason: input.reason })
      }
    );
  }

  async function warmEmbeddingCache(
    objectIds: readonly string[],
    options: BenchEmbeddingWarmupOptions = {}
  ): Promise<BenchEmbeddingWarmupSummary> {
    if (embeddingMode !== "env") {
      return Object.freeze({
        status: "not_requested",
        expected_count: 0,
        ready_count: 0,
        ready_rate: 0,
        pass_count: 0,
        missing_object_ids: Object.freeze([]),
        provider_kind: null,
        model_id: null
      });
    }

    const uniqueObjectIds = [...new Set(objectIds)];
    const modelId =
      embeddingProviderKind === "local_onnx"
        ? process.env.ALAYA_LOCAL_EMBEDDING_MODEL?.trim() || DEFAULT_LOCAL_ONNX_EMBEDDING_MODEL
        : process.env.OPENAI_EMBEDDING_MODEL?.trim() || DEFAULT_BENCH_EMBEDDING_MODEL;
    const maxPasses = Math.max(
      1,
      options.maxPasses ?? DEFAULT_EMBEDDING_WARMUP_PASSES
    );
    let passCount = 0;
    let lastPassError: string | null = null;
    let summary = await readEmbeddingWarmupSummary({
      dataDir,
      workspaceId,
      objectIds: uniqueObjectIds,
      providerKind: embeddingProviderKind,
      modelId,
      schemaVersion: BENCH_EMBEDDING_SCHEMA_VERSION,
      passCount
    });

    while (summary.ready_count < summary.expected_count && passCount < maxPasses) {
      try {
        await activeRuntime.runGardenBackgroundPass();
        lastPassError = null;
      } catch (error) {
        lastPassError = toErrorMessage(error);
      }
      passCount++;
      summary = await readEmbeddingWarmupSummary({
        dataDir,
        workspaceId,
        objectIds: uniqueObjectIds,
        providerKind: embeddingProviderKind,
        modelId,
        schemaVersion: BENCH_EMBEDDING_SCHEMA_VERSION,
        passCount
      });
    }

    if (summary.ready_count !== summary.expected_count) {
      const preview = summary.missing_object_ids.slice(0, 5).join(", ");
      throw new Error(
        `embedding warm cache not ready after ${summary.pass_count} pass(es): ` +
          `ready=${summary.ready_count} expected=${summary.expected_count} ` +
          `missing=${summary.missing_object_ids.length}` +
          (preview.length === 0 ? "" : ` first_missing=${preview}`) +
          (lastPassError === null ? "" : ` last_error=${lastPassError}`)
      );
    }

    return summary;
  }

  async function warmQueryEmbeddingCache(
    queryTexts: readonly string[]
  ): Promise<BenchQueryEmbeddingWarmupSummary> {
    if (embeddingMode !== "env") {
      return Object.freeze({
        status: "not_requested",
        requested_count: 0,
        ready_count: 0,
        cache_hit_count: 0,
        provider_requested_count: 0,
        missing_count: 0,
        provider_kind: null,
        model_id: null
      });
    }
    const embeddingRecallService = activeRuntime.services.embeddingRecallService;
    if (embeddingRecallService === undefined) {
      throw new Error("embedding query warm cache unavailable: embedding recall service is not configured");
    }
    const summary = await embeddingRecallService.warmQueryEmbeddings({
      workspaceId,
      runId,
      queryTexts
    });
    return summary;
  }

  async function proposeMemory(
    content: string,
    evidenceRef: string,
    options: {
      readonly objectKind?: SeedObjectKind;
      readonly distilledFact?: string;
      readonly sourceMemoryRefs?: readonly string[];
    } = {}
  ): Promise<SeededMemoryResult> {
    const objectKind: SeedObjectKind = options.objectKind ?? "fact";
    // @anchor bench-seed-content-cap: protocol §soul.emit_candidate_signal
    // caps raw_payload at 16384 characters JSON-serialized. The bench
    // harness seeds dataset turns; LongMemEval-S has turn contents that
    // can exceed 16K chars. Truncate to a safe length (leaving room for
    // the {"excerpt":"..."} JSON wrapper) instead of crashing the run.
    // Trade-off: if the has_answer fact lives past the cutoff, recall
    // cannot find it. That is a structural cap, documented in the bench
    // report.md Scoring contract.
    const SEED_CONTENT_MAX = 15_000;
    const wasTruncated = content.length > SEED_CONTENT_MAX;
    const charsClipped = wasTruncated ? content.length - SEED_CONTENT_MAX : 0;
    const safeContent = wasTruncated
      ? content.slice(0, SEED_CONTENT_MAX) +
        ` [truncated at ${SEED_CONTENT_MAX} chars]`
      : content;
    const safeDistilledFact =
      options.distilledFact === undefined
        ? undefined
        : options.distilledFact.length > SEED_CONTENT_MAX
          ? options.distilledFact.slice(0, SEED_CONTENT_MAX) +
            ` [truncated at ${SEED_CONTENT_MAX} chars]`
          : options.distilledFact;

    // Step 1: emit candidate signal. signal_kind=potential_preference at
    // confidence 0.9 with evidence_refs >= 1 routes per object_kind
    // (see materialization-router.ts routeByObjectKind): claim-capable
    // kinds land in memory_and_claim_draft; fact / outcome land in
    // memory_entry_only. raw_payload.distilled_fact, when supplied,
    // becomes memory_entry.content; raw_payload.excerpt remains the
    // evidence text reachable through evidence_refs.
    const sourceMemoryRefsField = buildSourceMemoryRefsField(options.sourceMemoryRefs);
    const signalResponse = await callMcpTool<SoulEmitCandidateSignalResponse>(
      activeMcpClient,
      "soul.emit_candidate_signal",
      {
        signal_kind: "potential_preference",
        object_kind: objectKind,
        scope_hint: ScopeClass.PROJECT,
        domain_tags: ["bench-seed"],
        confidence: 0.9,
        evidence_refs: [evidenceRef],
        ...sourceMemoryRefsField,
        raw_payload: {
          excerpt: safeContent,
          ...(safeDistilledFact === undefined
            ? {}
            : { distilled_fact: safeDistilledFact }),
          // Event-sourced token-economy KPI block (S6). Each proposeMemory
          // call seeds one self-contained turn, so it is its own turn for
          // raw_history counting; the durable memory_entry.content is the
          // distilled fact when supplied, else the seeded content itself.
          // excerpt IS the full turn here and distilled_fact (when present)
          // IS the durable fact, so the bench keys collapse to the
          // turn-seed-index alone (here: absent) — the fold falls back to
          // excerpt / distilled_fact, no second verbatim copy is serialized.
          ...benchTokenEconomyPayload({
            fullTurnContent: safeContent,
            storedContent: safeDistilledFact ?? safeContent,
            excerptSibling: safeContent,
            distilledFactSibling: safeDistilledFact
          })
        }
      }
    );
    if (signalResponse.status !== "emitted") {
      throw new Error(
        `soul.emit_candidate_signal returned unexpected status=${signalResponse.status}`
      );
    }

    // see also: materializeAndAcceptSeed
    const accepted = await materializeAndAcceptSeed(
      signalResponse.signal_id,
      evidenceRef
    );

    return {
      memoryId: accepted.memoryId,
      signalId: signalResponse.signal_id,
      proposalId: accepted.proposalId,
      evidenceId: accepted.evidenceId,
      truncated: wasTruncated,
      charsClipped
    };
  }

  // Shared seed tail: read the materialized memory_entry id, then run the
  // propose+review chain so every seed — whether emitted by proposeMemory
  // or proposeMemoryFromSignal — writes an identical audit trail.
  async function materializeAndAcceptSeed(
    signalId: string,
    evidenceRef: string
  ): Promise<{
    readonly memoryId: string;
    readonly proposalId: string;
    readonly evidenceId: string | null;
  }> {
    // Read SOUL_SIGNAL_MATERIALIZED from event_log to find the memory
    // object_id created synchronously by the materialization router. The
    // MCP surface returns only signal_id, so the bench harness consults the
    // daemon's event log directly (read-only) — an implementation-of-record
    // lookup, not a bypass of governance.
    const materialized = await readMaterializedObjects(dataDir, signalId);
    const accepted = await acceptSeededMemory(materialized.memoryId, evidenceRef);
    return {
      memoryId: materialized.memoryId,
      proposalId: accepted.proposalId,
      evidenceId: materialized.evidenceId
    };
  }

  // The propose+review accept tail, given an already-resolved memory_entry
  // id. Split out of materializeAndAcceptSeed so the garden-task seed loop
  // can run the non-throwing memory-id lookup itself (and skip an
  // evidence-only signal) before committing to the accept chain.
  async function acceptSeededMemory(
    memoryId: string,
    evidenceRef: string
  ): Promise<{ readonly proposalId: string }> {
    // Propose update on the materialized memory so the propose+review event
    // chain (SOUL_PROPOSAL_CREATED, SOUL_REVIEW_*, SOUL_PROPOSAL_RESOLVED,
    // SOUL_MEMORY_UPDATED) is written. The change is a no-op-ish domain_tag
    // append; what matters is that the chain fires for every seed.
    const proposeResponse = await callMcpTool<SoulProposeMemoryUpdateResponse>(
      activeMcpClient,
      "soul.propose_memory_update",
      {
        target_object_id: memoryId,
        proposed_changes: {
          domain_tags: ["bench-seed", "bench-reviewed"]
        },
        reason: `bench seed accept for evidence ${evidenceRef}`
      }
    );
    if (proposeResponse.status !== "created") {
      throw new Error(
        `soul.propose_memory_update returned unexpected status=${proposeResponse.status}`
      );
    }

    const reviewResponse = await callMcpTool<SoulReviewMemoryProposalResponse>(
      activeMcpClient,
      "soul.review_memory_proposal",
      {
        proposal_id: proposeResponse.proposal_id,
        verdict: "accept",
        reason: "bench seed auto-accept",
        reviewer_identity: REVIEWER_IDENTITY,
        reviewer_token: REVIEWER_TOKEN
      }
    );
    if (reviewResponse.resolution_state !== "accepted") {
      throw new Error(
        `soul.review_memory_proposal returned unexpected state=${reviewResponse.resolution_state}`
      );
    }

    return { proposalId: proposeResponse.proposal_id };
  }

  async function proposeMemoryFromSignal(
    input: BenchSignalSeedInput
  ): Promise<SeededMemoryResult> {
    // @anchor bench-seed-content-cap: protocol §soul.emit_candidate_signal
    // caps raw_payload at 16384 chars JSON-serialized.
    const SEED_CONTENT_MAX = 15_000;
    const wasTruncated = input.turnContent.length > SEED_CONTENT_MAX;
    const charsClipped = wasTruncated
      ? input.turnContent.length - SEED_CONTENT_MAX
      : 0;
    const safeExcerpt = wasTruncated
      ? input.turnContent.slice(0, SEED_CONTENT_MAX) +
        ` [truncated at ${SEED_CONTENT_MAX} chars]`
      : input.turnContent;
    const safeDistilledFact =
      input.distilledFact.length > SEED_CONTENT_MAX
        ? input.distilledFact.slice(0, SEED_CONTENT_MAX) +
          ` [truncated at ${SEED_CONTENT_MAX} chars]`
        : input.distilledFact;

    // The compile path forwards the production signal's raw_payload verbatim
    // (matched_text / turn_content_excerpt / schema_grounding /
    // detected_object / field_candidates / validation_result) so the bench
    // signal is byte-faithful to the production POST_TURN_EXTRACT signal:
    // materialization's buildSignalSummary reads field_candidates[0].value
    // (the matched_text span) and the bench evidence_capsule carries the
    // SAME span production builds — not a richer full-turn excerpt. The MCP
    // emit handler does not re-ground, so forwarding the production payload
    // here is what makes the bench measure production as-is. The no-creds /
    // extraction-failure fallback has no production payload; it carries the
    // full turn as excerpt (the degraded path, labelled extraction_provider
    // = no_credentials_fallback).
    // Event-sourced token-economy KPI block (S6): the bench stamps the
    // verbatim full ingested turn and the durable fact it seeds, plus the
    // source turn index. The fold reads these back from the EventLog so the
    // figure does not depend on the production raw_payload shape (which
    // carries only a windowed turn_content_excerpt, never the full turn).
    // The no-creds branch's excerpt / distilled_fact ARE the full turn /
    // durable fact, so the content keys collapse away (fold falls back);
    // the creds branch's production raw_payload has no such sibling, so the
    // full turn IS stamped — exactly where it is needed.
    const tokenEconomy = benchTokenEconomyPayload({
      fullTurnContent: safeExcerpt,
      storedContent: safeDistilledFact,
      turnSeedIndex: input.turnSeedIndex,
      ...(input.productionRawPayload === undefined
        ? { excerptSibling: safeExcerpt, distilledFactSibling: safeDistilledFact }
        : {})
    });
    const rawPayload: Record<string, unknown> =
      input.productionRawPayload === undefined
        ? {
            excerpt: safeExcerpt,
            distilled_fact: safeDistilledFact,
            extraction_provider: input.extractionProvider,
            ...tokenEconomy
          }
        : {
            ...stripFirstClassMemoryRefsFromRawPayload(input.productionRawPayload),
            extraction_provider: input.extractionProvider,
            ...tokenEconomy
          };

    // see also: materialization-router.ts createAllMemoryRefEdges
    const sourceMemoryRefsField = buildSourceMemoryRefsField(input.sourceMemoryRefs);
    const signalResponse = await callMcpTool<SoulEmitCandidateSignalResponse>(
      activeMcpClient,
      "soul.emit_candidate_signal",
      {
        signal_kind: input.signalKind,
        object_kind: input.objectKind,
        scope_hint: ScopeClass.PROJECT,
        domain_tags: ["bench-seed"],
        confidence: input.confidence,
        evidence_refs: [input.evidenceRef],
        ...sourceMemoryRefsField,
        raw_payload: rawPayload
      }
    );
    if (signalResponse.status !== "emitted") {
      throw new Error(
        `soul.emit_candidate_signal returned unexpected status=${signalResponse.status}`
      );
    }

    const accepted = await materializeAndAcceptSeed(
      signalResponse.signal_id,
      input.evidenceRef
    );

    return {
      memoryId: accepted.memoryId,
      signalId: signalResponse.signal_id,
      proposalId: accepted.proposalId,
      evidenceId: accepted.evidenceId,
      truncated: wasTruncated,
      charsClipped
    };
  }

  // @anchor bench-seed-content-cap: protocol §soul.emit_candidate_signal /
  // §garden.complete_task cap raw_payload at 16384 chars JSON-serialized.
  // LongMemEval-S turn contents can exceed that, so the bench clips to a
  // safe length leaving room for the JSON wrapper.
  const SEED_CONTENT_MAX = 15_000;

  function clipSeedContent(content: string): {
    readonly safe: string;
    readonly truncated: boolean;
    readonly charsClipped: number;
  } {
    if (content.length <= SEED_CONTENT_MAX) {
      return { safe: content, truncated: false, charsClipped: 0 };
    }
    return {
      safe: `${content.slice(0, SEED_CONTENT_MAX)} [truncated at ${SEED_CONTENT_MAX} chars]`,
      truncated: true,
      charsClipped: content.length - SEED_CONTENT_MAX
    };
  }

  async function proposeMemoriesFromCompileSignals(
    inputs: readonly BenchSignalSeedInput[]
  ): Promise<readonly SeededMemoryResult[]> {
    if (inputs.length === 0) {
      return [];
    }

    // Seed each compile()-extracted signal through the daemon's in-process
    // signalService.receiveSignal — the EXACT seam the production garden
    // host-worker completion uses (garden-runtime.ts processPostTurnExtractTask
    // -> input.signalReceiver.receiveSignal). receiveSignal stamps no source
    // itself; the bench builds the signal with source = GARDEN_COMPILE so it
    // is byte-faithful to the production POST_TURN_EXTRACT signal, and runs
    // normalizeSchemaGroundedSignal (the same normalization the production
    // POST_TURN_EXTRACT path applies) so the rebuilt schema-grounding block
    // is consistent with the
    // canonicalized object_kind. Going direct avoids the garden_task
    // enqueue/claim/complete MCP round-trip and the per-turn garden_task rows
    // — pure overhead for a benchmark that drives Garden deterministically.
    //
    // receiveSignal's return carries materialization.created_objects directly,
    // so the memory_entry object_id is read from the result — no event-log
    // scan. A signal the MaterializationRouter routed to evidence_only /
    // deferred (no memory_entry — e.g. a sub-0.5-confidence signal) is SKIPPED
    // per-signal, not fatal: the turn's other healthy facts still seed. The
    // returned list may be SHORTER than `inputs`; the shortfall is the caller's
    // drop count.
    // see also: apps/bench-runner/src/longmemeval/compile-seed.ts seedTurn
    const results: SeededMemoryResult[] = [];
    for (const input of inputs) {
      const clip = clipSeedContent(input.turnContent);
      const safeDistilledFact =
        input.distilledFact.length > SEED_CONTENT_MAX
          ? `${input.distilledFact.slice(0, SEED_CONTENT_MAX)} [truncated at ${SEED_CONTENT_MAX} chars]`
          : input.distilledFact;
      // Event-sourced token-economy KPI block (S6) — see proposeMemoryFromSignal.
      const tokenEconomy = benchTokenEconomyPayload({
        fullTurnContent: clip.safe,
        storedContent: safeDistilledFact,
        turnSeedIndex: input.turnSeedIndex,
        ...(input.productionRawPayload === undefined
          ? { excerptSibling: clip.safe, distilledFactSibling: safeDistilledFact }
          : {})
      });
      const rawPayload: Record<string, unknown> =
        input.productionRawPayload === undefined
          ? {
              excerpt: clip.safe,
              distilled_fact: safeDistilledFact,
              extraction_provider: input.extractionProvider,
              ...tokenEconomy
            }
          : {
              ...stripFirstClassMemoryRefsFromRawPayload(input.productionRawPayload),
              extraction_provider: input.extractionProvider,
              ...tokenEconomy
            };

      const signal: CandidateMemorySignal = normalizeSchemaGroundedSignal(
        CandidateMemorySignalSchema.parse({
          signal_id: `bench_signal_${randomUUID().replace(/-/gu, "")}`,
          workspace_id: workspaceId,
          run_id: runId,
          surface_id: null,
          source: SignalSource.GARDEN_COMPILE,
          signal_kind: input.signalKind,
          object_kind: input.objectKind,
          scope_hint: ScopeClass.PROJECT,
          domain_tags: ["bench-seed"],
          confidence: input.confidence,
          evidence_refs: [input.evidenceRef],
          ...buildSourceMemoryRefsField(input.sourceMemoryRefs),
          raw_payload: rawPayload,
          created_at: new Date().toISOString()
        })
      );

      const received = await activeRuntime.services.signalService.receiveSignal(signal);
      const memoryObject = received.materialization?.created_objects.find(
        (obj) => obj.object_kind === "memory_entry"
      );
      if (memoryObject === undefined) {
        process.stderr.write(
          `[bench compile-seed] signal ${received.signal.signal_id} ` +
            `triage=${received.triage_result} ` +
            `routing=${received.materialization?.routing_reason ?? "n/a"} ` +
            `did not materialize a memory_entry — skipped, turn batch continues\n`
        );
        continue;
      }
      const evidenceObject = received.materialization?.created_objects.find(
        (obj) => obj.object_kind === "evidence_capsule"
      );
      const accepted = await acceptSeededMemory(memoryObject.object_id, input.evidenceRef);
      results.push({
        memoryId: memoryObject.object_id,
        signalId: received.signal.signal_id,
        proposalId: accepted.proposalId,
        evidenceId: evidenceObject?.object_id ?? null,
        truncated: clip.truncated,
        charsClipped: clip.charsClipped
      });
    }
    return results;
  }

  // @anchor bench-synthesis-seed: create ONE session-level synthesis_capsule
  // directly via SynthesisService.create. The potential_synthesis signal
  // route (materializeSynthesis) is bypassed on purpose — that route mints
  // a fresh evidence_capsule row per evidence_ref, which would flood the
  // recall store and pollute the evidence FTS streams. Here the capsule
  // references the real evidence ids the session's turns already minted.
  async function proposeSynthesis(
    input: BenchSynthesisSeedInput
  ): Promise<SeededSynthesisResult> {
    if (input.evidenceRefs.length < 2) {
      throw new Error(
        `proposeSynthesis requires >= 2 evidence_refs; got ${input.evidenceRefs.length}.`
      );
    }
    const synthesis = await activeRuntime.services.synthesisService.create({
      created_by: "bench_synthesis_seed",
      topic_key: input.topicKey,
      synthesis_type: "cross_evidence",
      summary: input.summary,
      evidence_refs: [...input.evidenceRefs],
      source_memory_refs: [],
      workspace_id: workspaceId,
      run_id: runId
    });
    return { synthesisId: synthesis.object_id };
  }

  async function shutdown(): Promise<void> {
    try {
      await closeBenchDaemonResources({
        mcpClient: activeMcpClient,
        server: activeServer,
        runtime: activeRuntime
      });
    } finally {
      restoreEnv(savedEnv);
      releaseActive();
    }
  }

  return {
    runtime: activeRuntime,
    mcpClient: activeMcpClient,
    workspaceId,
    runId,
    dataDir,
    dispatchCli: activeDispatchCli,
    recall,
    warmEmbeddingCache,
    warmQueryEmbeddingCache,
    reportContextUsage,
    proposeMemory,
    proposeMemoryFromSignal,
    proposeMemoriesFromCompileSignals,
    proposeSynthesis,
    queryTokenMetrics: () => queryTokenMetrics(dataDir),
    queryEdgeProposalKpiRows: () => queryEdgeProposalKpiRows(dataDir),
    shutdown
  };
}

async function readEmbeddingWarmupSummary(input: {
  readonly dataDir: string;
  readonly workspaceId: string;
  readonly objectIds: readonly string[];
  readonly providerKind: string;
  readonly modelId: string;
  readonly schemaVersion: number;
  readonly passCount: number;
}): Promise<BenchEmbeddingWarmupSummary> {
  const expectedIds = [...new Set(input.objectIds)];
  if (expectedIds.length === 0) {
    return Object.freeze({
      status: "ready",
      expected_count: 0,
      ready_count: 0,
      ready_rate: 0,
      pass_count: input.passCount,
      missing_object_ids: Object.freeze([]),
      provider_kind: input.providerKind,
      model_id: input.modelId
    });
  }

  const db = initDatabase({ filename: join(input.dataDir, "alaya.db") });
  const embeddingRepo = new SqliteMemoryEmbeddingRepo(db);
  const records = await embeddingRepo.listByObjectIds(
    input.workspaceId,
    expectedIds
  );
  const readyIds = new Set(
    records
      .filter(
        (record) =>
          record.provider_kind === input.providerKind &&
          record.model_id === input.modelId &&
          record.schema_version === input.schemaVersion
      )
      .map((record) => record.object_id)
  );
  const missingObjectIds = expectedIds.filter((objectId) => !readyIds.has(objectId));

  return Object.freeze({
    status: "ready",
    expected_count: expectedIds.length,
    ready_count: readyIds.size,
    ready_rate: ratio(readyIds.size, expectedIds.length),
    pass_count: input.passCount,
    missing_object_ids: Object.freeze(missingObjectIds),
    provider_kind: input.providerKind,
    model_id: input.modelId
  });
}

function ratio(count: number, total: number): number {
  return total === 0 ? 0 : count / total;
}

function resolveBenchOpenAiSecretRef(
  savedEnv: Partial<Record<ManagedEnvKey, string | undefined>>
): string {
  return savedEnv.ALAYA_OPENAI_SECRET_REF?.trim() || "env:OPENAI_API_KEY";
}

function requireBenchOpenAiSecretRef(secretRef: string): void {
  const resolved = resolveSecretRef(secretRef);
  if (!("kind" in resolved)) {
    return;
  }

  throw new Error(formatBenchEmbeddingSecretError(resolved));
}

function formatBenchEmbeddingSecretError(error: ResolveSecretError): string {
  const prefix = "--embedding env requires a resolvable ALAYA_OPENAI_SECRET_REF";
  switch (error.kind) {
    case "env_missing":
      return `${prefix}; missing environment variable ${error.var_name}`;
    case "empty":
      return `${prefix}; ${error.origin} secret is empty`;
    case "file_missing":
      return `${prefix}; referenced file is missing`;
    case "file_unreadable":
      return `${prefix}; referenced file is unreadable`;
    case "keychain_tooling_unavailable":
    case "keychain_entry_not_found":
      return `${prefix}; keychain secret lookup failed`;
    case "malformed":
      return `${prefix}; secret ref is malformed`;
  }
}

async function closeBenchDaemonResources(resources: {
  readonly mcpClient?: Client;
  readonly server?: ReturnType<typeof createAlayaMcpServer>;
  readonly runtime?: AlayaDaemonRuntime;
}): Promise<void> {
  if (resources.mcpClient !== undefined) {
    try {
      await resources.mcpClient.close();
    } catch {
      // Ignore close errors
    }
  }
  if (resources.server !== undefined) {
    try {
      await resources.server.close();
    } catch {
      // Ignore close errors
    }
  }
  if (resources.runtime !== undefined) {
    try {
      await resources.runtime.shutdown();
    } catch {
      // Ignore close errors
    }
  }
}

function makeDispatchCli(
  runtime: AlayaDaemonRuntime
): (argv: readonly string[]) => Promise<{ exitCode: number; json?: unknown }> {
  return async (argv) => {
    const bridge = createAlayaCliBridge(runtime, {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      isTTY: false
    });
    registerAlayaCliCommands(bridge, runtime);
    return bridge.dispatch(argv);
  };
}

async function callMcpTool<TOutput>(
  client: Client,
  name: string,
  args: Record<string, unknown>
): Promise<TOutput> {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError === true) {
    const contentArray = Array.isArray(result.content) ? result.content as readonly unknown[] : [];
    const errorText = contentArray
      .map((item) =>
        item !== null && typeof item === "object" && "text" in item && typeof (item as { text: unknown }).text === "string"
          ? (item as { text: string }).text
          : ""
      )
      .join("\n");
    throw new Error(`MCP tool ${name} failed: ${errorText}`);
  }
  const structured = result.structuredContent as
    | Readonly<{ ok: true; output: TOutput }>
    | undefined;
  if (structured?.ok !== true) {
    throw new Error(`MCP tool ${name} returned non-ok structured content`);
  }
  return structured.output;
}

const DEFAULT_EMBEDDING_FUSION_WEIGHT_ON = 6;
const EMBEDDING_FUSION_WEIGHT_ENV = "ALAYA_EMBEDDING_FUSION_WEIGHT_ON";

// Mirror of apps/core-daemon/src/daemon-embedding-runtime.ts
// readEmbeddingFusionWeightOverride — the daemon's defaultPolicyDecorator
// reads the same env var to override fusion_weights.embedding_similarity in
// live recall. The bench harness drives recallService.recall directly with
// policyOverride (bypassing the decorator), so we inject the equivalent
// override here when embeddingMode === "env".
function readBenchEmbeddingFusionWeight(): number {
  const raw = process.env[EMBEDDING_FUSION_WEIGHT_ENV];
  if (raw === undefined || raw.trim().length === 0) {
    return DEFAULT_EMBEDDING_FUSION_WEIGHT_ON;
  }
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_EMBEDDING_FUSION_WEIGHT_ON;
  }
  return parsed;
}

function withEmbeddingFusionWeightInjected(
  existing: BenchRecallWeightOverrides | undefined
): BenchRecallWeightOverrides {
  const fusionWeight = readBenchEmbeddingFusionWeight();
  // A user-supplied embedding_similarity fusion weight (from CLI/env JSON)
  // wins over the harness default so bench tuning sweeps remain authoritative.
  const baseFusionWeights = existing?.fusionWeights ?? {};
  const mergedFusionWeights: Readonly<Record<string, number>> = Object.freeze({
    embedding_similarity: fusionWeight,
    ...baseFusionWeights
  });

  // Preserve the source of the user-supplied override when present; otherwise
  // tag the harness-injected slice as env-sourced for the summary log.
  const source: "cli" | "env" = existing?.source ?? "env";

  const summary = {
    source,
    ...(existing?.summary.activation_weights_phase4b === undefined
      ? {}
      : { activation_weights_phase4b: existing.summary.activation_weights_phase4b }),
    ...(existing?.summary.additive === undefined
      ? {}
      : { additive: existing.summary.additive }),
    fusion_weights: mergedFusionWeights
  };

  return Object.freeze({
    source,
    ...(existing?.activationWeightsPatch === undefined
      ? {}
      : { activationWeightsPatch: existing.activationWeightsPatch }),
    ...(existing?.additive === undefined
      ? {}
      : { additive: existing.additive }),
    fusionWeights: mergedFusionWeights,
    summary
  });
}

function buildBenchDiagnosticRecallPolicy(
  taskSurfaceId: string,
  maxResultsInput: number,
  conflictAwareness = true
): RecallPolicy {
  const maxResults = Math.max(maxResultsInput, 1);
  const coarseCandidateLimit = Math.min(Math.max(maxResults * 10, maxResults), 1000);
  const keywordCandidateLimit = Math.min(Math.max(coarseCandidateLimit, maxResults * 10, 1), 1000);
  return {
    runtime_id: randomUUID(),
    object_kind: ControlPlaneObjectKind.RECALL_POLICY,
    task_surface_ref: taskSurfaceId,
    expires_at: null,
    derived_from: null,
    retention_policy: RetentionPolicy.SESSION_ONLY,
    coarse_filter: {
      deterministic_match: {
        scope_filter: null,
        dimension_filter: null,
        domain_tag_filter: null
      },
      precomputed_rank: {
        max_candidates: coarseCandidateLimit,
        min_activation_score: null
      },
      semantic_supplement: {
        enabled: true,
        max_supplement: keywordCandidateLimit,
        embedding_enabled: true
      }
    },
    fine_assessment: {
      budgets: {
        max_total_tokens: 2000,
        max_entries: maxResults,
        per_dimension_limits: null
      },
      conflict_awareness: conflictAwareness
    }
  };
}

function buildBenchMemorySearchResult(
  candidate: Readonly<RecallCandidate>,
  policy: Readonly<RecallPolicy>,
  index: number,
  usedTokensBeforeCandidate: number
): MemorySearchResult {
  return {
    object_id: candidate.object_id,
    object_kind: candidate.object_kind,
    relevance_score: candidate.relevance_score,
    content_preview: candidate.content_preview,
    evidence_pointers: [candidate.object_id],
    selection_reason: candidate.selection_reason ?? buildBenchSelectionReason(candidate),
    source_channels: candidate.source_channels ?? buildBenchSourceChannels(candidate),
    score_factors: candidate.score_factors ?? buildBenchScoreFactors(candidate),
    budget_state: candidate.budget_state ?? buildBenchBudgetState(candidate, policy, index, usedTokensBeforeCandidate)
  };
}

function buildBenchRecallStrategyMix(
  policy: Readonly<RecallPolicy>,
  results: readonly Readonly<MemorySearchResult>[]
): SoulRecallStrategyMix {
  return {
    deterministic_match: true,
    precomputed_rank: policy.coarse_filter.precomputed_rank.max_candidates > 0,
    semantic_supplement: results.some(
      (result) =>
        result.source_channels.includes("semantic_supplement") ||
        result.score_factors.embedding_similarity !== undefined
    ),
    graph_support: results.some(
      (result) =>
        result.source_channels.includes("graph_support") ||
        (result.score_factors.graph_support ?? 0) > 0
    ),
    path_plasticity: results.some(
      (result) =>
        result.source_channels.includes("path_plasticity") ||
        (result.score_factors.path_plasticity ?? 0) > 0
    ),
    global_recall: results.some((result) => result.source_channels.includes("global"))
  };
}

function buildBenchSelectionReason(candidate: Readonly<RecallCandidate>): string {
  const origin = candidate.origin_plane === "global" ? "global recall" : "workspace recall";
  return `Selected by ${origin} with relevance ${candidate.relevance_score.toFixed(3)} and activation ${candidate.activation_score.toFixed(3)}.`;
}

function buildBenchSourceChannels(candidate: Readonly<RecallCandidate>): readonly string[] {
  const channels = ["ranked_recall", candidate.origin_plane] as string[];
  if (candidate.is_advisory === true) {
    channels.push("advisory");
  }
  return channels;
}

function buildBenchScoreFactors(candidate: Readonly<RecallCandidate>): RecallScoreFactors {
  return {
    activation: clampScore(candidate.activation_score),
    relevance: clampScore(candidate.relevance_score)
  };
}

function buildBenchBudgetState(
  candidate: Readonly<RecallCandidate>,
  policy: Readonly<RecallPolicy>,
  index: number,
  usedTokensBeforeCandidate: number
): RecallBudgetState {
  const maxEntries = policy.fine_assessment.budgets.max_entries;
  const maxTotalTokens = policy.fine_assessment.budgets.max_total_tokens;
  const usedTokensThroughCandidate = usedTokensBeforeCandidate + candidate.token_estimate;
  return {
    token_estimate: candidate.token_estimate,
    max_entries: maxEntries,
    max_total_tokens: maxTotalTokens,
    remaining_entries: Math.max(maxEntries - index - 1, 0),
    remaining_tokens: Math.max(maxTotalTokens - usedTokensThroughCandidate, 0),
    within_budget: index < maxEntries && usedTokensThroughCandidate <= maxTotalTokens
  };
}

function clampScore(value: number): number {
  return Math.min(Math.max(value, 0), 1);
}

// @anchor readMaterializedObjects: bridges signal_id -> durable object ids.
// The MCP surface intentionally does not expose materialization side-effects
// (the agent should only know it emitted a signal). The bench harness reads
// the event_log directly, which is the canonical audit-trail record of the
// materialization. Returns the durable memory_entry id (throwing when the
// signal materialized none — a routing fault the bench must surface) plus
// the evidence_capsule id when one was created (null otherwise: not every
// route mints an evidence row). initDatabase caches connections by path so
// this opens the same handle the daemon already uses. Do not close the
// connection here or the daemon will lose its DB.
async function readMaterializedObjects(
  dataDir: string,
  signalId: string
): Promise<{ readonly memoryId: string; readonly evidenceId: string | null }> {
  const db = initDatabase({ filename: join(dataDir, "alaya.db") });
  const eventLogRepo = new SqliteEventLogRepo(db);
  const events = await eventLogRepo.queryByEntity("candidate_memory_signal", signalId);
  let memoryId: string | null = null;
  let evidenceId: string | null = null;
  for (const event of events) {
    if (event.event_type !== SignalEventType.SOUL_SIGNAL_MATERIALIZED) {
      continue;
    }
    const payload = SoulSignalMaterializedPayloadSchema.parse(event.payload_json);
    for (const obj of payload.created_objects) {
      if (obj.object_kind === "memory_entry" && memoryId === null) {
        memoryId = obj.object_id;
      }
      if (obj.object_kind === "evidence_capsule" && evidenceId === null) {
        evidenceId = obj.object_id;
      }
    }
  }
  if (memoryId === null) {
    throw new Error(
      `Signal ${signalId} did not materialize a memory_entry — check signal_kind / confidence / evidence_refs routing.`
    );
  }
  return { memoryId, evidenceId };
}

// @anchor emitBenchContextLensAssembledEvent: append a
// SOUL_CONTEXT_LENS_ASSEMBLED event from the bench recall path so the
// token-economy KPI stays event-sourced. The bench recall path drives
// recallService directly and skips ContextLensAssembler (which is the
// production emitter of this event), so without this the EventLog carries
// no recalled-context token figure. The payload is built through the
// protocol's own SoulContextLensAssembledPayloadSchema — the same schema
// the production assembler writes, so the event is schema-faithful.
// initDatabase caches the connection by path
// (the same handle the daemon holds); the connection is NOT closed here.
function emitBenchContextLensAssembledEvent(
  dataDir: string,
  input: {
    readonly taskSurfaceRef: string;
    readonly lensEntryCount: number;
    readonly totalTokenEstimate: number;
    readonly runId: string;
    readonly workspaceId: string;
  }
): void {
  const db = initDatabase({ filename: join(dataDir, "alaya.db") });
  const eventLogRepo = new SqliteEventLogRepo(db);
  const lensRuntimeId = `bench_lens_${randomUUID().replace(/-/gu, "")}`;
  eventLogRepo.append({
    event_type: RecallContextEventType.SOUL_CONTEXT_LENS_ASSEMBLED,
    entity_type: "context_lens",
    entity_id: lensRuntimeId,
    workspace_id: input.workspaceId,
    run_id: input.runId,
    caused_by: "bench-runner",
    payload_json: SoulContextLensAssembledPayloadSchema.parse({
      runtime_id: lensRuntimeId,
      task_surface_ref: input.taskSurfaceRef,
      lens_entry_count: input.lensEntryCount,
      total_token_estimate: input.totalTokenEstimate,
      run_id: input.runId,
      workspace_id: input.workspaceId,
      occurred_at: new Date().toISOString()
    })
  });
}

// @anchor queryTokenMetrics: event-sourced token-economy reader. Mirrors
// readMaterializedMemoryId — opens the bench DB via the cached connection
// and reads EventLog rows, never in-memory bench state. The pure event ->
// metrics fold lives in longmemeval/token-economy.ts deriveBenchTokenMetrics
// so it is unit-testable against a stubbed EventLog. The connection is NOT
// closed here.
async function queryTokenMetrics(dataDir: string): Promise<BenchTokenMetrics> {
  const db = initDatabase({ filename: join(dataDir, "alaya.db") });
  const eventLogRepo = new SqliteEventLogRepo(db);
  const emittedEvents = await eventLogRepo.queryByType(
    SignalEventType.SOUL_SIGNAL_EMITTED
  );
  const lensEvents = await eventLogRepo.queryByType(
    RecallContextEventType.SOUL_CONTEXT_LENS_ASSEMBLED
  );
  return deriveBenchTokenMetrics(emittedEvents, lensEvents);
}

// @anchor queryEdgeProposalKpiRows: event-sourced edge proposal KPI reader.
// Same shape as queryTokenMetrics — opens the bench DB and reads the two
// proposal event types, returning the minimal structural row shape the
// aggregator in @do-soul/alaya-eval consumes. The aggregator is pure so it
// stays unit-testable without standing up storage.
// see also: packages/eval/src/edge-proposal-kpi.ts
async function queryEdgeProposalKpiRows(
  dataDir: string
): Promise<readonly EdgeProposalKpiEventRow[]> {
  const db = initDatabase({ filename: join(dataDir, "alaya.db") });
  const eventLogRepo = new SqliteEventLogRepo(db);
  const createdEvents = await eventLogRepo.queryByType(
    GraphAuditorEventType.SOUL_GRAPH_EDGE_PROPOSAL_CREATED
  );
  const reviewedEvents = await eventLogRepo.queryByType(
    GraphAuditorEventType.SOUL_GRAPH_EDGE_PROPOSAL_REVIEWED
  );
  const rows: EdgeProposalKpiEventRow[] = [];
  for (const event of createdEvents) {
    rows.push({
      event_type: event.event_type,
      workspace_id: event.workspace_id,
      created_at: event.created_at,
      payload_json: event.payload_json
    });
  }
  for (const event of reviewedEvents) {
    rows.push({
      event_type: event.event_type,
      workspace_id: event.workspace_id,
      created_at: event.created_at,
      payload_json: event.payload_json
    });
  }
  return rows;
}

async function seedBenchWorkspaceAndRun(
  dataDir: string,
  workspaceId: string,
  runId: string
): Promise<void> {
  const db = initDatabase({ filename: join(dataDir, "alaya.db") });
  const workspaceRepo = new SqliteWorkspaceRepo(db);
  const runRepo = new SqliteRunRepo(db);
  workspaceRepo.create({
    workspace_id: workspaceId,
    name: workspaceId,
    root_path: join(dataDir, "bench-workspace-root"),
    workspace_kind: WorkspaceKind.LOCAL_REPO,
    default_engine_binding: null,
    workspace_state: WorkspaceState.ACTIVE
  });
  runRepo.create({
    run_id: runId,
    workspace_id: workspaceId,
    title: `bench run ${runId}`,
    goal: null,
    run_mode: RunMode.CHAT,
    engine_binding_id: null,
    engine_class: null,
    run_state: RunState.IDLE,
    current_surface_id: null
  });
}

function restoreEnv(saved: Partial<Record<ManagedEnvKey, string | undefined>>): void {
  for (const key of MANAGED_ENV_KEYS) {
    const prev = saved[key];
    if (prev === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = prev;
    }
  }
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// @anchor benchTokenEconomyPayload: the bench KPI block stamped on every
// seed signal's raw_payload so queryTokenMetrics can derive raw_history /
// stored_memory from the EventLog. fullTurnContent is the verbatim ingested
// turn (raw_history, counted once per turnSeedIndex); storedContent is the
// durable fact the harness seeds as memory_entry.content (stored_memory,
// summed per fact). turnSeedIndex de-duplicates a turn's N-fact fan-out;
// omit it for a self-contained single-turn seed (proposeMemory).
//
// A bench content key is stamped ONLY when it would not byte-duplicate a
// sibling raw_payload field: on the no-credentials path `excerpt` already IS
// the full turn and `distilled_fact` already IS the durable fact, so
// stamping a second verbatim copy would near-double the serialized
// raw_payload and risk an over-cap drop. The fold falls back along
// bench_full_turn_content -> excerpt and bench_stored_content ->
// distilled_fact -> excerpt when the bench key is absent (token-economy.ts),
// so the KPI is still complete. The stored fallback's terminal `excerpt`
// mirrors the harness rule storedContent = distilledFact ?? content: when no
// distilled fact is supplied the seeded content itself is the durable fact.
// On the credentialled path `excerpt` carries only a narrow
// turn_content_excerpt window, so the keys differ and ARE stamped.
// see also: apps/bench-runner/src/longmemeval/token-economy.ts
function benchTokenEconomyPayload(input: {
  readonly fullTurnContent: string;
  readonly storedContent: string;
  readonly turnSeedIndex?: number;
  readonly excerptSibling?: string;
  readonly distilledFactSibling?: string;
}): Record<string, unknown> {
  const storedDuplicatesSibling =
    input.storedContent === input.distilledFactSibling ||
    (input.distilledFactSibling === undefined &&
      input.storedContent === input.excerptSibling);
  return {
    // Content-free marker: always present so the fold can recognise a bench
    // seed row even when every content key collapses away.
    [BENCH_SEED_MARKER_KEY]: true,
    ...(input.fullTurnContent === input.excerptSibling
      ? {}
      : { [BENCH_FULL_TURN_CONTENT_KEY]: input.fullTurnContent }),
    ...(storedDuplicatesSibling
      ? {}
      : { [BENCH_STORED_CONTENT_KEY]: input.storedContent }),
    ...(input.turnSeedIndex === undefined
      ? {}
      : { [BENCH_TURN_SEED_INDEX_KEY]: input.turnSeedIndex })
  };
}

// @anchor buildSourceMemoryRefsField: derives_from edge proposal injection
// see also: packages/soul/src/garden/materialization-router.ts
//   createAllMemoryRefEdges
// see also: apps/bench-runner/src/longmemeval/compile-seed.ts seedTurn
function buildSourceMemoryRefsField(
  refs: readonly string[] | undefined
): Record<string, unknown> {
  if (refs === undefined || refs.length === 0) {
    return {};
  }
  const unique = [...new Set(refs.filter((ref) => typeof ref === "string" && ref.length > 0))];
  if (unique.length === 0) {
    return {};
  }
  return { source_memory_refs: unique };
}

const FIRST_CLASS_MEMORY_REF_KEYS = [
  "source_memory_refs",
  "supersedes_refs",
  "exception_to_refs",
  "contradicts_refs",
  "incompatible_with_refs"
] as const;

function stripFirstClassMemoryRefsFromRawPayload(
  rawPayload: Readonly<Record<string, unknown>>
): Record<string, unknown> {
  const sanitized = { ...rawPayload };
  for (const key of FIRST_CLASS_MEMORY_REF_KEYS) {
    delete sanitized[key];
  }
  return sanitized;
}

// see also: apps/bench-runner/src/version.ts
