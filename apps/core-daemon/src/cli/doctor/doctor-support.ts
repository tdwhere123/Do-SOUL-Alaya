import { access, constants as fsConstants, stat } from "node:fs/promises";
import { parseEnvBoolean, type EmbeddingStatus } from "@do-soul/alaya-protocol";
import type {
  EmbeddingQueryWarmupSummary,
  WorkspaceBootstrapReconcileResult
} from "@do-soul/alaya-core";
import { attachedAgentEnvHoldsConfirmationToken } from "../../attach/attached-agent-mcp-child-env.js";
import { ATTACHED_MCP_CONFIRMATION_TOKEN_LEAK_PREVIEW } from "../../attach/profile-mutation/profile-mutation.js";
import type { PathPlasticityLookupTelemetrySnapshot } from "../../garden/path-plasticity/path-plasticity-runtime.js";
import type { BuildInfo } from "../../runtime/daemon/support/build-info.js";
import { createEmptyGraphHealthSnapshot } from "../../services/status/graph-health-service.js";
import type { AlayaCliArgsSchema } from "../bridge.js";
import { doctorAuditCheckStatus, type DoctorAuditSnapshot } from "./doctor-audit.js";
import type {
  DoctorArgs,
  DoctorBootstrapReconcileSummary,
  DoctorCommandDependencies,
  DoctorReport,
  GardenComputeStatus,
  RuntimeWiringStatus
} from "./doctor.js";

export function doctorArgsSchema(): AlayaCliArgsSchema<DoctorArgs> {
  return {
    safeParse(input) {
      return parseDoctorArgsInput(input);
    }
  };
}

function parseDoctorArgsInput(input: unknown) {
  const usage = "Usage: doctor [--workspace <workspace-id>] [--reconcile-bootstrap]";
  if (!Array.isArray(input) || input.some((token) => typeof token !== "string")) {
    return {
      success: false,
      error: { issues: [{ path: [], message: "Expected a string argument list." }] }
    } as const;
  }

  let workspaceId: string | null = null;
  let reconcileBootstrap = false;
  let cursor = 0;
  while (cursor < input.length) {
    const token = input[cursor];
    if (token === "--workspace") {
      const parsedWorkspace = parseDoctorWorkspaceFlag(input, cursor, workspaceId !== null);
      if (!parsedWorkspace.ok) return parsedWorkspace.result;
      workspaceId = parsedWorkspace.workspaceId;
      cursor += 2;
      continue;
    }
    if (token === "--reconcile-bootstrap") {
      if (reconcileBootstrap) return duplicateDoctorFlag("--reconcile-bootstrap", cursor);
      reconcileBootstrap = true;
      cursor += 1;
      continue;
    }
    return { success: false, error: { issues: [{ path: [cursor], message: usage }] } } as const;
  }
  return { success: true, data: { workspaceId, reconcileBootstrap } } as const;
}

function parseDoctorWorkspaceFlag(
  input: readonly string[],
  cursor: number,
  duplicate: boolean
):
  | { readonly ok: true; readonly workspaceId: string }
  | {
      readonly ok: false;
      readonly result:
        | ReturnType<typeof duplicateDoctorFlag>
        | ReturnType<typeof doctorWorkspaceFlagError>;
    } {
  if (duplicate) return { ok: false, result: duplicateDoctorFlag("--workspace", cursor) };
  const next = input[cursor + 1];
  if (next === undefined) return { ok: false, result: doctorWorkspaceFlagError([cursor], "--workspace requires a workspace id.") };
  if (next.startsWith("--")) return {
    ok: false,
    result: doctorWorkspaceFlagError([cursor + 1], "--workspace requires a workspace id, not a flag.")
  };
  const candidate = next.trim();
  if (candidate.length === 0) return {
    ok: false,
    result: doctorWorkspaceFlagError([cursor + 1], "Workspace id must not be empty.")
  };
  return { ok: true, workspaceId: candidate };
}

function duplicateDoctorFlag(name: string, cursor: number) {
  return {
    success: false,
    error: { issues: [{ path: [cursor], message: `${name} may only be passed once.` }] }
  } as const;
}

function doctorWorkspaceFlagError(path: readonly number[], message: string) {
  return {
    success: false,
    error: { issues: [{ path, message }] }
  } as const;
}

