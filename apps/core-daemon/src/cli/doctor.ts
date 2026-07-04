import type { EmbeddingStatus, ToolchainStatus } from "@do-soul/alaya-protocol";
import type { WorkspaceBootstrapReconcileResult } from "@do-soul/alaya-core";
import type { DaemonStartupStepRecord } from "../index.js";
import type { PathPlasticityLookupTelemetrySnapshot } from "../garden/path-plasticity-runtime.js";
import type { GardenCredentialProvenance } from "../services/config-service.js";
import type { ResolveSecretError } from "../secrets/index.js";
import {
  detectAttachedProfileInstructionsDrift,
  type ProfileInstructionsDriftReport,
  type ProfileTarget
} from "../attach/index.js";
import { ALAYA_SYSEXITS, type AlayaCliContext, type AlayaCliResult, type AlayaSubcommandSpec } from "./bridge.js";
import { resolveCliWorkspaceContext } from "./workspace-context.js";
import {
  createEmptyGraphHealthSnapshot,
  type GraphHealthSnapshot
} from "../services/graph-health-service.js";
import type { BuildInfo } from "../runtime/build-info.js";
import { doctorArgsSchema, inspectStorage, inspectStorageGrowth, runBootstrapReconcile, writeHumanSummary } from "./doctor-support.js";

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
  // Present only when the active Garden secret_ref is keychain:<service>:<account>.
  readonly keychain_check?: GardenKeychainCheck;
  // Present only under the host_worker product default. Surfaces whether
  // recall-driven host-worker work is waiting for an attached CLI agent (LLM
  // quality) or being left to the zero-cloud heuristic fallback.
  // pending_extract_tasks counts unclaimed POST_TURN_EXTRACT tasks;
  // stale_claimed_extract_tasks counts tasks a worker claimed but abandoned past
  // the stale window (reclaimed back to pending on the next scheduler pass).
  // pending_edge_classify_tasks / stale_claimed_edge_classify_tasks carry the
  // same split for EDGE_CLASSIFY tasks (the LLM-quality edge verdict): unclaimed
  // means heuristic edges that have not been refined by any host worker.
  // attach_worker_recommended is true when there is unclaimed extract OR
  // edge-classify work — the operator should attach Codex / Claude Code for
  // LLM-quality processing, else Alaya runs on the deterministic heuristic after
  // the wait window.
  readonly host_worker_advisory?: Readonly<{
    readonly pending_extract_tasks: number;
    readonly stale_claimed_extract_tasks: number;
    readonly pending_edge_classify_tasks: number;
    readonly stale_claimed_edge_classify_tasks: number;
    readonly attach_worker_recommended: boolean;
  }>;
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

interface RuntimeWiringStatus {
  readonly request_token_source: "env" | "ephemeral";
}

