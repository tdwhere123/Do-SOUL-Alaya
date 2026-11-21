import type { EmbeddingStatus, ToolchainStatus } from "@do-soul/alaya-protocol";
import { mergeDaemonEnvLookup } from "../../runtime/config/daemon-config-environment.js";
import { loadConfigEnv } from "../../runtime/daemon/lifecycle/daemon-runtime-support.js";
import { resolveAlayaConfigDir, resolveAlayaConfigPaths } from "../support/config-files.js";
import { assessStartupReadiness } from "../../runtime/daemon/support/startup-readiness.js";
import { GARDEN_SCHEDULER_INTERVAL_MS } from "../../garden/runtime/runtime-background-services.js";
export { GARDEN_SCHEDULER_INTERVAL_MS } from "../../garden/runtime/runtime-background-services.js";
import type {
  EmbeddingQueryWarmupSummary,
  WorkspaceBootstrapReconcileResult
} from "@do-soul/alaya-core";
import type { DaemonStartupStepRecord } from "../../runtime/daemon/lifecycle/daemon-runtime-types.js";
import type { GardenCaptureHealth } from "../../garden/host-session/capture-health.js";
import type { PathPlasticityLookupTelemetrySnapshot } from "../../garden/path-plasticity/path-plasticity-runtime.js";
import type { GardenCredentialProvenance } from "../../services/config/config-service.js";
import type { ResolveSecretError } from "../../secrets/index.js";
import {
  detectAttachedProfileInstructionsDrift,
  type ProfileInstructionsDriftReport,
  type ProfileTarget
} from "../../attach/index.js";
import { ALAYA_SYSEXITS, type AlayaCliContext, type AlayaCliResult, type AlayaSubcommandSpec } from "../bridge.js";
import { resolveCliWorkspaceContext } from "../support/workspace-context.js";
import type { GraphHealthSnapshot } from "../../services/status/graph-health-service.js";
import type { BuildInfo } from "../../runtime/daemon/support/build-info.js";
import { readDoctorAuditSnapshot, type DoctorAuditSnapshot } from "./doctor-audit.js";
import {
  assembleDoctorReport,
  doctorArgsSchema,
  readDoctorServices,
  runBootstrapReconcile
} from "./doctor-support.js";
import { writeHumanSummary } from "./doctor-summary.js";

const UNKNOWN_BUILD_INFO: BuildInfo = {
  version: "0.0.0-dev",
  git_head: "unknown",
  built_at: "unknown"
};

/**
 * Shape returned by the optional getGardenCompute doctor dep so an
 * operator can see what Garden compute the daemon actually wired up,
 * independent of embedding. credential_source distinguishes
 * - env:NAME ⇒ Garden has its own ALAYA_OFFICIAL_GARDEN_SECRET_REF
 * - file:/.../mask ⇒ Garden has its own file-based secret
 * - embedding-fallback ⇒ Garden borrowed embedding's key (deprecated)
 * - none ⇒ no key, Garden routes to local_heuristics
 */
export interface GardenComputeStatus {
  readonly provider_kind: "official_api" | "local_heuristics" | "host_worker";
  readonly model_id: string | null;
  readonly provider_url: string | null;
  readonly credential_source:
    | { readonly kind: "env"; readonly name: string }
    | { readonly kind: "file"; readonly masked_path: string }
    | { readonly kind: "keychain"; readonly service: string; readonly account: string }
    | { readonly kind: "embedding-fallback" }
    | { readonly kind: "none" };
  readonly routing_decision: "official_api" | "local_heuristics" | "host_worker";
  readonly schema_ok?: boolean;
  readonly degraded_reason?: string | null;
  readonly keychain_check?: GardenKeychainCheck;
  readonly host_worker_advisory?: Readonly<{
    readonly pending_extract_tasks: number;
    readonly stale_claimed_extract_tasks: number;
    readonly pending_edge_classify_tasks: number;
    readonly stale_claimed_edge_classify_tasks: number;
    readonly attach_worker_recommended: boolean;
  }>;
  readonly capture?: GardenCaptureHealth;
}

export type GardenKeychainCheck =
  | Readonly<{ readonly ok: true; readonly service: string; readonly account: string }>
  | Readonly<{
      readonly ok: false;
      readonly service: string;
      readonly account: string;
      readonly error_kind: Extract<ResolveSecretError["kind"], "keychain_tooling_unavailable" | "keychain_entry_not_found" | "empty" | "malformed">;
      readonly remediation: string;
    }>;

export interface RuntimeWiringStatus {
  readonly request_token_source: "env" | "ephemeral" | "rotated";
  readonly daemon_socket: string | null;
  readonly wildcard_bind_opt_in: boolean;
  readonly request_token_workspaces: string | null;
}