export async function inspectStorage(
  dbPath: string,
  getSchemaSummary?: DoctorCommandDependencies["getSchemaSummary"]
): Promise<DoctorReport["storage"]> {
  const normalizedPath = dbPath.trim();
  if (normalizedPath.length === 0) {
    return createStorageSnapshot(dbPath, normalizedPath, false, false, false);
  }

  const accessState = await inspectStorageAccess(normalizedPath);
  if (!accessState.exists || !accessState.readable || !accessState.writable) {
    return createStorageSnapshot(
      dbPath,
      normalizedPath,
      accessState.exists,
      accessState.readable,
      accessState.writable,
      accessState.error_code
    );
  }
  if (getSchemaSummary === undefined) {
    return createStorageSnapshot(dbPath, normalizedPath, true, true, true);
  }
  return await inspectStorageSchema(normalizedPath, getSchemaSummary);
}

// Coarse storage-growth advisory: warn once the SQLite DB crosses this size so
// an operator notices unbounded growth before it degrades tail latency. Not a
// hard limit — a diagnostic signal only.
const STORAGE_GROWTH_LARGE_BYTES = 1_073_741_824;

export async function inspectStorageGrowth(
  dbPath: string
): Promise<DoctorReport["storage_growth"]> {
  const normalizedPath = dbPath.trim();
  if (normalizedPath.length === 0) {
    return { db_size_bytes: null, advisory: "unknown" };
  }
  try {
    const stats = await stat(normalizedPath);
    return {
      db_size_bytes: stats.size,
      advisory: stats.size >= STORAGE_GROWTH_LARGE_BYTES ? "large" : "ok"
    };
  } catch {
    return { db_size_bytes: null, advisory: "unknown" };
  }
}

function createStorageSnapshot(
  originalPath: string,
  normalizedPath: string,
  existsValue: boolean,
  readableValue: boolean,
  writableValue: boolean,
  errorCode: string | null = null
): DoctorReport["storage"] {
  return {
    db_path: normalizedPath.length === 0 ? originalPath : normalizedPath,
    exists: existsValue,
    readable: readableValue,
    writable: writableValue,
    schema_ok: null,
    schema_version_persisted: null,
    schema_version_expected: null,
    error_code: errorCode
  };
}

async function inspectStorageAccess(
  normalizedPath: string
): Promise<Readonly<{ exists: boolean; readable: boolean; writable: boolean; error_code: string | null }>> {
  try {
    await access(normalizedPath, fsConstants.F_OK);
  } catch (error) {
    const code = readErrnoCode(error);
    if (code === "ENOENT") {
      return { exists: false, readable: false, writable: false, error_code: code };
    }
    return {
      exists: code === "EACCES" || code === "EPERM",
      readable: false,
      writable: false,
      error_code: code
    };
  }
  let readable = true;
  let errorCode: string | null = null;
  try {
    await access(normalizedPath, fsConstants.R_OK);
  } catch (error) {
    readable = false;
    errorCode = readErrnoCode(error);
  }
  try {
    await access(normalizedPath, fsConstants.W_OK);
    return { exists: true, readable, writable: true, error_code: errorCode };
  } catch (error) {
    return {
      exists: true,
      readable,
      writable: false,
      error_code: errorCode ?? readErrnoCode(error)
    };
  }
}

async function inspectStorageSchema(
  normalizedPath: string,
  getSchemaSummary: NonNullable<DoctorCommandDependencies["getSchemaSummary"]>
): Promise<DoctorReport["storage"]> {
  try {
    const summary = await getSchemaSummary(normalizedPath);
    return {
      db_path: normalizedPath,
      exists: true,
      readable: true,
      writable: true,
      schema_ok: summary.schemaOk,
      schema_version_persisted: summary.persistedMaxVersion,
      schema_version_expected: summary.knownMaxVersion,
      error_code: null
    };
  } catch (error) {
    const code = readErrnoCode(error);
    const unreadable = code === "EACCES" || code === "EPERM";
    return {
      db_path: normalizedPath,
      exists: true,
      readable: !unreadable,
      writable: !unreadable,
      schema_ok: unreadable ? null : false,
      schema_version_persisted: null,
      schema_version_expected: null,
      error_code: code
    };
  }
}

function readErrnoCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return null;
  }
  const code = (error as { readonly code?: unknown }).code;
  return typeof code === "string" && code.length > 0 ? code : null;
}

export async function runBootstrapReconcile(
  handler:
    | ((workspaceId: string) => Promise<WorkspaceBootstrapReconcileResult>)
    | undefined,
  workspaceId: string
): Promise<DoctorBootstrapReconcileSummary> {
  if (handler === undefined) {
    return { status: "skipped_no_handler" };
  }
  try {
    const result = await handler(workspaceId);
    switch (result.status) {
      case "planted":
        return { status: "planted", paths_planted: result.paths_planted, record_id: result.record_id, template_ids: result.template_ids };
      case "already_planted":
        return { status: "already_planted", record_id: result.record_id, relation_count: result.relation_count };
      case "corrupt_partial":
        return { status: "corrupt_partial", record_id: result.record_id, relation_count: result.relation_count, reason: result.reason };
      case "skipped_no_templates":
        return { status: "skipped_no_templates", template_ids: result.template_ids };
      case "skipped_no_planner":
        return { status: "skipped_no_planner" };
    }
  } catch (error) {
    return {
      status: "failed",
      reason: error instanceof Error ? error.message : String(error)
    };
  }
}

