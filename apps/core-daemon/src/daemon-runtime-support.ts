import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  AcceptedBy,
  DEFAULT_SOUL_CONFIG,
  ProjectMappingState,
  type AgentRuntimePort,
  type EngineBinding,
  type EngineBindingSummary,
  type EventLogEntry,
  type GlobalMemoryEntry,
  type GardenBacklogThresholds,
  type SoulGraph
} from "@do-soul/alaya-protocol";
import {
  ArbitrationService,
  CanonicalAliasService,
  ClaimService,
  CoreError,
  ProjectMappingService,
  StrongRefService,
  ToolGovernanceClient,
  SqliteKarmaEventStore,
  createGlobalMemoryRecallPort as createCoreGlobalMemoryRecallPort,
  type GlobalMemoryRecallCachePort,
  type GlobalMemoryRecallServicePort
} from "@do-soul/alaya-core";
import * as StorageModule from "@do-soul/alaya-storage";
import {
  SqliteEventLogRepo,
  SqliteGlobalMemoryRecallCacheRepo,
  SqliteGlobalMemoryRepo,
  SqliteKarmaEventRepo,
  SqliteMemoryEntryRepo,
  SqliteMemoryGraphEdgeRepo,
  SqliteToolExecutionRecordRepo,
  type GlobalMemoryRecallCacheRepo,
  type GlobalMemoryRepo,
  type MemoryEmbeddingRepo,
  type StorageDatabase
} from "@do-soul/alaya-storage";
import { createWarnLogger } from "./daemon-runtime-helpers.js";
import type { RequestProtectionConfig } from "./app.js";
import type { AlayaConfigPaths } from "./cli/config-files.js";
import type { DaemonStartupStepRecord } from "./daemon-runtime-types.js";
import { parseEnv } from "./services/env-file-service.js";
import { resolveConfiguredDatabasePath } from "./storage-config.js";
import { isNodeErrorWithCode } from "./services/private-file-service.js";
import { resolveSecretRef, type ResolveSecretError } from "./secrets.js";
import type { AlayaRuntimeNotifier } from "./runtime-notifier.js";

export const DEFAULT_OPENAI_EMBEDDING_MODEL = "text-embedding-3-small";
export const ALAYA_OFFICIAL_GARDEN_SECRET_REF_ENV = "ALAYA_OFFICIAL_GARDEN_SECRET_REF";
export const OFFICIAL_API_GARDEN_MODEL_ENV = "OFFICIAL_API_GARDEN_MODEL";
export const OFFICIAL_API_GARDEN_PROVIDER_URL_ENV = "OFFICIAL_API_GARDEN_PROVIDER_URL";
const GARDEN_BACKLOG_REARM_RATIO = 0.7;
const GARDEN_BACKLOG_SNAPSHOT_INTERVAL_MS = 60_000;

type GlobalMemoryListFilters = Parameters<GlobalMemoryRepo["list"]>[0];
type MemoryEntryRecord = Awaited<ReturnType<SqliteMemoryEntryRepo["findByWorkspaceId"]>>[number];

export function createRequestProtection(): RequestProtectionConfig {
  return Object.freeze({
    allowedOrigin: process.env.ALLOWED_ORIGIN ?? "http://localhost:5173",
    requestToken: process.env.ALAYA_REQUEST_TOKEN ?? randomBytes(32).toString("hex"),
    allowDesktopOriginlessRequests: true
  });
}

export function recordStartupStep(
  startupSteps: DaemonStartupStepRecord[],
  step: DaemonStartupStepRecord["step"]
): void {
  startupSteps.push({
    step,
    completedAt: new Date().toISOString()
  });
}

export async function listServerHardConstraints(_workspaceId: string) {
  return Object.freeze([
    Object.freeze({
      ref: "constraint://worker-dispatch",
      content: "Never mutate files outside approved workspace roots."
    })
  ]);
}

export async function resolveDatabasePath(
  configPaths: AlayaConfigPaths,
  fallbackPath: string
): Promise<string> {
  return await resolveConfiguredDatabasePath(configPaths, {
    env: process.env,
    fallbackPath
  });
}