export interface DoctorCommandDependencies {
  readonly getToolchainStatus: () => Promise<ToolchainStatus>;
  readonly getRuntimeWiring?: () => RuntimeWiringStatus | Promise<RuntimeWiringStatus>;
  readonly getEmbeddingStatus?: (workspaceId: string) => Promise<EmbeddingStatus>;
  readonly getQueryEmbeddingWarmup?: () =>
    | EmbeddingQueryWarmupSummary
    | null
    | Promise<EmbeddingQueryWarmupSummary | null>;
  readonly getMcpHealth: () => Promise<Readonly<{ transport: "ready" | "not_ready"; enrolled_tools: number }>>;
  readonly getGardenHealth: () => Promise<Readonly<{ status: "healthy" | "degraded"; last_pass_at: string | null }>>;
  readonly getGardenCredentialProvenance?: () => Promise<GardenCredentialProvenance>;
  readonly reconcileBootstrapPaths?: (
    workspaceId: string
  ) => Promise<WorkspaceBootstrapReconcileResult>;
  readonly getGardenCompute?: (workspaceId: string) => Promise<GardenComputeStatus> | GardenComputeStatus;
  readonly getPathPlasticityLookupTelemetry?: () =>
    | Readonly<PathPlasticityLookupTelemetrySnapshot>
    | Promise<Readonly<PathPlasticityLookupTelemetrySnapshot>>;
  readonly getGraphHealth?: (workspaceId: string) =>
    | Readonly<GraphHealthSnapshot>
    | Promise<Readonly<GraphHealthSnapshot>>;
  readonly getSchemaSummary?: (
    dbPath: string
  ) => Promise<Readonly<{ persistedMaxVersion: number | null; knownMaxVersion: number; schemaOk: boolean }>>;
  readonly startupStepsProvider?: (
    context: Pick<AlayaCliContext, "daemon">
  ) => readonly DaemonStartupStepRecord[];
  readonly defaultWorkspaceId?: string;
  readonly clock?: () => string;
  readonly getBuildInfo?: () => BuildInfo;
}

export interface DoctorArgs {
  readonly workspaceId: string | null;
  readonly reconcileBootstrap: boolean;
}

export type DoctorBootstrapReconcileSummary = Readonly<
  | {
      readonly status: "planted";
      readonly paths_planted: number;
      readonly record_id: string;
      readonly template_ids: readonly string[];
    }
  | {
      readonly status: "already_planted";
      readonly record_id: string | null;
      readonly relation_count: number;
    }
  | {
      readonly status: "corrupt_partial";
      readonly record_id: string;
      readonly relation_count: 0;
      readonly reason: "bootstrapping_record_without_relations";
    }
  | {
      readonly status: "skipped_no_templates";
      readonly template_ids: readonly string[];
    }
  | { readonly status: "skipped_no_planner" }
  | { readonly status: "skipped_no_handler" }
  | { readonly status: "failed"; readonly reason: string }
>;

type DoctorCheckStatus = "pass" | "fail";
type DoctorCheckName =
  | "runtime"
  | "storage"
  | "provider"
  | "mcp"
  | "garden"
  | "bootstrap_reconcile"
  | "config";

export interface DoctorReport {
  readonly checked_at: string;
  readonly overall: "green" | "degraded";
  readonly build_info: BuildInfo;
  readonly startup: Readonly<{
    ready: boolean;
    completed_steps: readonly string[];
    missing_steps: readonly string[];
  }>;
  readonly storage: Readonly<{
    db_path: string;
    exists: boolean;
    readable: boolean;
    writable: boolean;
    schema_ok: boolean | null;
    schema_version_persisted: number | null;
    schema_version_expected: number | null;
    error_code: string | null;
  }>;
  readonly provider: Readonly<{
    workspace_id: string;
    embedding: EmbeddingStatus | null;
    configured: boolean;
    query_embedding_warmup: EmbeddingQueryWarmupSummary | null;
  }>;
  readonly mcp: Readonly<{
    transport: "ready" | "not_ready";
    enrolled_tools: number;
  }>;
  readonly garden: Readonly<{
    status: "healthy" | "degraded";
    health_basis: "scheduler_activity";
    last_pass_at: string | null;
    schema_ok: boolean;
    credential_provenance: GardenCredentialProvenance;
  }>;
  readonly garden_compute: GardenComputeStatus;
  readonly recall: Readonly<{
    readonly path_plasticity_lookup: Readonly<PathPlasticityLookupTelemetrySnapshot>;
  }>;
  readonly graph_health: Readonly<GraphHealthSnapshot>;
  readonly runtime_wiring: RuntimeWiringStatus;
  readonly storage_growth: Readonly<{
    readonly db_size_bytes: number | null;
    readonly advisory: "ok" | "large" | "unknown";
  }>;
  readonly attached_profiles: ReadonlyArray<ProfileInstructionsDriftReport>;
  readonly audit: DoctorAuditSnapshot;
  readonly confirmation_token_isolation: "ok" | "executor_holds_token";
  readonly bootstrap_reconcile?: DoctorBootstrapReconcileSummary;
  readonly checks: Readonly<Record<DoctorCheckName, DoctorCheckStatus>>;
}