export async function readDoctorServices(
  deps: DoctorCommandDependencies,
  workspaceId: string,
  effectiveEnv: NodeJS.ProcessEnv
) {
  const toolchainStatus = await deps.getToolchainStatus();
  const [
    storage,
    storageGrowth,
    embeddingStatus,
    queryEmbeddingWarmup,
    mcp,
    garden,
    gardenCredentialProvenance,
    gardenCompute,
    pathPlasticityLookupTelemetry,
    graphHealth
  ] = await Promise.all([
    inspectStorage(toolchainStatus.db_path, deps.getSchemaSummary),
    inspectStorageGrowth(toolchainStatus.db_path),
    deps.getEmbeddingStatus ? await deps.getEmbeddingStatus(workspaceId) : null,
    deps.getQueryEmbeddingWarmup ? await deps.getQueryEmbeddingWarmup() : null,
    await deps.getMcpHealth(),
    await deps.getGardenHealth(),
    deps.getGardenCredentialProvenance ? await deps.getGardenCredentialProvenance() : ({ kind: "none" } as const),
    deps.getGardenCompute ? await deps.getGardenCompute(workspaceId) : defaultDoctorGardenCompute(),
    (await deps.getPathPlasticityLookupTelemetry?.()) ?? defaultPathPlasticityLookupTelemetry(),
    (await deps.getGraphHealth?.(workspaceId)) ?? createEmptyGraphHealthSnapshot(workspaceId)
  ]);
  const runtimeWiring = withRuntimeWiringDefaults(
    deps.getRuntimeWiring
      ? await deps.getRuntimeWiring()
      : resolveRuntimeWiringFromEnv(effectiveEnv)
  );
  return {
    storage,
    storageGrowth,
    runtimeWiring,
    embeddingStatus,
    queryEmbeddingWarmup,
    mcp,
    garden,
    gardenCredentialProvenance,
    gardenCompute,
    pathPlasticityLookupTelemetry,
    graphHealth
  };
}

interface AssembleDoctorReportInput {
  readonly checkedAt: string;
  readonly buildInfo: BuildInfo;
  readonly startup: DoctorReport["startup"];
  readonly workspaceId: string;
  readonly services: Awaited<ReturnType<typeof readDoctorServices>>;
  readonly bootstrapReconcileSummary: DoctorBootstrapReconcileSummary | null;
  readonly attachedProfiles: DoctorReport["attached_profiles"];
  readonly audit: DoctorAuditSnapshot;
  readonly env: NodeJS.ProcessEnv;
}

export function assembleDoctorReport(input: AssembleDoctorReportInput): DoctorReport {
  const checks = buildDoctorChecks(
    input.startup.ready, input.services, input.bootstrapReconcileSummary,
    input.attachedProfiles, input.audit, input.env
  );
  return {
    checked_at: input.checkedAt,
    overall: Object.values(checks).every((status) => status === "pass") ? "green" : "degraded",
    build_info: input.buildInfo,
    startup: input.startup,
    storage: input.services.storage,
    provider: {
      workspace_id: input.workspaceId,
      embedding: input.services.embeddingStatus,
      configured: input.services.embeddingStatus?.provider_configured ?? true,
      query_embedding_warmup: input.services.queryEmbeddingWarmup
    },
    mcp: input.services.mcp,
    garden: {
      ...input.services.garden,
      health_basis: "scheduler_activity",
      schema_ok: input.services.gardenCompute.schema_ok !== false,
      credential_provenance: input.services.gardenCredentialProvenance
    },
    garden_compute: input.services.gardenCompute,
    recall: { path_plasticity_lookup: input.services.pathPlasticityLookupTelemetry },
    graph_health: input.services.graphHealth,
    runtime_wiring: input.services.runtimeWiring,
    storage_growth: input.services.storageGrowth,
    attached_profiles: input.attachedProfiles,
    audit: input.audit,
    confirmation_token_isolation: attachedAgentEnvHoldsConfirmationToken(input.env)
      ? "executor_holds_token"
      : "ok",
    ...(input.bootstrapReconcileSummary === null
      ? {}
      : { bootstrap_reconcile: input.bootstrapReconcileSummary }),
    checks
  };
}

