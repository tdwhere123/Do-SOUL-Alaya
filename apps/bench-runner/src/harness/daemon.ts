import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveBenchRunnerVersion } from "../shared/version.js";
import {
  drainEmbeddingWarmupPasses,
  formatEmbeddingWarmupNotReadyError,
  type BenchDaemonHandle,
  type BenchDaemonOptions,
  type BenchEmbeddingProviderKind,
  type BenchEmbeddingWarmupOptions,
  type BenchEmbeddingWarmupSummary,
  type BenchQueryEmbeddingWarmupSummary,
  type BenchRecallOptions,
  type BenchReportContextUsageInput,
  type BenchWorkspaceHandle
} from "./daemon-types.js";
export { rotatingSeedObjectKind, type SeedObjectKind, BENCH_SEED_ROTATION } from "./seed-rotation.js";
export {
  drainEmbeddingWarmupPasses,
  formatEmbeddingWarmupNotReadyError,
  type BenchContextUsageObject,
  type BenchDaemonHandle,
  type BenchDaemonOptions,
  type BenchEmbeddingMode,
  type BenchEmbeddingProviderKind,
  type BenchEmbeddingWarmupOptions,
  type BenchEmbeddingWarmupSummary,
  type BenchQueryEmbeddingWarmupSummary,
  type BenchRecallOptions,
  type BenchReportContextUsageInput,
  type BenchSignalSeedInput,
  type BenchSynthesisSeedInput,
  type BenchTokenMetrics,
  type BenchWorkspaceHandle,
  type CompileSeedBatchResult,
  type CompileSeedDropReason,
  type CompileSeedSignalDrop,
  type DrainEmbeddingWarmupPassesInput,
  type DrainEmbeddingWarmupPassesResult,
  type SeededMemoryResult,
  type SeededSynthesisResult
} from "./daemon-types.js";
export {
  applyBenchFastPragmaIfRequested,
  readEmbeddingWarmupSummary
} from "./daemon-support.js";
export type { BenchFastPragmaResult } from "./daemon-support.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  ControlPlaneObjectKind,
  RetentionPolicy,
  SoulMemorySearchResponseSchema,
  TaskObjectSurfaceSchema,
  type RecallPolicy,
  type RecallCandidate,
  type SoulActiveConstraint,
  type SoulMemorySearchResponse,
  type SoulReportContextUsageResponse
} from "@do-soul/alaya-protocol";
import { createAlayaDaemonRuntime, type AlayaDaemonRuntime } from "@do-soul/alaya";
import { createAlayaMcpServer } from "@do-soul/alaya/mcp-server";
import { createBenchSeedOps } from "./daemon-seed.js";
import {
  applyBenchFastPragmaIfRequested,
  buildBenchDiagnosticRecallPolicy,
  buildBenchMemorySearchResult,
  buildBenchRecallStrategyMix,
  callMcpTool,
  closeBenchDaemonResources,
  emitBenchContextLensAssembledEvent,
  makeDispatchCli,
  optimizeBenchDb,
  queryEdgeProposalKpiRows,
  queryTokenMetrics,
  readEmbeddingWarmupSummary,
  readMaterializedObjects,
  requireBenchOpenAiSecretRef,
  resolveBenchOpenAiSecretRef,
  restoreEnv,
  seedBenchRunOnly,
  seedBenchWorkspaceAndRun,
  seedBenchWorkspaceIfAbsent,
  withEmbeddingFusionWeightInjected
} from "./daemon-support.js";
import { BenchRecallDiagnosticsSchema } from "./recall-diagnostics-schema.js";
import { applyBenchRecallWeightOverrides } from "./recall-weight-overrides.js";

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
  "ALAYA_RECALL_SOURCE_REF_ROBUST",
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
const BENCH_EDGE_PLANE_ENV = "ALAYA_BENCH_RUN_EDGE_PLANE";
// invariant: bounds the no-progress passes warmup tolerates before giving up,
// large enough to outlast the per-pass Librarian slot competition (the runtime
// dispatches one Librarian task per pass) so EMBEDDING_BACKFILL eventually wins
// the slot, small enough that a genuinely stuck embedding terminates.
// see also: apps/core-daemon/src/garden-runtime.ts LIBRARIAN_RUNTIME_TASK_KINDS
const EMBEDDING_WARMUP_MAX_STALL_PASSES = 10;
let activeBenchDaemonCount = 0;