export function createDoctorCommand(
  deps: DoctorCommandDependencies
): AlayaSubcommandSpec<DoctorArgs> {
  const now = deps.clock ?? (() => new Date().toISOString());

  return {
    name: "doctor",
    description: "Report runtime, storage, MCP, Garden, and provider health.",
    argsSchema: doctorArgsSchema(),
    requiresDaemonReady: false,
    handler: async (ctx, args) => await handleDoctorCommand(ctx, args, deps, now)
  };
}

async function handleDoctorCommand(
  ctx: AlayaCliContext,
  args: DoctorArgs,
  deps: DoctorCommandDependencies,
  now: () => string
): Promise<AlayaCliResult> {
  const effectiveEnv = await resolveDoctorEffectiveEnv(ctx.env);
  const report = await buildDoctorReport(ctx, args, deps, now, effectiveEnv);
  if (ctx.jsonRequested !== true) {
    writeHumanSummary(ctx.stdout, report, effectiveEnv);
  }
  return {
    exitCode: report.overall === "green" ? ALAYA_SYSEXITS.OK : ALAYA_SYSEXITS.TEMPFAIL,
    json: report
  };
}

async function resolveDoctorEffectiveEnv(env: NodeJS.ProcessEnv): Promise<NodeJS.ProcessEnv> {
  const configPaths = resolveAlayaConfigPaths(resolveAlayaConfigDir({ env }));
  const configEnv = await loadConfigEnv(configPaths.envPath);
  return mergeDaemonEnvLookup(env, configEnv) as NodeJS.ProcessEnv;
}

async function buildDoctorReport(
  ctx: AlayaCliContext,
  args: DoctorArgs,
  deps: DoctorCommandDependencies,
  now: () => string,
  effectiveEnv: NodeJS.ProcessEnv
): Promise<DoctorReport> {
  const startup = readDoctorStartup(deps, ctx);
  const workspaceId = resolveCliWorkspaceContext(
    ctx,
    args.workspaceId,
    deps.defaultWorkspaceId
  ).workspaceId;
  const services = await readDoctorServices(deps, workspaceId, effectiveEnv);
  const bootstrapReconcileSummary = args.reconcileBootstrap
    ? await runBootstrapReconcile(deps.reconcileBootstrapPaths, workspaceId)
    : null;
  const attachedProfiles = await readAttachedProfileDrift(ctx.env);
  const audit = readDoctorAuditSnapshot(services.storage.db_path, effectiveEnv);
  return assembleDoctorReport({
    checkedAt: now(),
    buildInfo: deps.getBuildInfo?.() ?? UNKNOWN_BUILD_INFO,
    startup,
    workspaceId,
    services,
    bootstrapReconcileSummary,
    attachedProfiles,
    audit,
    env: ctx.env
  });
}

function readDoctorStartup(
  deps: DoctorCommandDependencies,
  ctx: AlayaCliContext
): DoctorReport["startup"] {
  const startupSteps = deps.startupStepsProvider?.(ctx) ?? ctx.daemon.startupSteps;
  return assessStartupReadiness(startupSteps);
}

const PROFILE_TARGETS: readonly ProfileTarget[] = ["codex", "claude-code"];

async function readAttachedProfileDrift(
  env: NodeJS.ProcessEnv
): Promise<readonly ProfileInstructionsDriftReport[]> {
  return await Promise.all(
    PROFILE_TARGETS.map(async (target) => {
      try {
        return await detectAttachedProfileInstructionsDrift(target, { env });
      } catch {
        return {
          target,
          profile_path: "",
          status: "error",
          attached_preview: null
        } as const satisfies ProfileInstructionsDriftReport;
      }
    })
  );
}

export const GARDEN_STALE_PASS_INTERVALS = 2;

export function assessMcpCatalogTransport(
  health: Readonly<{
    readonly servers: readonly {
      readonly status: "active" | "inactive";
      readonly last_error: unknown;
    }[];
  }>
): "ready" | "not_ready" {
  const failed = health.servers.some(
    (server) => server.status !== "active" || server.last_error !== null
  );
  return failed ? "not_ready" : "ready";
}

export function assessGardenPassHealth(
  lastPassAt: string | null,
  nowMs: number = Date.now()
): "healthy" | "degraded" {
  if (lastPassAt === null) {
    return "degraded";
  }
  const passedAt = Date.parse(lastPassAt);
  if (!Number.isFinite(passedAt)) {
    return "degraded";
  }
  if (nowMs - passedAt > GARDEN_STALE_PASS_INTERVALS * GARDEN_SCHEDULER_INTERVAL_MS) {
    return "degraded";
  }
  return "healthy";
}