function resolveRuntimeWiringFromEnv(env: NodeJS.ProcessEnv): RuntimeWiringStatus {
  const requestToken = env.ALAYA_REQUEST_TOKEN?.trim();
  const daemonSocket = env.ALAYA_DAEMON_SOCKET?.trim();
  const tokenWorkspaces = env.ALAYA_REQUEST_TOKEN_WORKSPACES?.trim();
  return {
    request_token_source:
      requestToken !== undefined && requestToken.length > 0 ? "env" : "ephemeral",
    daemon_socket: daemonSocket !== undefined && daemonSocket.length > 0 ? daemonSocket : null,
    wildcard_bind_opt_in: parseEnvBoolean(env.ALAYA_ALLOW_WILDCARD_BIND, "ALAYA_ALLOW_WILDCARD_BIND"),
    request_token_workspaces:
      tokenWorkspaces !== undefined && tokenWorkspaces.length > 0 ? tokenWorkspaces : null
  };
}

function withRuntimeWiringDefaults(
  wiring: RuntimeWiringStatus
): RuntimeWiringStatus {
  return {
    request_token_source: wiring.request_token_source,
    daemon_socket: wiring.daemon_socket ?? null,
    wildcard_bind_opt_in: wiring.wildcard_bind_opt_in === true,
    request_token_workspaces: wiring.request_token_workspaces ?? null
  };
}

function defaultDoctorGardenCompute(): GardenComputeStatus {
  return {
    provider_kind: "local_heuristics",
    model_id: null,
    provider_url: null,
    credential_source: { kind: "none" },
    routing_decision: "local_heuristics"
  };
}

function defaultPathPlasticityLookupTelemetry(): Readonly<PathPlasticityLookupTelemetrySnapshot> {
  return {
    lookup_count: 0,
    sample_count: 0,
    duration_p99_ms: null,
    window_size: 128
  };
}

function buildDoctorChecks(
  daemonReady: boolean,
  services: Awaited<ReturnType<typeof readDoctorServices>>,
  bootstrapReconcileSummary: DoctorBootstrapReconcileSummary | null,
  attachedProfiles: DoctorReport["attached_profiles"],
  audit: DoctorAuditSnapshot,
  env: NodeJS.ProcessEnv
): DoctorReport["checks"] {
  return {
    runtime: daemonReady ? "pass" : "fail",
    storage:
      services.storage.exists &&
      services.storage.readable &&
      services.storage.writable &&
      services.storage.schema_ok !== false
        ? "pass"
        : "fail",
    provider: resolveProviderCheck(services.embeddingStatus, services.queryEmbeddingWarmup),
    mcp: services.mcp.transport === "ready" ? "pass" : "fail",
    garden:
      services.garden.status === "healthy" &&
      services.gardenCompute.keychain_check?.ok !== false &&
      services.gardenCompute.schema_ok !== false &&
      (services.gardenCompute.capture?.statement_sessions.failed ?? 0) === 0 &&
      (services.gardenCompute.capture?.host_session.overdue_unbound_messages ?? 0) === 0
        ? "pass"
        : "fail",
    bootstrap_reconcile: resolveBootstrapReconcileCheck(bootstrapReconcileSummary),
    config:
      doctorAuditCheckStatus(audit) === "pass" &&
      attachedProfiles.every((profile) => profile.status !== "error") &&
      attachedProfiles.every(
        (profile) => profile.attached_preview !== ATTACHED_MCP_CONFIRMATION_TOKEN_LEAK_PREVIEW
      ) &&
      !attachedAgentEnvHoldsConfirmationToken(env)
        ? "pass"
        : "fail"
  };
}

function resolveProviderCheck(
  embeddingStatus: EmbeddingStatus | null,
  queryEmbeddingWarmup: EmbeddingQueryWarmupSummary | null
): "pass" | "fail" {
  if (queryEmbeddingWarmup?.status === "failed" || queryEmbeddingWarmup?.status === "partial") {
    return "fail";
  }
  if (embeddingStatus === null || embeddingStatus.effective_mode !== "degraded") {
    return "pass";
  }
  return "fail";
}

function resolveBootstrapReconcileCheck(
  bootstrapReconcileSummary: DoctorBootstrapReconcileSummary | null
): "pass" | "fail" {
  return bootstrapReconcileSummary === null ||
    bootstrapReconcileSummary.status === "planted" ||
    bootstrapReconcileSummary.status === "already_planted" ||
    bootstrapReconcileSummary.status === "skipped_no_templates"
    ? "pass"
    : "fail";
}