export function createGardenBacklogThresholds(): GardenBacklogThresholds {
  const warningQueueDepth = DEFAULT_SOUL_CONFIG.garden_backlog_soft_limit;

  return {
    warning_queue_depth: warningQueueDepth,
    warning_rearm_depth: Math.max(0, Math.floor(warningQueueDepth * GARDEN_BACKLOG_REARM_RATIO)),
    snapshot_interval_ms: GARDEN_BACKLOG_SNAPSHOT_INTERVAL_MS
  };
}

export async function loadConfigEnv(envPath: string): Promise<ReadonlyMap<string, string>> {
  try {
    return parseEnv(await readFile(envPath, "utf8"));
  } catch (error) {
    if (isNodeErrorWithCode(error, "ENOENT")) {
      return new Map();
    }
    throw error;
  }
}

export function readConfigEnvValue(configEnv: ReadonlyMap<string, string>, key: string): string | undefined {
  return process.env[key] ?? configEnv.get(key);
}

export function readNonEmptyEnv(value: string | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

export function readOptionalSecretRef(value: string | undefined, label: string): string | null {
  const rawValue = readNonEmptyEnv(value);
  if (rawValue === null) {
    return null;
  }

  const resolved = resolveSecretRef(rawValue);
  if ("kind" in resolved) {
    throw new Error(formatSecretResolutionError(label, resolved));
  }

  return resolved.value;
}

export function readOfficialGardenSecretRef(configEnv: ReadonlyMap<string, string>): string | null {
  return readOptionalSecretRef(
    readConfigEnvValue(configEnv, ALAYA_OFFICIAL_GARDEN_SECRET_REF_ENV),
    ALAYA_OFFICIAL_GARDEN_SECRET_REF_ENV
  );
}

export function readOfficialGardenModelId(configEnv: ReadonlyMap<string, string>): string | null {
  return readNonEmptyEnv(readConfigEnvValue(configEnv, OFFICIAL_API_GARDEN_MODEL_ENV));
}

export function readOfficialGardenProviderUrl(configEnv: ReadonlyMap<string, string>): string | null {
  return readNonEmptyEnv(readConfigEnvValue(configEnv, OFFICIAL_API_GARDEN_PROVIDER_URL_ENV));
}

export function createOptionalMemoryEmbeddingRepo(database: StorageDatabase): MemoryEmbeddingRepo | null {
  const RepoCtor = StorageModule.SqliteMemoryEmbeddingRepo;
  if (typeof RepoCtor !== "function" || !supportsPreparedSqliteConnection(database)) {
    return null;
  }

  return new RepoCtor(database);
}

export function createOptionalGlobalMemoryRepo(database: StorageDatabase): GlobalMemoryRepo | null {
  if (!supportsPreparedSqliteConnection(database)) {
    return null;
  }

  return new SqliteGlobalMemoryRepo(database);
}

export function createOptionalGlobalMemoryRecallCacheRepo(
  database: StorageDatabase
): GlobalMemoryRecallCacheRepo | null {
  if (!supportsPreparedSqliteConnection(database)) {
    return null;
  }

  return new SqliteGlobalMemoryRecallCacheRepo(database);
}

export function createGlobalMemoryRouteService(params: {
  readonly globalMemoryRepo: GlobalMemoryRepo;
  readonly projectMappingService: ProjectMappingService;
}) {
  return {
    list: async (input: { readonly dimension?: string; readonly scope_class?: string; readonly limit: number }) => {
      const entries = await params.globalMemoryRepo.list({
        ...(input.dimension === undefined ? {} : { dimension: input.dimension }),
        ...(input.scope_class === undefined ? {} : { scope_class: input.scope_class })
      } as GlobalMemoryListFilters);

      return input.limit >= entries.length ? entries : entries.slice(0, input.limit);
    },
    adopt: async (
      globalObjectId: string,
      input: { readonly workspace_id: string; readonly accepted_by?: AcceptedBy }
    ) => await adoptGlobalMemoryEntry(params.globalMemoryRepo, params.projectMappingService, globalObjectId, input)
  };
}

export function createGlobalMemoryRecallPort(params: {
  readonly globalMemoryRepo: GlobalMemoryRepo;
}): GlobalMemoryRecallServicePort {
  return createCoreGlobalMemoryRecallPort({
    globalMemorySource: {
      list: async () => await params.globalMemoryRepo.list()
    }
  });
}

export function createGlobalMemoryRecallCachePort(params: {
  readonly globalMemoryRecallCacheRepo: GlobalMemoryRecallCacheRepo;
  readonly now?: () => string;
}): GlobalMemoryRecallCachePort {
  const now = params.now ?? (() => new Date().toISOString());

  return {
    recordClassifications: async (records) => {
      const updatedAt = now();
      await params.globalMemoryRecallCacheRepo.upsertMany(
        records.map((record) => ({
          workspace_id: record.workspaceId,
          global_object_id: record.globalObjectId,
          classification: record.classification,
          updated_at: updatedAt
        }))
      );
    }
  };
}

export function createSoulGraphService(input: {
  readonly memoryEntryRepo: SqliteMemoryEntryRepo;
  readonly memoryGraphEdgeRepo: SqliteMemoryGraphEdgeRepo;
}) {
  return {
    buildSoulGraph: async ({
      workspaceId,
      limit
    }: {
      readonly workspaceId: string;
      readonly depth: number;
      readonly limit: number;
    }): Promise<SoulGraph> => {
      const memories = await input.memoryEntryRepo.findByWorkspaceId(workspaceId);
      const edges = await input.memoryGraphEdgeRepo.findByWorkspace(workspaceId);
      const limitedMemories = memories.slice(0, limit);
      const memoryIds = new Set(limitedMemories.map((memory: MemoryEntryRecord) => memory.object_id));
      const limitedEdges = edges
        .filter((edge) => memoryIds.has(edge.source_memory_id) && memoryIds.has(edge.target_memory_id))
        .slice(0, limit);
      const tagProjection = buildDomainTagProjection(limitedMemories);

      return {
        workspace_id: workspaceId,
        nodes: [
          ...limitedMemories.map((memory: MemoryEntryRecord) => {
            const label = deriveMemoryNodeLabel(memory.content);
            const summary = deriveMemoryNodeSummary(memory.content, label);
            const node: SoulGraph["nodes"][number] = {
              id: memory.object_id,
              kind: "memory",
              label,
              workspace_id: memory.workspace_id,
              created_at: memory.created_at,
              scope_id: memory.scope_class,
              origin_plane: memory.scope_class === "project" ? "project" : "global"
            };
            return summary === undefined ? node : { ...node, summary };
          }),
          ...tagProjection.nodes
        ],
        edges: [
          ...limitedEdges.map((edge) => ({
            id: edge.edge_id,
            kind: "references" as const,
            source_id: edge.source_memory_id,
            target_id: edge.target_memory_id,
            created_at: edge.created_at
          })),
          ...tagProjection.edges
        ],
        truncated: memories.length > limitedMemories.length || edges.length > limitedEdges.length,
        node_total: memories.length + countUniqueDomainTags(memories),
        edge_total: edges.length + countDomainTagEdges(memories)
      };
    }
  };
}

function buildDomainTagProjection(memories: readonly MemoryEntryRecord[]): {
  readonly nodes: readonly SoulGraph["nodes"][number][];
  readonly edges: readonly SoulGraph["edges"][number][];
} {
  const tagMembers = new Map<string, MemoryEntryRecord[]>();
  const tagEdges: SoulGraph["edges"][number][] = [];

  for (const memory of memories) {
    for (const tag of uniqueDomainTags(memory)) {
      let members = tagMembers.get(tag);
      if (!members) {
        members = [];
        tagMembers.set(tag, members);
      }
      members.push(memory);
      tagEdges.push({
        id: `domain_tag:${memory.object_id}:${tag}`,
        kind: "belongs_to",
        source_id: memory.object_id,
        target_id: domainTagNodeId(tag),
        created_at: memory.created_at
      });
    }
  }

  return {
    nodes: [...tagMembers.entries()].map(([tag, members]) => ({
      id: domainTagNodeId(tag),
      kind: "scope",
      label: `#${tag}`,
      summary: deriveDomainTagSummary(members),
      scope_id: `domain_tag:${tag}`,
      origin_plane: "project"
    })),
    edges: tagEdges
  };
}

const MEMORY_NODE_LABEL_MAX = 80;
const MEMORY_NODE_SUMMARY_MAX = 280;
const DOMAIN_TAG_SAMPLE_LIMIT = 3;
const DOMAIN_TAG_SAMPLE_LABEL_MAX = 32;

function deriveMemoryNodeLabel(content: string): string {
  const firstLine = content.split(/\r?\n/, 1)[0]?.trim() ?? "";
  if (firstLine.length > 0) {
    return truncateWithEllipsis(firstLine, MEMORY_NODE_LABEL_MAX);
  }
  const fallback = content.trim();
  if (fallback.length === 0) {
    return "(empty)";
  }
  return truncateWithEllipsis(fallback, MEMORY_NODE_LABEL_MAX);
}

function deriveMemoryNodeSummary(content: string, label: string): string | undefined {
  const trimmed = content.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  if (trimmed === label) {
    return undefined;
  }
  return truncateWithEllipsis(trimmed, MEMORY_NODE_SUMMARY_MAX);
}

function deriveDomainTagSummary(members: readonly MemoryEntryRecord[]): string {
  const count = members.length;
  const sample = members
    .slice(0, DOMAIN_TAG_SAMPLE_LIMIT)
    .map((m) => truncateWithEllipsis(deriveMemoryNodeLabel(m.content), DOMAIN_TAG_SAMPLE_LABEL_MAX))
    .join(" · ");
  const noun = count === 1 ? "memory" : "memories";
  return sample.length > 0 ? `${count} ${noun} · ${sample}` : `${count} ${noun}`;
}

function truncateWithEllipsis(value: string, max: number): string {
  if (value.length <= max) {
    return value;
  }
  return `${value.slice(0, max - 1)}…`;
}

function uniqueDomainTags(memory: MemoryEntryRecord): readonly string[] {
  const tags = Array.isArray(memory.domain_tags) ? memory.domain_tags : [];
  return [...new Set(tags.map((tag) => tag.trim()).filter((tag) => tag.length > 0))];
}

function countUniqueDomainTags(memories: readonly MemoryEntryRecord[]): number {
  return new Set(memories.flatMap((memory) => uniqueDomainTags(memory))).size;
}

function countDomainTagEdges(memories: readonly MemoryEntryRecord[]): number {
  return memories.reduce((count, memory) => count + uniqueDomainTags(memory).length, 0);
}

function domainTagNodeId(tag: string): string {
  return `scope:domain_tag:${tag}`;
}

export function createConversationToolExecutor(input: {
  readonly eventLogRepo: SqliteEventLogRepo;
  readonly runtimeNotifier: AlayaRuntimeNotifier;
  readonly toolExecutionRecordRepo: SqliteToolExecutionRecordRepo;
  readonly toolGovernanceClient: ToolGovernanceClient;
  readonly targetRevalidateService: unknown;
  readonly strongRefService: StrongRefService;
  readonly canonicalAliasService: CanonicalAliasService;
}) {
  void input.toolGovernanceClient;
  void input.targetRevalidateService;
  void input.strongRefService;
  void input.canonicalAliasService;

  return {
    execute: async (request: {
      readonly toolId: string;
      readonly rawInput: unknown;
      readonly runtimeContext: { readonly run_id: string; readonly workspace_id: string };
      readonly workspaceRoot: string;
      readonly affectedPathRoots?: readonly string[];
      readonly handler: (context: { readonly writableRoots: readonly string[] }, rawInput?: unknown) => Promise< unknown>;
    }) => {
      const startedAt = new Date().toISOString();
      const result = await request.handler(
        { writableRoots: [request.workspaceRoot] },
        request.rawInput
      );
      const endedAt = new Date().toISOString();
      const executionId = randomUUID();
      const affectedPaths = request.affectedPathRoots ?? [];

      await input.toolExecutionRecordRepo.insert({
        execution_id: executionId,
        tool_id: request.toolId,
        requested_by: "principal",
        requesting_run_id: request.runtimeContext.run_id,
        governance_decision_ref: "fast-path://recorded",
        permission_result: "allow",
        executed: true,
        started_at: startedAt,
        ended_at: endedAt,
        result_summary: summarizeToolResult(result),
        rollback_status: "none",
        affected_paths: affectedPaths
      });
      const event = await input.eventLogRepo.append({
        event_type: "tool_call.completed",
        entity_type: "tool_call",
        entity_id: executionId,
        workspace_id: request.runtimeContext.workspace_id,
        run_id: request.runtimeContext.run_id,
        caused_by: "principal",
        payload_json: {
          tool_call_id: executionId,
          tool_id: request.toolId,
          permission_result: "allow",
          executed: true,
          affected_paths: affectedPaths,
          result_summary: summarizeToolResult(result)
        }
      });
      await input.runtimeNotifier.notifyEntry(event);

      return { result };
    }
  };
}

export function createAlayaConversationEngine() {
  return {
    sendMessage: async () => ({
      message: {
        role: "assistant" as const,
        content: "Alaya does not execute chat turns; use MCP memory tools.",
        message_id: randomUUID()
      },
      finish_reason: "stop" as const
    }),
    streamMessage: async function* () {}
  };
}

export function createEngineBindingTester() {
  return {
    testBinding: async (binding: EngineBinding): Promise<EngineBindingSummary & { readonly available_models: readonly string[] }> => ({
      provider_type: binding.provider,
      base_url: binding.base_url ?? null,
      model: binding.model,
      available_models: []
    })
  };
}

export function createUnavailableRuntimeAdapter(): AgentRuntimePort {
  return {
    kind: "unavailable",
    getCapabilities: () => ({
      supports_resume: false,
      supports_interrupt: false,
      supports_streaming_updates: false,
      supports_tool_events: false,
      supports_permission_requests: false,
      supports_artifact_events: false,
      supports_terminal_events: false
    }),
    createSession: async () => {
      throw new Error("Principal runtime adapter is not configured.");
    },
    prompt: async () => {
      throw new Error("Principal runtime adapter is not configured.");
    },
    cancel: async (sessionId: string) => ({
      session_id: sessionId,
      status: "not_found",
      message: "Principal runtime adapter is not configured."
    }),
    onEvent: () => () => undefined
  };
}

export function createKarmaEventStore(
  karmaEventRepo: SqliteKarmaEventRepo,
  warnLogger: ReturnType<typeof createWarnLogger>
) {
  return new SqliteKarmaEventStore(karmaEventRepo, warnLogger);
}

export function patchArbitrationClaimService(arbitrationService: ArbitrationService, claimService: ClaimService): void {
  const dependencies = (arbitrationService as unknown as { dependencies?: { claimService?: ClaimService } }).dependencies;
  if (dependencies !== undefined) {
    dependencies.claimService = claimService;
  }
}

function formatSecretResolutionError(label: string, error: ResolveSecretError): string {
  switch (error.kind) {
    case "malformed":
      return `${label}: ${error.ref} -> ${error.reason}`;
    case "env_missing":
      return `${label}: ${error.ref} -> environment variable ${error.var_name} is not set`;
    case "file_missing":
      return `${label}: ${error.ref} -> file not found at ${error.path}`;
    case "file_unreadable":
      return `${label}: ${error.ref} -> file unreadable at ${error.path} (${error.cause})`;
    case "empty":
      return `${label}: ${error.ref} -> ${error.origin} secret is empty`;
  }
}

function supportsPreparedSqliteConnection(database: StorageDatabase): boolean {
  return typeof database.connection.prepare === "function";
}

async function adoptGlobalMemoryEntry(
  globalMemoryRepo: GlobalMemoryRepo,
  projectMappingService: ProjectMappingService,
  globalObjectId: string,
  input: { readonly workspace_id: string; readonly accepted_by?: AcceptedBy }
) {
  const entry = (await globalMemoryRepo.findByGlobalObjectId(globalObjectId)) as Readonly<GlobalMemoryEntry> | null;

  if (entry === null) {
    throw new CoreError("NOT_FOUND", `Global memory ${globalObjectId} was not found.`);
  }

  const acceptedBy = input.accepted_by ?? AcceptedBy.USER;
  const anchor = await projectMappingService.ensureAdoptableAnchor(
    entry.global_object_id,
    input.workspace_id,
    acceptedBy
  );

  if (anchor.mapping_state === ProjectMappingState.ACCEPTED) {
    return anchor;
  }

  return await projectMappingService.accept(anchor.object_id, acceptedBy);
}

function summarizeToolResult(result: unknown): string {
  if (typeof result === "object" && result !== null && "ok" in result) {
    return (result as { readonly ok?: boolean }).ok === false ? "error" : "ok";
  }

  return "ok";
}