export interface DoctorCommandDependencies {
  readonly getToolchainStatus: () => Promise<ToolchainStatus>;
  /**
   * Report the daemon's live request-protection wiring (token / origin source).
   * When omitted, doctor derives a conservative snapshot from process.env using
   * the same rule as createRequestProtection, so `alaya doctor` still surfaces
   * an ephemeral-token warning without a running daemon.
   */
  readonly getRuntimeWiring?: () => RuntimeWiringStatus | Promise<RuntimeWiringStatus>;
  readonly getEmbeddingStatus?: (workspaceId: string) => Promise<EmbeddingStatus>;
  readonly getMcpHealth?: () => Promise<Readonly<{ transport: "ready" | "not_ready"; enrolled_tools: number }>>;
  readonly getGardenHealth?: () => Promise<Readonly<{ status: "healthy" | "degraded"; last_pass_at: string | null }>>;
  readonly getGardenCredentialProvenance?: () => Promise<GardenCredentialProvenance>;
  // see also: WorkspaceService.reconcileBootstrapPaths; idempotent re-plant
  // for workspaces created before migration 042.
  readonly reconcileBootstrapPaths?: (
    workspaceId: string
  ) => Promise<WorkspaceBootstrapReconcileResult>;
  /**
   * Surface Garden compute provider truth (kind / model / credential /
   * routing) so operators can tell official_api from local_heuristics from
   * the deprecated embedding-fallback. When omitted, doctor reports a
   * conservative "local_heuristics + none" snapshot.
   */
  readonly getGardenCompute?: () => Promise<GardenComputeStatus> | GardenComputeStatus;
  readonly getPathPlasticityLookupTelemetry?: () =>
    | Readonly<PathPlasticityLookupTelemetrySnapshot>
    | Promise<Readonly<PathPlasticityLookupTelemetrySnapshot>>;
  readonly getGraphHealth?: (workspaceId: string) =>
    | Readonly<GraphHealthSnapshot>
    | Promise<Readonly<GraphHealthSnapshot>>;
  /**
   * Optional schema readiness probe. When provided, doctor reports
   * `storage.schema_ok` so an operator can tell apart "db file exists and is
   * writable" from "db is fully migrated for this binary".
   */
  readonly getSchemaSummary?: (
    dbPath: string
  ) => Promise<Readonly<{ persistedMaxVersion: number | null; knownMaxVersion: number; schemaOk: boolean }>>;
  readonly startupStepsProvider?: (
    context: Pick<AlayaCliContext, "daemon">
  ) => readonly DaemonStartupStepRecord[];
  readonly defaultWorkspaceId?: string;
  readonly clock?: () => string;
  /**
   * Build-time stamp (version / git_head / built_at) that doctor surfaces
   * so operators can tell which binary the daemon is running. When omitted,
   * doctor renders a "0.0.0-dev / unknown / unknown" sentinel — convenient
   * for unit tests and for source runs without a built dist/build-info.json.
   */
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
  // skipped_no_templates is a normal wired-daemon outcome when no
  // ontology-approved bootstrap seeds are configured. skipped_no_planner /
  // skipped_no_handler remain defence-in-depth arms for partial harnesses.
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
  | "bootstrap_reconcile";

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
    writable: boolean;
    schema_ok: boolean | null;
    schema_version_persisted: number | null;
    schema_version_expected: number | null;
  }>;
  readonly provider: Readonly<{
    workspace_id: string;
    embedding: EmbeddingStatus | null;
    configured: boolean;
  }>;
  readonly mcp: Readonly<{
    transport: "ready" | "not_ready";
    enrolled_tools: number;
  }>;
  readonly garden: Readonly<{
    status: "healthy" | "degraded";
    last_pass_at: string | null;
    credential_provenance: GardenCredentialProvenance;
  }>;
  readonly garden_compute: GardenComputeStatus;
  readonly recall: Readonly<{
    readonly path_plasticity_lookup: Readonly<PathPlasticityLookupTelemetrySnapshot>;
  }>;
  readonly graph_health: Readonly<GraphHealthSnapshot>;
  // Surfaces the daemon's request-protection wiring so an operator can tell an
  // ephemeral (process-generated) request token apart from an env-supplied one.
  readonly runtime_wiring: RuntimeWiringStatus;
  // Conservative storage-growth signal: the on-disk DB size plus a coarse
  // advisory. "unknown" when the DB is absent/unreadable.
  readonly storage_growth: Readonly<{
    readonly db_size_bytes: number | null;
    readonly advisory: "ok" | "large" | "unknown";
  }>;
  readonly attached_profiles: ReadonlyArray<ProfileInstructionsDriftReport>;
  // Present only when --reconcile-bootstrap is requested.
  readonly bootstrap_reconcile?: DoctorBootstrapReconcileSummary;
  readonly checks: Readonly<Record<DoctorCheckName, DoctorCheckStatus>>;
}

const PROFILE_TARGETS: readonly ProfileTarget[] = ["codex", "claude-code"];

const STARTUP_STEPS = [
  "database",
  "repositories",
  "core-services",
  "garden-runtime",
  "mcp-tooling",
  "http-app"
] as const;

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
  const report = await buildDoctorReport(ctx, args, deps, now);
  if (ctx.jsonRequested !== true) {
    writeHumanSummary(ctx.stdout, report);
  }
  return {
    exitCode: report.overall === "green" ? ALAYA_SYSEXITS.OK : ALAYA_SYSEXITS.TEMPFAIL,
    json: report
  };
}

async function buildDoctorReport(
  ctx: AlayaCliContext,
  args: DoctorArgs,
  deps: DoctorCommandDependencies,
  now: () => string
): Promise<DoctorReport> {
  const startup = readDoctorStartup(deps, ctx);
  const workspaceId = resolveCliWorkspaceContext(
    ctx,
    args.workspaceId,
    deps.defaultWorkspaceId
  ).workspaceId;
  const services = await readDoctorServices(deps, startup.ready, workspaceId);
  const bootstrapReconcileSummary = args.reconcileBootstrap
    ? await runBootstrapReconcile(deps.reconcileBootstrapPaths, workspaceId)
    : null;
  const attachedProfiles = await readAttachedProfileDrift();
  const checks = buildDoctorChecks(startup.ready, services, bootstrapReconcileSummary);
  return {
    checked_at: now(),
    overall: Object.values(checks).every((status) => status === "pass") ? "green" : "degraded",
    build_info: deps.getBuildInfo?.() ?? UNKNOWN_BUILD_INFO,
    startup,
    storage: services.storage,
    provider: {
      workspace_id: workspaceId,
      embedding: services.embeddingStatus,
      configured: services.embeddingStatus?.provider_configured ?? true
    },
    mcp: services.mcp,
    garden: {
      ...services.garden,
      credential_provenance: services.gardenCredentialProvenance
    },
    garden_compute: services.gardenCompute,
    recall: {
      path_plasticity_lookup: services.pathPlasticityLookupTelemetry
    },
    graph_health: services.graphHealth,
    runtime_wiring: services.runtimeWiring,
    storage_growth: services.storageGrowth,
    attached_profiles: attachedProfiles,
    ...(bootstrapReconcileSummary === null ? {} : { bootstrap_reconcile: bootstrapReconcileSummary }),
    checks
  };
}

