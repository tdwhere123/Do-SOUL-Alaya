import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { EdgeProposalKpiEventRow } from "@do-soul/alaya-eval";
import {
  ControlPlaneObjectKind,
  GraphAuditorEventType,
  RecallContextEventType,
  RetentionPolicy,
  RunMode,
  RunState,
  SignalEventType,
  SoulContextLensAssembledPayloadSchema,
  SoulSignalMaterializedPayloadSchema,
  WorkspaceKind,
  WorkspaceState,
  type MemorySearchResult,
  type RecallBudgetState,
  type RecallCandidate,
  type RecallPolicy,
  type RecallScoreFactors,
  type SoulRecallStrategyMix
} from "@do-soul/alaya-protocol";
import {
  initDatabase,
  SqliteEventLogRepo,
  SqliteMemoryEmbeddingRepo,
  SqliteRunRepo,
  SqliteWorkspaceRepo
} from "@do-soul/alaya-storage";
import {
  resolveSecretRef,
  type AlayaDaemonRuntime,
  type ResolveSecretError
} from "@do-soul/alaya";
import { createAlayaCliBridge } from "@do-soul/alaya/cli/bridge";
import { registerAlayaCliCommands } from "@do-soul/alaya/cli/register";
import { deriveBenchTokenMetrics } from "./token-economy.js";
import type {
  BenchEmbeddingWarmupSummary,
  BenchTokenMetrics
} from "./daemon-types.js";
import type { BenchRecallWeightOverrides } from "./recall-weight-overrides.js";

