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
  RunMode,
  RunState,
  ScopeClass,
  SignalEventType,
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
  type SoulReviewMemoryProposalResponse
} from "@do-soul/alaya-protocol";
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
    runtime.startBackgroundServices();

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

    // Step 2: read SOUL_SIGNAL_MATERIALIZED from event_log to find the
    // memory object_id created synchronously by the materialization router.
    // The MCP surface returns only signal_id, so the bench harness consults
    // the daemon's event log directly (read-only). This is an
    // implementation-of-record lookup, not a bypass of governance.
    const memoryId = await readMaterializedMemoryId(
      dataDir,
      signalResponse.signal_id
    );

    // Step 3: propose update on the materialized memory so the
    // propose+review event chain (SOUL_PROPOSAL_CREATED, SOUL_REVIEW_*,
    // SOUL_PROPOSAL_RESOLVED, SOUL_MEMORY_UPDATED) is written to the
    // audit trail. The change is a no-op-ish domain_tag append; what
    // matters is that the chain fires for every seed.
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

    // Step 4: accept the proposal under the bench reviewer identity.
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

    return {
      memoryId,
      signalId: signalResponse.signal_id,
      proposalId: proposeResponse.proposal_id,
      truncated: wasTruncated,
      charsClipped
    };
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

function hasUsableEnvValue(value: string | undefined): boolean {
  return value !== undefined && value.trim().length > 0;
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