function shouldRunBenchEdgePlane(): boolean {
  const raw = process.env[BENCH_EDGE_PLANE_ENV];
  if (raw === undefined) {
    return false;
  }
  const normalized = raw.trim().toLowerCase();
  return normalized !== "0" && normalized !== "off" && normalized !== "false";
}

export async function startBenchDaemon(
  opts: BenchDaemonOptions = {}
): Promise<BenchDaemonHandle> {
  const defaultWorkspaceId = opts.workspaceId ?? "bench-workspace-1";
  const defaultRunId = opts.runId ?? "bench-run-1";
  // @anchor bench-active-context: the workspace/run identity bench tool
  // calls bind. Per-call workspace switching (attachWorkspace) mutates the
  // same cell so the MCP contextProvider, recall(), proposeMemoryFromSignal()
  // etc all observe the current workspace without re-emitting the daemon.
  const activeContext: { workspaceId: string; runId: string } = {
    workspaceId: defaultWorkspaceId,
    runId: defaultRunId
  };
  const knownWorkspaces = new Set<string>([defaultWorkspaceId]);
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
  const managedWorkspaceRoots = new Map<string, string>();

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
    // Conversational corpora seed round-labeled evidence refs (s{si}-r{ri}); the
    // robust parser is what makes source_proximity resolve them. Default it on
    // for bench while production keeps env control.
    process.env.ALAYA_RECALL_SOURCE_REF_ROBUST = savedEnv.ALAYA_RECALL_SOURCE_REF_ROBUST ?? "true";

    runtime = await createAlayaDaemonRuntime();
    // The bench daemon deliberately does NOT call runtime.startBackgroundServices().
    // That would start the daemon's autonomous GardenScheduler (a 60s setInterval
    // plus a startup pass), which peekPendings POST_TURN_EXTRACT tasks across all
    // workspaces and would fire mid-seed-loop — racing the bench's explicit
    // in-process compile-signal seed path. A benchmark needs deterministic
    // Garden control: the bench drives every garden task explicitly.
    //
    // Embedding readiness (ON-only) uses the TARGETED
    // runtime.runGardenEmbeddingBackfillPass(workspaceId), NOT the full
    // runGardenBackgroundPass(). The ~156k auto-edges are produced by the
    // BULK_ENRICH worker (EdgeAutoProducer + ConflictDetectionService run there,
    // OFF the materialization path — MaterializationRouter does not run them
    // inline), which only the full background pass drains. embedding-OFF never
    // runs any of that, so the targeted backfill keeps ON's seeded corpus
    // identical to OFF (comparability) while skipping the CPU-heavy edge work.
    // Neither pass depends on startBackgroundServices() having run, so
    // suppressing the autonomous interval keeps the explicit path intact.
    // see also: apps/core-daemon/src/garden-runtime.ts runEmbeddingBackfillPass;
    //   packages/soul/src/garden/materialization-router/router.ts (EdgeAutoProducer off-path)

    server = createAlayaMcpServer({
      memoryToolHandler: runtime.services.mcpMemoryToolHandler,
      contextProvider: () => ({
        workspaceId: activeContext.workspaceId,
        runId: activeContext.runId,
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
        default_workspace: defaultWorkspaceId,
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
    // see also: apps/core-daemon/src/__tests__/agent-use-protocol.test.ts
    //   workspace + run seeding fixture using the same repos.
    await seedBenchWorkspaceAndRun(
      dataDir,
      defaultWorkspaceId,
      defaultRunId,
      await createManagedWorkspaceRoot(defaultWorkspaceId)
    );
    // Apply bench-only SQLite tuning. The DB has now been opened by install +
    // seedBenchWorkspaceAndRun, so initDatabase's cache returns the daemon's
    // live connection. Production daemon (apps/core-daemon) never calls this.
    const pragmaResult = applyBenchFastPragmaIfRequested(dataDir);
    if (pragmaResult.applied) {
      process.stderr.write(
        `[bench fast-pragma] applied: ${pragmaResult.pragmas.join(", ")}\n`
      );
    }
  } catch (err) {
    try {
      await closeBenchDaemonResources({ mcpClient, server, runtime });
    } finally {
      await cleanupManagedWorkspaceRoots();
      restoreEnv(MANAGED_ENV_KEYS, savedEnv);
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
    restoreEnv(MANAGED_ENV_KEYS, savedEnv);
    releaseActive();
    throw new Error("bench daemon startup did not initialize required resources");
  }

  const activeRuntime = runtime;
  const activeServer = server;
  const activeMcpClient = mcpClient;
  const activeDispatchCli = dispatchCliFn;
  // The bench shares one DB across all questions, so as it fills the SQLite
  // planner (without fresh stats) mis-picks a low-selectivity index and
  // near-full-scans growing tables — recall latency degrades O(rows). Refresh
  // stats periodically so workspace-scoped queries keep the workspace_id index.
  let benchRecallsSinceOptimize = 0;
  const BENCH_OPTIMIZE_EVERY = 25;
  const {
    proposeMemory,
    proposeMemoryFromSignal,
    proposeMemoriesFromCompileSignals,
    proposeSynthesis,
    accrueSessionCoRecall,
    accrueCoherenceCoRecall
  } = createBenchSeedOps({
    activeRuntime,
    activeContext,
    callMcpTool: (name, args) => callMcpTool(activeMcpClient, name, args),
    readMaterializedObjects: (signalId) => readMaterializedObjects(dataDir, signalId),
    reviewerIdentity: REVIEWER_IDENTITY,
    reviewerToken: REVIEWER_TOKEN
  });

  async function recall(
    query: string,
    recallOpts: BenchRecallOptions = {}
  ): Promise<SoulMemorySearchResponse & { readonly diagnostics?: unknown }> {
    benchRecallsSinceOptimize += 1;
    if (benchRecallsSinceOptimize >= BENCH_OPTIMIZE_EVERY) {
      benchRecallsSinceOptimize = 0;
      optimizeBenchDb(dataDir);
    }
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
      workspaceId: activeContext.workspaceId,
      strategy: "chat",
      runId: activeContext.runId,
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
      workspace_id: activeContext.workspaceId,
      run_id: activeContext.runId,
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
      runId: activeContext.runId,
      workspaceId: activeContext.workspaceId
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
    const readSummary = (passCount: number): Promise<BenchEmbeddingWarmupSummary> =>
      readEmbeddingWarmupSummary({
        dataDir,
        workspaceId: activeContext.workspaceId,
        objectIds: uniqueObjectIds,
        providerKind: embeddingProviderKind,
        modelId,
        schemaVersion: BENCH_EMBEDDING_SCHEMA_VERSION,
        passCount
      });

    const drain = await drainEmbeddingWarmupPasses({
      maxPasses,
      maxStallPasses: EMBEDDING_WARMUP_MAX_STALL_PASSES,
      // invariant: embedding readiness drains ONLY EMBEDDING_BACKFILL, not the
      // full Garden background pass. runGardenBackgroundPass would also drain
      // BULK_ENRICH conflict-detection/edge-production, path snapshot, merge
      // proposal, consolidation, etc. — CPU-heavy maintenance that embedding
      // OFF never runs, so coupling it to warmup both slowed ON ~15x and broke
      // OFF/ON corpus comparability. The targeted drain reaches the same
      // all-ready state via the O(n) backfill handler.
      // see also: apps/core-daemon/src/garden-runtime.ts runEmbeddingBackfillPass
      runPass: () => activeRuntime.runGardenEmbeddingBackfillPass(activeContext.workspaceId),
      readSummary
    });
    const summary = drain.summary;

    if (summary.ready_count !== summary.expected_count) {
      throw new Error(formatEmbeddingWarmupNotReadyError(summary, drain.lastPassError));
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
      workspaceId: activeContext.workspaceId,
      runId: activeContext.runId,
      queryTexts
    });
    return summary;
  }

  async function runEdgePlanePassIfConfigured(): Promise<void> {
    if (!shouldRunBenchEdgePlane()) {
      return;
    }
    await activeRuntime.runGardenBulkEnrichPass(activeContext.workspaceId);
  }

  async function shutdown(): Promise<void> {
    try {
      await closeBenchDaemonResources({
        mcpClient: activeMcpClient,
        server: activeServer,
        runtime: activeRuntime
      });
    } finally {
      await cleanupManagedWorkspaceRoots();
      restoreEnv(MANAGED_ENV_KEYS, savedEnv);
      releaseActive();
    }
  }

  async function createManagedWorkspaceRoot(workspaceId: string): Promise<string> {
    const workspaceRoot = join(
      dataDir,
      "bench-workspaces",
      encodeURIComponent(workspaceId)
    );
    await mkdir(workspaceRoot, { recursive: true });
    managedWorkspaceRoots.set(workspaceId, workspaceRoot);
    return workspaceRoot;
  }

  async function cleanupManagedWorkspaceRoot(workspaceId: string): Promise<void> {
    const workspaceRoot = managedWorkspaceRoots.get(workspaceId);
    if (workspaceRoot === undefined) return;
    managedWorkspaceRoots.delete(workspaceId);
    await rm(workspaceRoot, { recursive: true, force: true }).catch(() => undefined);
  }

  async function cleanupManagedWorkspaceRoots(): Promise<void> {
    const workspaceIds = [...managedWorkspaceRoots.keys()];
    await Promise.all(
      workspaceIds.map(async (workspaceId) => {
        await cleanupManagedWorkspaceRoot(workspaceId);
      })
    );
  }

  // @anchor bench-workspace-attach: bind activeContext to a workspace/run
  // pair for subsequent tool calls. FK seed for signals.workspace_id /
  // signals.run_id (migration 003-signals.sql) happens once per workspaceId.
  // invariant: only one workspace is bound to activeContext at a time.
  // see also: seedBenchWorkspaceAndRun, seedBenchRunOnly, BenchWorkspaceHandle
  async function attachWorkspace(
    input: { readonly workspaceId: string; readonly runId: string }
  ): Promise<BenchWorkspaceHandle> {
    const managedWorkspaceRoot = await createManagedWorkspaceRoot(input.workspaceId);
    if (!knownWorkspaces.has(input.workspaceId)) {
      // @anchor recall-eval-snapshot-restore: a restored snapshot DB already
      // carries the seeded workspace rows; the daemon's in-memory
      // knownWorkspaces Set starts empty, so probe the DB and seed only the run
      // when the workspace row already exists (recreating it would violate the
      // workspaces.workspace_id UNIQUE constraint). see also:
      // apps/bench-runner/src/longmemeval/recall-eval.ts
      await seedBenchWorkspaceIfAbsent(
        dataDir,
        input.workspaceId,
        input.runId,
        managedWorkspaceRoot
      );
      knownWorkspaces.add(input.workspaceId);
    } else {
      await seedBenchRunOnly(dataDir, input.workspaceId, input.runId);
    }
    const previous: { workspaceId: string; runId: string } = {
      workspaceId: activeContext.workspaceId,
      runId: activeContext.runId
    };
    activeContext.workspaceId = input.workspaceId;
    activeContext.runId = input.runId;
    let detached = false;
    return {
      workspaceId: input.workspaceId,
      runId: input.runId,
      recall,
      warmEmbeddingCache,
      warmQueryEmbeddingCache,
      reportContextUsage,
      proposeMemory,
      proposeMemoryFromSignal,
      proposeMemoriesFromCompileSignals,
      proposeSynthesis,
      accrueSessionCoRecall,
      accrueCoherenceCoRecall,
      queryTokenMetrics: () => queryTokenMetrics(dataDir, input.workspaceId),
      queryEdgeProposalKpiRows: () => queryEdgeProposalKpiRows(dataDir, input.workspaceId),
      detach: async () => {
        if (detached) return;
        detached = true;
        if (
          activeContext.workspaceId === input.workspaceId &&
          activeContext.runId === input.runId
        ) {
          activeContext.workspaceId = previous.workspaceId;
          activeContext.runId = previous.runId;
        }
        await cleanupManagedWorkspaceRoot(input.workspaceId);
      }
    };
  }

  return {
    runtime: activeRuntime,
    mcpClient: activeMcpClient,
    get workspaceId() {
      return activeContext.workspaceId;
    },
    get runId() {
      return activeContext.runId;
    },
    dataDir,
    dispatchCli: activeDispatchCli,
    recall,
    warmEmbeddingCache,
    warmQueryEmbeddingCache,
    runEdgePlanePassIfConfigured,
    reportContextUsage,
    proposeMemory,
    proposeMemoryFromSignal,
    proposeMemoriesFromCompileSignals,
    proposeSynthesis,
    accrueSessionCoRecall,
    accrueCoherenceCoRecall,
    queryTokenMetrics: () => queryTokenMetrics(dataDir, activeContext.workspaceId),
    queryEdgeProposalKpiRows: () => queryEdgeProposalKpiRows(dataDir, activeContext.workspaceId),
    attachWorkspace,
    shutdown
  };
}