export async function readEmbeddingWarmupSummary(input: {
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
  const records = await embeddingRepo.findMetadataByObjectIds(expectedIds);
  const readyIds = new Set(
    records
      .filter(
        (record) =>
          record.workspace_id === input.workspaceId &&
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

export function resolveBenchOpenAiSecretRef(
  savedEnv: Partial<Record<string, string | undefined>>
): string {
  return savedEnv.ALAYA_OPENAI_SECRET_REF?.trim() || "env:OPENAI_API_KEY";
}

export function requireBenchOpenAiSecretRef(secretRef: string): void {
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
    default:
      return `${prefix}; secret resolution failed`;
  }
}

export async function closeBenchDaemonResources(resources: {
  readonly mcpClient?: Client;
  readonly server?: { close(): Promise<unknown> };
  readonly runtime?: { shutdown(): Promise<unknown> };
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

export function makeDispatchCli(
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

export async function callMcpTool<TOutput>(
  client: Client,
  name: string,
  args: Record<string, unknown>
): Promise<TOutput> {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError === true) {
    const contentArray = Array.isArray(result.content)
      ? (result.content as readonly unknown[])
      : [];
    const errorText = contentArray
      .map((item) =>
        item !== null &&
        typeof item === "object" &&
        "text" in item &&
        typeof (item as { text: unknown }).text === "string"
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

export function withEmbeddingFusionWeightInjected(
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

// When enabled, the LongMemEval / LoCoMo seeders stamp a per-session surface_id
// so delivery-time session coverage has a grouping axis (off => surface_id null
// => coverage rerank is a no-op, default-identical recall).
export function benchSessionSurfacesEnabled(): boolean {
  const raw = process.env.ALAYA_BENCH_SESSION_SURFACES?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "on" || raw === "yes";
}

export function buildBenchDiagnosticRecallPolicy(
  taskSurfaceId: string,
  maxResultsInput: number,
  conflictAwareness = true
): RecallPolicy {
  const maxResults = Math.max(maxResultsInput, 1);
  const coarseCandidateLimit = Math.min(Math.max(maxResults * 10, maxResults), 1000);
  const keywordCandidateLimit = Math.min(
    Math.max(coarseCandidateLimit, maxResults * 10, 1),
    1000
  );
  // Diagnostic-only delivery token budget. Default 2000 = production口径; a wide
  // override lets a probe deliver the full ranked pool so gold-rank can tell
  // in-pool-ranked-low from absent-from-pool. No fusion-weight change.
  const maxTotalTokens = Math.max(
    2000,
    Math.floor(Number(process.env.ALAYA_BENCH_RECALL_MAX_TOKENS ?? "2000")) || 2000
  );
  // Embedding semantic-injection sweep knobs (embedding-on only). Unset => recall
  // service defaults.
  const rawInjectionCap = Number(
    process.env.ALAYA_BENCH_EMBEDDING_INJECTION_CAP ?? ""
  );
  const embeddingInjectionCap =
    Number.isInteger(rawInjectionCap) && rawInjectionCap >= 0
      ? rawInjectionCap
      : null;
  const rawInjectionFloor = Number(
    process.env.ALAYA_BENCH_EMBEDDING_INJECTION_FLOOR ?? ""
  );
  const embeddingInjectionFloor =
    Number.isFinite(rawInjectionFloor) &&
    rawInjectionFloor >= 0 &&
    rawInjectionFloor <= 1
      ? rawInjectionFloor
      : null;
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
        embedding_enabled: true,
        ...(embeddingInjectionCap === null
          ? {}
          : { injection_cap: embeddingInjectionCap }),
        ...(embeddingInjectionFloor === null
          ? {}
          : { injection_similarity_floor: embeddingInjectionFloor })
      }
    },
    fine_assessment: {
      budgets: {
        max_total_tokens: maxTotalTokens,
        max_entries: maxResults,
        per_dimension_limits: null
      },
      conflict_awareness: conflictAwareness
    }
  };
}

export function buildBenchMemorySearchResult(
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
    budget_state:
      candidate.budget_state ??
      buildBenchBudgetState(candidate, policy, index, usedTokensBeforeCandidate)
  };
}

export function buildBenchRecallStrategyMix(
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
  const origin =
    candidate.origin_plane === "global" ? "global recall" : "workspace recall";
  return `Selected by ${origin} with relevance ${candidate.relevance_score.toFixed(3)} and activation ${candidate.activation_score.toFixed(3)}.`;
}

function buildBenchSourceChannels(
  candidate: Readonly<RecallCandidate>
): readonly string[] {
  const channels = ["ranked_recall", candidate.origin_plane] as string[];
  if (candidate.is_advisory === true) {
    channels.push("advisory");
  }
  return channels;
}

function buildBenchScoreFactors(
  candidate: Readonly<RecallCandidate>
): RecallScoreFactors {
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
    within_budget:
      index < maxEntries && usedTokensThroughCandidate <= maxTotalTokens
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
export async function readMaterializedObjects(
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
export function emitBenchContextLensAssembledEvent(
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
// and reads EventLog rows, never in-memory bench state. SOUL_SIGNAL_EMITTED
// rows now carry only a redacted raw_payload summary (hash + bench numeric
// token counts), so the fold derives token economy without re-exposing the
// seeded text through EventLog. The pure event -> metrics fold lives in
// harness/token-economy.ts deriveBenchTokenMetrics so it is unit-testable
// against a stubbed EventLog. The connection is NOT closed here.
// invariant: scope the event read to the question's workspace. The bench
// daemon-per-run model shares ONE alaya.db across every attached workspace,
// so an unscoped queryByType returns every prior question's events too —
// turning each per-question fold into an O(all-prior-questions) scan AND
// double-counting every earlier question into this question's token metrics
// (the run-level aggregateBenchTokenMetrics then SUMS those cumulative
// snapshots). queryByWorkspaceAndType uses idx_event_log_workspace_type_created
// so the read stays bounded to this workspace's own emitted/lens events.
// see also: packages/storage/src/repos/runtime/event-log-repo.ts queryByWorkspaceAndType
export async function queryTokenMetrics(
  dataDir: string,
  workspaceId: string
): Promise<BenchTokenMetrics> {
  const db = initDatabase({ filename: join(dataDir, "alaya.db") });
  const eventLogRepo = new SqliteEventLogRepo(db);
  const emittedEvents = await eventLogRepo.queryByWorkspaceAndType(
    workspaceId,
    SignalEventType.SOUL_SIGNAL_EMITTED
  );
  const lensEvents = await eventLogRepo.queryByWorkspaceAndType(
    workspaceId,
    RecallContextEventType.SOUL_CONTEXT_LENS_ASSEMBLED
  );
  return deriveBenchTokenMetrics(emittedEvents, lensEvents);
}

// @anchor queryEdgeProposalKpiRows: event-sourced edge proposal KPI reader.
// Same shape as queryTokenMetrics — opens the bench DB and reads the two
// proposal event types, returning the minimal structural row shape the
// aggregator in @do-soul/alaya-eval consumes. The aggregator is pure so it
// stays unit-testable without standing up storage.
// see also: packages/eval/src/metrics/edge-proposal-kpi.ts
// invariant: scope to the question's workspace, for the same reason
// queryTokenMetrics does — the shared daemon-per-run DB would otherwise
// re-deliver every prior question's edge-proposal events on each call,
// duplicating them into edgeProposalKpiRowsAcrossQuestions and growing the
// scan with the question index.
export async function queryEdgeProposalKpiRows(
  dataDir: string,
  workspaceId: string
): Promise<readonly EdgeProposalKpiEventRow[]> {
  const db = initDatabase({ filename: join(dataDir, "alaya.db") });
  const eventLogRepo = new SqliteEventLogRepo(db);
  const createdEvents = await eventLogRepo.queryByWorkspaceAndType(
    workspaceId,
    GraphAuditorEventType.SOUL_GRAPH_EDGE_PROPOSAL_CREATED
  );
  const reviewedEvents = await eventLogRepo.queryByWorkspaceAndType(
    workspaceId,
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

// @anchor BENCH_FAST_PRAGMA: bench-only SQLite tuning layered on top of the
// production storage hardening (packages/storage/src/sqlite/db.ts already sets
// journal_mode=WAL + synchronous=NORMAL + foreign_keys + busy_timeout). The
// bench harness adds two pragmas that production deliberately leaves at
// default because they change the durability vs throughput tradeoff:
//
//   temp_store=FILE         — FTS/sort/GROUP BY temp B-trees spill to disk.
//                             temp_store=MEMORY forces them into RAM that is
//                             off the Node heap and so invisible to
//                             --max-old-space-size; over a long single-process
//                             500-question run that RAM climbs monotonically
//                             and feeds the OS OOM-killer (a silent SIGKILL,
//                             not a recoverable Node OOM). FILE trades latency
//                             for headroom and is the safe default for full
//                             runs. Override with ALAYA_BENCH_TEMP_STORE=memory
//                             for short throughput-bound runs that fit in RAM.
//   cache_size=-65536       — 64 MiB page cache (negative = KiB). Default is
//                             ~2 MiB which is too small for the bench
//                             hot-set; production leaves it small for
//                             desktop multi-process coexistence.
//
// Gated by ALAYA_BENCH_FAST_PRAGMA env (default: ON for bench harness; set
// "0"/"false" to opt out). Production `apps/core-daemon` does not call this
// helper, so no production runtime is affected.
//
// invariant: EventLog rows are still appended via the same SqliteEventLogRepo
// path; only the SQLite write batching/fsync timing changes. WAL still
// guarantees atomic per-statement commit; synchronous=NORMAL guarantees
// system-crash recovery on the WAL frame boundary (only power-loss within
// the last few ms of WAL flush is at risk, which bench fixtures can replay).
const BENCH_FAST_PRAGMA_ENV = "ALAYA_BENCH_FAST_PRAGMA";
const BENCH_TEMP_STORE_ENV = "ALAYA_BENCH_TEMP_STORE";

function isBenchFastPragmaEnabled(): boolean {
  const raw = process.env[BENCH_FAST_PRAGMA_ENV];
  if (raw === undefined) return true;
  const normalized = raw.trim().toLowerCase();
  return (
    normalized !== "0" &&
    normalized !== "false" &&
    normalized !== "off" &&
    normalized !== "no"
  );
}

// FILE by default so temp B-trees spill to disk and do not feed RSS toward the
// OS OOM-killer on long single-process runs. ALAYA_BENCH_TEMP_STORE=memory opts
// back into the throughput-favoring RAM temp store for short runs.
function resolveBenchTempStore(): "FILE" | "MEMORY" {
  const raw = process.env[BENCH_TEMP_STORE_ENV];
  return raw !== undefined && raw.trim().toLowerCase() === "memory"
    ? "MEMORY"
    : "FILE";
}

export interface BenchFastPragmaResult {
  readonly applied: boolean;
  readonly pragmas: readonly string[];
}

// Refresh SQLite query-planner stats on the daemon's live connection (initDatabase
// caches by path) so workspace-scoped recall keeps the workspace_id index instead
// of near-full-scanning the growing shared bench DB. Best-effort.
export function optimizeBenchDb(dataDir: string): void {
  try {
    initDatabase({ filename: join(dataDir, "alaya.db") }).optimize();
  } catch {
    // never fail a recall on a stats refresh
  }
}

export function applyBenchFastPragmaIfRequested(
  dataDir: string
): BenchFastPragmaResult {
  if (!isBenchFastPragmaEnabled()) {
    return Object.freeze({ applied: false, pragmas: Object.freeze([]) });
  }
  // initDatabase caches by path, so this returns the same connection the
  // daemon runtime is already using. The pragmas are session-scoped except
  // journal_mode (file-scoped + persisted) — re-issuing the production set
  // here is a no-op and documents the bench layering.
  const db = initDatabase({ filename: join(dataDir, "alaya.db") });
  const conn = db.connection;
  // Production-set pragmas (re-asserted defensively; safe no-op when already on).
  conn.pragma("journal_mode = WAL");
  conn.pragma("synchronous = NORMAL");
  // Bench-only adds.
  const tempStore = resolveBenchTempStore();
  conn.pragma(`temp_store = ${tempStore}`);
  conn.pragma("cache_size = -65536");
  return Object.freeze({
    applied: true,
    pragmas: Object.freeze([
      "journal_mode=WAL",
      "synchronous=NORMAL",
      `temp_store=${tempStore}`,
      "cache_size=-65536"
    ])
  });
}

export async function seedBenchWorkspaceAndRun(
  dataDir: string,
  workspaceId: string,
  runId: string,
  workspaceRoot: string
): Promise<void> {
  const db = initDatabase({ filename: join(dataDir, "alaya.db") });
  const workspaceRepo = new SqliteWorkspaceRepo(db);
  const runRepo = new SqliteRunRepo(db);
  workspaceRepo.create({
    workspace_id: workspaceId,
    name: workspaceId,
    root_path: workspaceRoot,
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

// @anchor seedBenchWorkspaceIfAbsent — first-attach seed that tolerates a
// workspace row already present in a restored recall-eval snapshot DB. Probes
// the workspace by id: absent -> create workspace + run (normal first attach);
// present -> seed only the run, idempotently, since the snapshot already holds
// the materialized workspace. see also: seedBenchWorkspaceAndRun, seedBenchRunOnly
export async function seedBenchWorkspaceIfAbsent(
  dataDir: string,
  workspaceId: string,
  runId: string,
  workspaceRoot: string
): Promise<void> {
  const db = initDatabase({ filename: join(dataDir, "alaya.db") });
  const workspaceRepo = new SqliteWorkspaceRepo(db);
  const existing = await workspaceRepo.getById(workspaceId);
  if (existing === null) {
    await seedBenchWorkspaceAndRun(dataDir, workspaceId, runId, workspaceRoot);
    return;
  }
  await seedBenchRunIfAbsent(dataDir, workspaceId, runId);
}

// @anchor seedBenchRunOnly — extend an already-created workspace with a
// fresh run row; bench attachWorkspace path when the workspaceId is reused
// across rebinds. see also: seedBenchWorkspaceAndRun
export async function seedBenchRunOnly(
  dataDir: string,
  workspaceId: string,
  runId: string
): Promise<void> {
  await seedBenchRunIfAbsent(dataDir, workspaceId, runId);
}

// Idempotent run seed: a restored snapshot already carries the run row keyed by
// the same runId the sidecar persisted, so a duplicate create would violate the
// runs.run_id constraint. Skip when the run already exists.
async function seedBenchRunIfAbsent(
  dataDir: string,
  workspaceId: string,
  runId: string
): Promise<void> {
  const db = initDatabase({ filename: join(dataDir, "alaya.db") });
  const runRepo = new SqliteRunRepo(db);
  const existing = await runRepo.getById(runId);
  if (existing !== null) {
    return;
  }
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

export function restoreEnv(
  keys: readonly string[],
  saved: Partial<Record<string, string | undefined>>
): void {
  for (const key of keys) {
    const prev = saved[key];
    if (prev === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = prev;
    }
  }
}
