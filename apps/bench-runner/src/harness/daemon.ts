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
  ControlPlaneObjectKind,
  GardenEventType,
  GardenRole,
  GardenTaskKind,
  RunMode,
  RunState,
  ScopeClass,
  SignalEventType,
  SoulGardenTaskCompletedPayloadSchema,
  SoulSignalMaterializedPayloadSchema,
  RetentionPolicy,
  SoulMemorySearchResponseSchema,
  TaskObjectSurfaceSchema,
  WorkspaceKind,
  WorkspaceState,
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
  type SoulReviewMemoryProposalResponse,
  type GardenClaimTaskResponse,
  type GardenCompleteTaskResponse
} from "@do-soul/alaya-protocol";
import {
  initDatabase,
  SqliteEventLogRepo,
  SqliteGardenTaskRepo,
  SqliteMemoryEmbeddingRepo,
  SqliteRunRepo,
  SqliteWorkspaceRepo,
  type GardenTaskEventPublisherPort
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

export interface BenchDaemonOptions {
  readonly dataDirRoot?: string;
  readonly workspaceId?: string;
  readonly runId?: string;
  readonly embeddingMode?: BenchEmbeddingMode;
  readonly recallWeightOverrides?: BenchRecallWeightOverrides;
}

export type BenchEmbeddingMode = "disabled" | "env";

export interface SeededMemoryResult {
  /** Durable memory object_id assigned by the signal materializer. */
  readonly memoryId: string;
  /** Signal id that produced the memory (audit trail anchor). */
  readonly signalId: string;
  /** Proposal id created by soul.propose_memory_update on the new memory. */
  readonly proposalId: string;
  /** true iff the source content exceeded SEED_CONTENT_MAX and was truncated. */
  readonly truncated: boolean;
  /** chars clipped from source content; 0 when not truncated. */
  readonly charsClipped: number;
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
  /** Which extraction path produced this fact (audit / report disclosure). */
  readonly extractionProvider: "official_api_compile" | "no_credentials_fallback";
}

export interface BenchContextUsageObject {
  readonly objectId: string;
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
   * credentialled compile path uses proposeMemoriesFromGardenTask instead so
   * its signals carry source = garden_compile.
   *
   * see also: apps/bench-runner/src/longmemeval/compile-seed.ts
   */
  proposeMemoryFromSignal(
    input: BenchSignalSeedInput
  ): Promise<SeededMemoryResult>;
  /**
   * @anchor proposeMemoriesFromGardenTask — production-faithful compile seed
   *
   * Seeds a turn's production-extracted candidate signals as durable
   * memory_entry rows through the SAME path production POST_TURN_EXTRACT
   * completion uses: enqueue a post_turn_extract Garden task, claim it, then
   * garden.complete_task with the content-only candidate_signals. The MCP
   * completeGardenTask handler stamps source = SignalSource.GARDEN_COMPILE on
   * every emitted signal (mcp-memory-tool-handler.ts) — exactly as the
   * in-process host-worker completion does. soul.emit_candidate_signal would
   * instead hardcode source = model_tool, which downstream toFormationKind
   * maps to `inferred` (confidence base 0.4) rather than `extracted` (0.6),
   * seeding ~33% lower retention than production. Routing through
   * garden.complete_task is what keeps the bench-seeded fact's retention
   * faithful to what production builds.
   *
   * One Garden task carries the whole turn's signals (garden.complete_task
   * materializes them as a batch, matching production). Steps 2-4
   * (materialize lookup + propose + review, via materializeAndAcceptSeed)
   * then run per materialized signal, so every seed writes the same audit
   * trail proposeMemory / proposeMemoryFromSignal write. Returns one
   * SeededMemoryResult per input signal, in input order.
   *
   * see also: apps/bench-runner/src/longmemeval/compile-seed.ts
   * see also: apps/core-daemon/src/garden-runtime.ts compilePostTurnExtractTask
   */
  proposeMemoriesFromGardenTask(
    inputs: readonly BenchSignalSeedInput[]
  ): Promise<readonly SeededMemoryResult[]>;
  shutdown(): Promise<void>;
}

const MANAGED_ENV_KEYS = [
  "DATA_DIR",
  "OPENAI_API_KEY",
  "OPENAI_EMBEDDING_MODEL",
  "OPENAI_EMBEDDING_PROVIDER_URL",
  "ALAYA_OPENAI_SECRET_REF",
  "ALAYA_ENABLE_EMBEDDING_SUPPLEMENT",
  "ALAYA_CONFIG_DIR",
  "CODEX_HOME",
  "HOME",
  "ALAYA_REVIEWER_IDENTITY",
  "ALAYA_REVIEWER_TOKEN"
] as const;

type ManagedEnvKey = (typeof MANAGED_ENV_KEYS)[number];

const REVIEWER_IDENTITY = "user:bench-runner";
const REVIEWER_TOKEN = "bench-review-token";
const BENCH_EMBEDDING_PROVIDER_KIND = "openai";
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
  const recallWeightOverrides = opts.recallWeightOverrides;

  const dataDir =
    opts.dataDirRoot ?? (await mkdtemp(join(tmpdir(), "alaya-bench-")));

  const savedEnv: Partial<Record<ManagedEnvKey, string | undefined>> = {};
  for (const key of MANAGED_ENV_KEYS) {
    savedEnv[key] = process.env[key];
  }

  const effectiveOpenAiSecretRef =
    embeddingMode === "env" ? resolveBenchOpenAiSecretRef(savedEnv) : "env:OPENAI_API_KEY";
  if (embeddingMode === "env") {
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
      process.env.ALAYA_OPENAI_SECRET_REF = effectiveOpenAiSecretRef;
      if (savedEnv.OPENAI_API_KEY === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = savedEnv.OPENAI_API_KEY;
      }
      process.env.ALAYA_ENABLE_EMBEDDING_SUPPLEMENT = "true";
    } else {
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
    // proposeMemoriesFromGardenTask enqueue -> garden.claim_task -> garden.complete_task
    // sequence. A benchmark needs deterministic Garden control: the bench drives
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
    await diagnosticRuntime.services.trustStateRecorder.recordDelivery({
      delivery_id: deliveryId,
      agent_target: "bench-runner",
      workspace_id: workspaceId,
      run_id: runId,
      delivered_object_ids: [...new Set([
        ...results.map((result) => result.object_id),
        ...recallResult.active_constraints.map((constraint) => constraint.object_id)
      ])],
      delivered_at: new Date().toISOString()
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
      process.env.OPENAI_EMBEDDING_MODEL?.trim() || DEFAULT_BENCH_EMBEDDING_MODEL;
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
      providerKind: BENCH_EMBEDDING_PROVIDER_KIND,
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
        providerKind: BENCH_EMBEDDING_PROVIDER_KIND,
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
        raw_payload: {
          excerpt: safeContent,
          ...(safeDistilledFact === undefined
            ? {}
            : { distilled_fact: safeDistilledFact })
        }
      }
    );
    if (signalResponse.status !== "emitted") {
      throw new Error(
        `soul.emit_candidate_signal returned unexpected status=${signalResponse.status}`
      );
    }

    // Steps 2-4: materialize lookup + propose + review (shared with
    // proposeMemoryFromSignal so both seed paths write an identical
    // propose+review audit chain).
    const accepted = await materializeAndAcceptSeed(
      signalResponse.signal_id,
      evidenceRef
    );

    return {
      memoryId: accepted.memoryId,
      signalId: signalResponse.signal_id,
      proposalId: accepted.proposalId,
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
  ): Promise<{ readonly memoryId: string; readonly proposalId: string }> {
    // Read SOUL_SIGNAL_MATERIALIZED from event_log to find the memory
    // object_id created synchronously by the materialization router. The
    // MCP surface returns only signal_id, so the bench harness consults the
    // daemon's event log directly (read-only) — an implementation-of-record
    // lookup, not a bypass of governance.
    const memoryId = await readMaterializedMemoryId(dataDir, signalId);

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

    return { memoryId, proposalId: proposeResponse.proposal_id };
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
    const rawPayload: Record<string, unknown> =
      input.productionRawPayload === undefined
        ? {
            excerpt: safeExcerpt,
            distilled_fact: safeDistilledFact,
            extraction_provider: input.extractionProvider
          }
        : {
            ...input.productionRawPayload,
            extraction_provider: input.extractionProvider
          };

    // The candidate's real signal_kind / object_kind are preserved so the
    // materialization router routes by the kind the production extractor
    // actually chose; raw_payload.distilled_fact → memory_entry.content via
    // buildDistilledFact.
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

  async function proposeMemoriesFromGardenTask(
    inputs: readonly BenchSignalSeedInput[]
  ): Promise<readonly SeededMemoryResult[]> {
    if (inputs.length === 0) {
      return [];
    }

    // Step 1: enqueue a post_turn_extract Garden task on the same DB the
    // daemon uses, so garden.claim_task / garden.complete_task can drive it.
    // The payload carries run_id because completeGardenTask resolves the
    // signal scope's run_id from row.payload.run_id; agentTarget on the
    // bench MCP context is "bench-runner", which becomes the task claimant.
    //
    // SqliteGardenTaskRepo needs an event publisher only for the
    // claim/complete/gc transactions — enqueue() is a plain INSERT that
    // never publishes. The bench drives claim + complete through the MCP
    // handler (which uses the daemon's own properly-wired repo), so this
    // repo instance is used ONLY for enqueue; the publisher must never be
    // reached, and throws loudly if a future code path tries.
    const enqueueOnlyEventPublisher: GardenTaskEventPublisherPort = {
      appendManyWithMutation: () => {
        throw new Error(
          "bench garden-task seed repo: event publisher reached — enqueue() must not publish events"
        );
      }
    };
    const gardenTaskRepo = new SqliteGardenTaskRepo(
      initDatabase({ filename: join(dataDir, "alaya.db") }).connection,
      enqueueOnlyEventPublisher
    );
    const { task_id: taskId } = gardenTaskRepo.enqueue({
      workspace_id: workspaceId,
      role: GardenRole.LIBRARIAN,
      kind: GardenTaskKind.POST_TURN_EXTRACT,
      payload: { run_id: runId }
    });

    // Step 2: claim the task as this host. POST_TURN_EXTRACT tasks surface
    // under the host_worker role, the same claim path an attached CLI agent
    // host worker uses.
    const claimResponse = await callMcpTool<GardenClaimTaskResponse>(
      activeMcpClient,
      "garden.claim_task",
      { task_id: taskId }
    );
    if (claimResponse.status !== "claimed") {
      throw new Error(
        `garden.claim_task returned unexpected status=${claimResponse.status} for bench seed task ${taskId}`
      );
    }

    // Per-input truncation bookkeeping, indexed 1:1 with the candidate
    // signals submitted below.
    const clips = inputs.map((input) => clipSeedContent(input.turnContent));

    // Step 3: complete the task with the production-extracted signals as the
    // content-only candidate_signals envelope. completeGardenTask stamps
    // source = SignalSource.GARDEN_COMPILE on every signal and routes each
    // through deps.signalService.receiveSignal — the same materialization
    // seam the in-process garden host-worker completion uses. raw_payload is
    // forwarded verbatim (or built full-turn for the fallback) exactly as
    // proposeMemoryFromSignal builds it, so the bench evidence_capsule stays
    // the production matched_text span.
    const candidateSignals = inputs.map((input, index) => {
      const clip = clips[index] ?? clipSeedContent(input.turnContent);
      const safeDistilledFact =
        input.distilledFact.length > SEED_CONTENT_MAX
          ? `${input.distilledFact.slice(0, SEED_CONTENT_MAX)} [truncated at ${SEED_CONTENT_MAX} chars]`
          : input.distilledFact;
      const rawPayload: Record<string, unknown> =
        input.productionRawPayload === undefined
          ? {
              excerpt: clip.safe,
              distilled_fact: safeDistilledFact,
              extraction_provider: input.extractionProvider
            }
          : {
              ...input.productionRawPayload,
              extraction_provider: input.extractionProvider
            };
      return {
        signal_kind: input.signalKind,
        object_kind: input.objectKind,
        scope_hint: ScopeClass.PROJECT,
        domain_tags: ["bench-seed"],
        confidence: input.confidence,
        evidence_refs: [input.evidenceRef],
        raw_payload: rawPayload
      };
    });

    const completeResponse = await callMcpTool<GardenCompleteTaskResponse>(
      activeMcpClient,
      "garden.complete_task",
      {
        task_id: taskId,
        status: "completed",
        result_envelope: { candidate_signals: candidateSignals }
      }
    );
    if (completeResponse.status !== "completed") {
      throw new Error(
        `garden.complete_task returned unexpected status=${completeResponse.status} for bench seed task ${taskId}`
      );
    }

    // Recover the materialized signal ids from the SOUL_GARDEN_TASK_COMPLETED
    // event's objects_affected, which lists them in candidate_signals order.
    const signalIds = await readGardenTaskSignalIds(dataDir, taskId);
    if (signalIds.length !== inputs.length) {
      throw new Error(
        `garden.complete_task materialized ${signalIds.length} signal(s) for ${inputs.length} bench seed input(s) on task ${taskId}`
      );
    }

    // Steps 2-4 of the seed tail: per materialized signal, read its
    // memory_entry id and run the propose+review chain — the same audit
    // trail proposeMemory / proposeMemoryFromSignal write.
    const results: SeededMemoryResult[] = [];
    for (let index = 0; index < inputs.length; index++) {
      const input = inputs[index];
      const signalId = signalIds[index];
      const clip = clips[index];
      if (input === undefined || signalId === undefined || clip === undefined) {
        continue;
      }
      const accepted = await materializeAndAcceptSeed(signalId, input.evidenceRef);
      results.push({
        memoryId: accepted.memoryId,
        signalId,
        proposalId: accepted.proposalId,
        truncated: clip.truncated,
        charsClipped: clip.charsClipped
      });
    }
    return results;
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
    proposeMemoriesFromGardenTask,
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

// @anchor readMaterializedMemoryId: bridges signal_id -> durable memory_id
// The MCP surface intentionally does not expose materialization side-effects
// (the agent should only know it emitted a signal). The bench harness reads
// the event_log directly, which is the canonical audit-trail record of the
// materialization. initDatabase caches connections by path so this opens the
// same handle the daemon already uses. Do not close the connection here or
// the daemon will lose its DB.
async function readMaterializedMemoryId(
  dataDir: string,
  signalId: string
): Promise<string> {
  const db = initDatabase({ filename: join(dataDir, "alaya.db") });
  const eventLogRepo = new SqliteEventLogRepo(db);
  const events = await eventLogRepo.queryByEntity("candidate_memory_signal", signalId);
  for (const event of events) {
    if (event.event_type !== SignalEventType.SOUL_SIGNAL_MATERIALIZED) {
      continue;
    }
    const payload = SoulSignalMaterializedPayloadSchema.parse(event.payload_json);
    const memoryObject = payload.created_objects.find(
      (obj) => obj.object_kind === "memory_entry"
    );
    if (memoryObject !== undefined) {
      return memoryObject.object_id;
    }
  }
  throw new Error(
    `Signal ${signalId} did not materialize a memory_entry — check signal_kind / confidence / evidence_refs routing.`
  );
}

// @anchor readGardenTaskSignalIds: bridges a completed Garden task -> the
// ordered materialized signal ids. completeGardenTask appends one
// SOUL_GARDEN_TASK_COMPLETED event whose objects_affected lists the emitted
// signal ids in candidate_signals order. The bench reads the event_log
// directly (read-only) — the canonical audit-trail record — to recover them.
async function readGardenTaskSignalIds(
  dataDir: string,
  taskId: string
): Promise<readonly string[]> {
  const db = initDatabase({ filename: join(dataDir, "alaya.db") });
  const eventLogRepo = new SqliteEventLogRepo(db);
  const events = await eventLogRepo.queryByEntity("garden_task", taskId);
  for (const event of events) {
    if (event.event_type !== GardenEventType.SOUL_GARDEN_TASK_COMPLETED) {
      continue;
    }
    const payload = SoulGardenTaskCompletedPayloadSchema.parse(event.payload_json);
    return payload.objects_affected;
  }
  throw new Error(
    `Garden task ${taskId} has no SOUL_GARDEN_TASK_COMPLETED event — completion did not materialize signals.`
  );
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

// see also: apps/bench-runner/src/version.ts
