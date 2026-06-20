import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  AcceptedBy,
  DEFAULT_SOUL_CONFIG,
  ProjectMappingState,
  type AgentRuntimePort,
  type EngineBinding,
  type EngineBindingSummary,
  type GlobalMemoryEntry,
  type GardenBacklogThresholds
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
  SqliteToolExecutionRecordRepo,
  type GlobalMemoryRecallCacheRepo,
  type GlobalMemoryRepo,
  type MemoryEmbeddingRepo,
  type StorageDatabase
} from "@do-soul/alaya-storage";
import { createWarnLogger } from "./daemon-runtime-helpers.js";
import { createConversationToolExecutor } from "./conversation-tool-executor.js";
import type { RequestProtectionConfig } from "./app.js";
import type { AlayaConfigPaths } from "../cli/config-files.js";
import type { DaemonStartupStepRecord } from "./daemon-runtime-types.js";
import { parseEnv } from "../services/env-file-service.js";
import { resolveConfiguredDatabasePath } from "./storage-config.js";
import { isNodeErrorWithCode } from "../services/private-file-service.js";
import { resolveSecretRef, type ResolveSecretError } from "../secrets/index.js";
import type { AlayaRuntimeNotifier } from "./runtime-notifier.js";
export {
  classifySoulGraphOriginKind,
  createSoulGraphService,
  deriveDomainTagSummary
} from "./soul-graph-runtime-support.js";

export const DEFAULT_OPENAI_EMBEDDING_MODEL = "text-embedding-3-small";
export const ALAYA_OFFICIAL_GARDEN_SECRET_REF_ENV = "ALAYA_OFFICIAL_GARDEN_SECRET_REF";
const GARDEN_BACKLOG_REARM_RATIO = 0.7;
const GARDEN_BACKLOG_SNAPSHOT_INTERVAL_MS = 60_000;

type GlobalMemoryListFilters = Parameters<GlobalMemoryRepo["list"]>[0];

type RequestProtectionEnvLike = Readonly<{
  ALAYA_REQUEST_TOKEN?: string;
  ALLOWED_ORIGIN?: string;
}>;

export function createRequestProtection(env: RequestProtectionEnvLike = process.env): RequestProtectionConfig {
  const configuredRequestToken = env.ALAYA_REQUEST_TOKEN?.trim();
  const allowedOrigin = env.ALLOWED_ORIGIN?.trim();

  return Object.freeze({
    allowedOrigin:
      allowedOrigin !== undefined && allowedOrigin.length > 0
        ? allowedOrigin
        : "http://localhost:5173",
    requestToken:
      configuredRequestToken !== undefined && configuredRequestToken.length > 0
        ? configuredRequestToken
        : randomBytes(32).toString("hex"),
    allowDesktopOriginlessRequests: true,
    tokenSource:
      configuredRequestToken !== undefined && configuredRequestToken.length > 0
        ? "env"
        : "ephemeral"
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

export const ALAYA_EDGE_PRODUCER_LLM_ENABLED_ENV = "ALAYA_EDGE_PRODUCER_LLM_ENABLED";
export const ALAYA_EDGE_CLASSIFY_HOST_WORKER_ENV = "ALAYA_EDGE_CLASSIFY_HOST_WORKER";

// invariant: the B-2 edge-classify routing mode. Mutually exclusive by
// construction: host-worker defer wins over the synchronous cloud LLM, which
// wins over the local heuristic-only floor.
//   - "host_worker_defer": the EDGE_CLASSIFY garden task is enqueued for an
//     attached CLI agent (the compute). No cloud call. This is the product
//     default whenever the resolved garden compute provider_kind is
//     host_worker, or when ALAYA_EDGE_CLASSIFY_HOST_WORKER forces it on.
//   - "cloud_llm": the operator strict-opted-in via ALAYA_EDGE_PRODUCER_LLM_ENABLED
//     AND host-worker defer is NOT active. The synchronous in-process cloud
//     port is then attempted (it still needs a resolvable key + provider_url,
//     resolved separately; this mode reports the INTENT to call cloud).
//   - "heuristic_only": neither defer nor opt-in — the deterministic heuristic
//     is the only classifier; zero external call.
export type EdgeClassifyWiringMode = "host_worker_defer" | "cloud_llm" | "heuristic_only";

export interface EdgeClassifyWiring {
  readonly mode: EdgeClassifyWiringMode;
  // strict opt-in for the synchronous cloud edge-LLM (1/true only).
  readonly llmEnabled: boolean;
  // host-worker defer is on (explicit override OR provider_kind=host_worker default).
  readonly hostWorkerEnabled: boolean;
}

function readBooleanOptIn(raw: string | undefined): boolean {
  const value = raw?.toLowerCase();
  return value === "1" || value === "true";
}

// invariant: the single decision that chooses cloud llmPort vs the
// host-worker EDGE_CLASSIFY defer queue vs heuristic-only for B-2 edge
// classification. PURE: depends only on the passed env reader and the resolved
// garden compute provider_kind, so the zero-cloud-by-default guarantee is unit
// testable without standing up the daemon. index.ts consumes this; behavior
// must not diverge between the two. A regression that flips the default back
// to cloud changes this function's output and is caught by its tests.
// see also: apps/core-daemon/src/index.ts edgeAutoProducerLlmPort /
//   edgeClassifyHostWorkerEnabled wiring.
export function resolveEdgeClassifyWiring(
  env: Readonly<Record<string, string | undefined>>,
  gardenComputeConfig: { readonly provider_kind: string }
): EdgeClassifyWiring {
  const llmEnabled = readBooleanOptIn(env[ALAYA_EDGE_PRODUCER_LLM_ENABLED_ENV]);
  const hostWorkerRaw = env[ALAYA_EDGE_CLASSIFY_HOST_WORKER_ENV]?.toLowerCase();
  const hostWorkerEnabled =
    hostWorkerRaw === "1" || hostWorkerRaw === "true"
      ? true
      : hostWorkerRaw === "0" || hostWorkerRaw === "false"
        ? false
        : gardenComputeConfig.provider_kind === "host_worker";
  const mode: EdgeClassifyWiringMode = hostWorkerEnabled
    ? "host_worker_defer"
    : llmEnabled
      ? "cloud_llm"
      : "heuristic_only";
  return { mode, llmEnabled, hostWorkerEnabled };
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
      list: async () => await params.globalMemoryRepo.list(),
      ...(params.globalMemoryRepo.listAll === undefined
        ? {}
        : { listAll: async () => await params.globalMemoryRepo.listAll!() }),
      ...(params.globalMemoryRepo.listPage === undefined
        ? {}
        : {
            listPage: async (page: { readonly limit: number; readonly offset: number }) =>
              await params.globalMemoryRepo.listPage!(undefined, page)
          })
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
    case "keychain_tooling_unavailable":
    case "keychain_entry_not_found":
      return `${label}: ${error.ref} -> ${error.reason}`;
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