function resolveRuntimeWiringFromEnv(env: NodeJS.ProcessEnv): RuntimeWiringStatus {
  const requestToken = env.ALAYA_REQUEST_TOKEN?.trim();
  return {
    request_token_source:
      requestToken !== undefined && requestToken.length > 0 ? "env" : "ephemeral"
  };
}

function readDoctorStartup(
  deps: DoctorCommandDependencies,
  ctx: AlayaCliContext
): DoctorReport["startup"] {
  const startupSteps = deps.startupStepsProvider?.(ctx) ?? ctx.daemon.startupSteps;
  const completedSteps = startupSteps.map((step) => step.step);
  const missingSteps = STARTUP_STEPS.filter((step) => !completedSteps.includes(step));
  return {
    ready: missingSteps.length === 0,
    completed_steps: completedSteps,
    missing_steps: missingSteps
  };
}

async function readDoctorServices(
  deps: DoctorCommandDependencies,
  daemonReady: boolean,
  workspaceId: string
) {
  const toolchainStatus = await deps.getToolchainStatus();
  const [storage, storageGrowth, embeddingStatus, mcp, garden, gardenCredentialProvenance, gardenCompute, pathPlasticityLookupTelemetry, graphHealth] = await Promise.all([
    inspectStorage(toolchainStatus.db_path, deps.getSchemaSummary),
    inspectStorageGrowth(toolchainStatus.db_path),
    deps.getEmbeddingStatus ? await deps.getEmbeddingStatus(workspaceId) : null,
    deps.getMcpHealth ? await deps.getMcpHealth() : defaultDoctorMcpHealth(daemonReady),
    deps.getGardenHealth ? await deps.getGardenHealth() : defaultDoctorGardenHealth(daemonReady),
    deps.getGardenCredentialProvenance ? await deps.getGardenCredentialProvenance() : ({ kind: "none" } as const),
    deps.getGardenCompute ? await deps.getGardenCompute() : defaultDoctorGardenCompute(),
    (await deps.getPathPlasticityLookupTelemetry?.()) ?? defaultPathPlasticityLookupTelemetry(),
    (await deps.getGraphHealth?.(workspaceId)) ?? createEmptyGraphHealthSnapshot(workspaceId)
  ]);
  const runtimeWiring = deps.getRuntimeWiring
    ? await deps.getRuntimeWiring()
    : resolveRuntimeWiringFromEnv(process.env);
  return {
    storage,
    storageGrowth,
    runtimeWiring,
    embeddingStatus,
    mcp,
    garden,
    gardenCredentialProvenance,
    gardenCompute,
    pathPlasticityLookupTelemetry,
    graphHealth
  };
}

function defaultDoctorMcpHealth(daemonReady: boolean) {
  return {
    transport: daemonReady ? "ready" : "not_ready",
    enrolled_tools: 0
  } as const;
}

function defaultDoctorGardenHealth(daemonReady: boolean) {
  return {
    status: daemonReady ? "healthy" : "degraded",
    last_pass_at: null
  } as const;
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

async function readAttachedProfileDrift(): Promise<readonly ProfileInstructionsDriftReport[]> {
  return await Promise.all(
    PROFILE_TARGETS.map(async (target) => {
      try {
        return await detectAttachedProfileInstructionsDrift(target);
      } catch {
        return {
          target,
          profile_path: "",
          status: "absent",
          attached_preview: null
        } as const satisfies ProfileInstructionsDriftReport;
      }
    })
  );
}

function buildDoctorChecks(
  daemonReady: boolean,
  services: Awaited<ReturnType<typeof readDoctorServices>>,
  bootstrapReconcileSummary: DoctorBootstrapReconcileSummary | null
): Record<DoctorCheckName, DoctorCheckStatus> {
  return {
    runtime: daemonReady ? "pass" : "fail",
    storage:
      services.storage.exists && services.storage.writable && services.storage.schema_ok !== false
        ? "pass"
        : "fail",
    provider:
      services.embeddingStatus === null || services.embeddingStatus.effective_mode !== "degraded"
        ? "pass"
        : "fail",
    mcp: services.mcp.transport === "ready" ? "pass" : "fail",
    garden:
      services.garden.status === "healthy" && services.gardenCompute.keychain_check?.ok !== false
        ? "pass"
        : "fail",
    bootstrap_reconcile: resolveBootstrapReconcileCheck(bootstrapReconcileSummary)
  };
}

function resolveBootstrapReconcileCheck(
  bootstrapReconcileSummary: DoctorBootstrapReconcileSummary | null
): DoctorCheckStatus {
  return bootstrapReconcileSummary === null ||
    bootstrapReconcileSummary.status === "planted" ||
    bootstrapReconcileSummary.status === "already_planted" ||
    bootstrapReconcileSummary.status === "skipped_no_templates"
    ? "pass"
    : "fail";
}
