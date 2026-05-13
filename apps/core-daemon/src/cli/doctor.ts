import { access, constants as fsConstants } from "node:fs/promises";
import type { EmbeddingStatus, ToolchainStatus } from "@do-soul/alaya-protocol";
import type { WorkspaceBootstrapReconcileResult } from "@do-soul/alaya-core";
import type { DaemonStartupStepRecord } from "../index.js";
import type { PathPlasticityLookupTelemetrySnapshot } from "../path-plasticity-runtime.js";
import type { GardenCredentialProvenance } from "../services/config-service.js";
import type { ResolveSecretError } from "../secrets.js";
import {
  detectAttachedProfileInstructionsDrift,
  type ProfileInstructionsDriftReport,
  type ProfileTarget
} from "../profile-mutation.js";
import { ALAYA_SYSEXITS, type AlayaCliArgsSchema, type AlayaCliContext, type AlayaSubcommandSpec } from "./bridge.js";
import { resolveCliWorkspaceContext } from "./workspace-context.js";
import {
  createEmptyGraphHealthSnapshot,
  type GraphHealthSnapshot,
  type GraphHealthWarning
} from "../services/graph-health-service.js";

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

export interface DoctorCommandDependencies {
  readonly getToolchainStatus: () => Promise<ToolchainStatus>;
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
}

interface DoctorArgs {
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

interface DoctorReport {
  readonly checked_at: string;
  readonly overall: "green" | "degraded";
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
    handler: async (ctx, args) => {
      const startupSteps =
        deps.startupStepsProvider?.(ctx) ?? ctx.daemon.startupSteps;
      const completedSteps = startupSteps.map((step) => step.step);
      const missingSteps = STARTUP_STEPS.filter((step) => !completedSteps.includes(step));
      const daemonReady = missingSteps.length === 0;

      const toolchainStatus = await deps.getToolchainStatus();
      const storage = await inspectStorage(toolchainStatus.db_path, deps.getSchemaSummary);
      const workspaceId = resolveCliWorkspaceContext(
        ctx,
        args.workspaceId,
        deps.defaultWorkspaceId
      ).workspaceId;
      const embeddingStatus = deps.getEmbeddingStatus
        ? await deps.getEmbeddingStatus(workspaceId)
        : null;
      const mcp = deps.getMcpHealth
        ? await deps.getMcpHealth()
        : ({
            transport: daemonReady ? "ready" : "not_ready",
            enrolled_tools: 0
          } as const);
      const garden = deps.getGardenHealth
        ? await deps.getGardenHealth()
        : ({
            status: daemonReady ? "healthy" : "degraded",
            last_pass_at: null
          } as const);
      const gardenCredentialProvenance = deps.getGardenCredentialProvenance
        ? await deps.getGardenCredentialProvenance()
        : ({ kind: "none" } as const);
      const gardenCompute: GardenComputeStatus = deps.getGardenCompute
        ? await deps.getGardenCompute()
        : {
            provider_kind: "local_heuristics",
            model_id: null,
            provider_url: null,
            credential_source: { kind: "none" },
            routing_decision: "local_heuristics"
          };
      const pathPlasticityLookupTelemetry =
        (await deps.getPathPlasticityLookupTelemetry?.()) ??
        ({
          lookup_count: 0,
          sample_count: 0,
          duration_p99_ms: null,
          window_size: 128
        } satisfies PathPlasticityLookupTelemetrySnapshot);
      const graphHealth =
        (await deps.getGraphHealth?.(workspaceId)) ??
        createEmptyGraphHealthSnapshot(workspaceId);

      // Detect drift between source ALAYA_OPERATOR_INSTRUCTIONS and the value
      // Alaya wrote into host MCP profiles on a prior `alaya attach`. Operators
      // don't always re-attach after upgrading Alaya, so we surface the
      // divergence here with a concrete refresh hint.
      const bootstrapReconcileSummary = args.reconcileBootstrap
        ? await runBootstrapReconcile(deps.reconcileBootstrapPaths, workspaceId)
        : null;
      const bootstrapReconcileCheck =
        bootstrapReconcileSummary === null ||
        bootstrapReconcileSummary.status === "planted" ||
        bootstrapReconcileSummary.status === "already_planted" ||
        bootstrapReconcileSummary.status === "skipped_no_templates"
          ? "pass"
          : "fail";

      const attachedProfiles = await Promise.all(
        PROFILE_TARGETS.map(async (target) => {
          try {
            return await detectAttachedProfileInstructionsDrift(target);
          } catch {
            // HOME unset / unreadable profile path — treat as "absent" rather
            // than failing doctor. Resolve a placeholder report.
            return {
              target,
              profile_path: "",
              status: "absent",
              attached_preview: null
            } as const satisfies ProfileInstructionsDriftReport;
          }
        })
      );

      const checks = {
        runtime: daemonReady ? "pass" : "fail",
        storage:
          storage.exists && storage.writable && storage.schema_ok !== false ? "pass" : "fail",
        provider: embeddingStatus === null || embeddingStatus.effective_mode !== "degraded" ? "pass" : "fail",
        mcp: mcp.transport === "ready" ? "pass" : "fail",
        garden: garden.status === "healthy" && gardenCompute.keychain_check?.ok !== false ? "pass" : "fail",
        bootstrap_reconcile: bootstrapReconcileCheck
      } satisfies Record<DoctorCheckName, DoctorCheckStatus>;

      const overall = Object.values(checks).every((status) => status === "pass")
        ? "green"
        : "degraded";

      const report: DoctorReport = {
        checked_at: now(),
        overall,
        startup: {
          ready: daemonReady,
          completed_steps: completedSteps,
          missing_steps: missingSteps
        },
        storage,
        provider: {
          workspace_id: workspaceId,
          embedding: embeddingStatus,
          configured: embeddingStatus?.provider_configured ?? true
        },
        mcp,
        garden: {
          ...garden,
          credential_provenance: gardenCredentialProvenance
        },
        garden_compute: gardenCompute,
        recall: {
          path_plasticity_lookup: pathPlasticityLookupTelemetry
        },
        graph_health: graphHealth,
        attached_profiles: attachedProfiles,
        ...(bootstrapReconcileSummary === null
          ? {}
          : { bootstrap_reconcile: bootstrapReconcileSummary }),
        checks
      };

      if (ctx.jsonRequested !== true) {
        writeHumanSummary(ctx.stdout, report);
      }

      return {
        exitCode: overall === "green" ? ALAYA_SYSEXITS.OK : ALAYA_SYSEXITS.TEMPFAIL,
        json: report
      };
    }
  };
}

function doctorArgsSchema(): AlayaCliArgsSchema<DoctorArgs> {
  const usage = "Usage: doctor [--workspace <workspace-id>] [--reconcile-bootstrap]";
  const duplicateFlag = (name: string, cursor: number) =>
    ({
      success: false,
      error: { issues: [{ path: [cursor], message: `${name} may only be passed once.` }] }
    }) as const;
  return {
    safeParse(input) {
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
          if (workspaceId !== null) {
            return duplicateFlag("--workspace", cursor);
          }
          const next = input[cursor + 1];
          if (next === undefined) {
            return {
              success: false,
              error: { issues: [{ path: [cursor], message: "--workspace requires a workspace id." }] }
            } as const;
          }
          if (next.startsWith("--")) {
            return {
              success: false,
              error: {
                issues: [
                  { path: [cursor + 1], message: "--workspace requires a workspace id, not a flag." }
                ]
              }
            } as const;
          }
          const candidate = next.trim();
          if (candidate.length === 0) {
            return {
              success: false,
              error: { issues: [{ path: [cursor + 1], message: "Workspace id must not be empty." }] }
            } as const;
          }
          workspaceId = candidate;
          cursor += 2;
          continue;
        }
        if (token === "--reconcile-bootstrap") {
          if (reconcileBootstrap) {
            return duplicateFlag("--reconcile-bootstrap", cursor);
          }
          reconcileBootstrap = true;
          cursor += 1;
          continue;
        }
        return {
          success: false,
          error: { issues: [{ path: [cursor], message: usage }] }
        } as const;
      }

      return {
        success: true,
        data: { workspaceId, reconcileBootstrap }
      } as const;
    }
  };
}

async function inspectStorage(
  dbPath: string,
  getSchemaSummary?: DoctorCommandDependencies["getSchemaSummary"]
): Promise<DoctorReport["storage"]> {
  const normalizedPath = dbPath.trim();
  const emptyStorage = (existsValue: boolean, writableValue: boolean): DoctorReport["storage"] => ({
    db_path: normalizedPath.length === 0 ? dbPath : normalizedPath,
    exists: existsValue,
    writable: writableValue,
    schema_ok: null,
    schema_version_persisted: null,
    schema_version_expected: null
  });

  if (normalizedPath.length === 0) {
    return emptyStorage(false, false);
  }

  try {
    await access(normalizedPath, fsConstants.F_OK);
  } catch {
    return emptyStorage(false, false);
  }

  let writable = true;
  try {
    await access(normalizedPath, fsConstants.W_OK);
  } catch {
    writable = false;
  }

  if (!writable) {
    return emptyStorage(true, false);
  }

  if (getSchemaSummary === undefined) {
    return {
      db_path: normalizedPath,
      exists: true,
      writable: true,
      schema_ok: null,
      schema_version_persisted: null,
      schema_version_expected: null
    };
  }

  try {
    const summary = await getSchemaSummary(normalizedPath);
    return {
      db_path: normalizedPath,
      exists: true,
      writable: true,
      schema_ok: summary.schemaOk,
      schema_version_persisted: summary.persistedMaxVersion,
      schema_version_expected: summary.knownMaxVersion
    };
  } catch {
    return {
      db_path: normalizedPath,
      exists: true,
      writable: true,
      schema_ok: false,
      schema_version_persisted: null,
      schema_version_expected: null
    };
  }
}

function writeHumanSummary(stream: NodeJS.WritableStream, report: DoctorReport): void {
  stream.write(`doctor overall: ${report.overall}\n`);
  stream.write(`runtime ready: ${report.startup.ready ? "yes" : "no"}\n`);
  stream.write(`storage db path: ${report.storage.db_path}\n`);
  stream.write(`storage writable: ${report.storage.writable ? "yes" : "no"}\n`);
  if (report.storage.schema_ok !== null) {
    stream.write(
      `storage schema_ok: ${report.storage.schema_ok ? "yes" : "no"}` +
        ` (persisted=${report.storage.schema_version_persisted ?? "none"}, expected=${
          report.storage.schema_version_expected ?? "?"
        })\n`
    );
  }
  stream.write(`mcp transport: ${report.mcp.transport}\n`);
  stream.write(`garden status: ${report.garden.status}\n`);
  stream.write(`garden credential provenance: ${formatGardenCredentialProvenance(report.garden.credential_provenance)}\n`);
  // Surface Garden compute truth so operators can tell whether Garden is
  // calling out (official_api), running locally (local_heuristics), or
  // borrowing the embedding key (deprecated embedding-fallback).
  stream.write(
    `garden compute: kind=${report.garden_compute.provider_kind}` +
      ` routing=${report.garden_compute.routing_decision}` +
      ` model=${report.garden_compute.model_id ?? "default"}` +
      ` cred=${formatCredentialSource(report.garden_compute.credential_source)}\n`
  );
  if (report.garden_compute.keychain_check !== undefined) {
    stream.write(`${formatGardenKeychainCheck(report.garden_compute.keychain_check)}\n`);
  }
  // Auto-extract path: every recall (with turn text) enqueues a turn-text
  // extract task; tell the operator where those tasks get run so "memory is
  // not being captured" is diagnosable from doctor alone.
  stream.write(
    `recall-driven extraction: ${
      report.garden_compute.routing_decision === "host_worker"
        ? "queued for a host worker (provider_kind=host_worker)"
        : `in-process via ${report.garden_compute.routing_decision}`
    }\n`
  );
  stream.write(
    `recall path plasticity lookup: count=${report.recall.path_plasticity_lookup.lookup_count}` +
      ` p99_ms=${report.recall.path_plasticity_lookup.duration_p99_ms ?? "n/a"}` +
      ` samples=${report.recall.path_plasticity_lookup.sample_count}` +
      ` window=${report.recall.path_plasticity_lookup.window_size}\n`
  );
  stream.write(
    `graph health: ${report.graph_health.status}` +
      ` memory_edges=${report.graph_health.memory_graph_edges_total}` +
      ` path_relations=${report.graph_health.path_relations_total}` +
      ` latest_path_event=${report.graph_health.latest_path_event_at ?? "none"}\n`
  );
  if (report.graph_health.warnings.length > 0) {
    stream.write(
      `graph health warnings: ${formatGraphHealthWarnings(report.graph_health.warnings)}` +
        ` - ${report.graph_health.hint ?? "Inspect graph/path producers for this workspace."}\n`
    );
  }
  if (report.provider.embedding !== null) {
    stream.write(
      `embedding mode: ${report.provider.embedding.effective_mode} (provider_configured=${report.provider.embedding.provider_configured ? "yes" : "no"})\n`
    );
  }
  if (report.bootstrap_reconcile !== undefined) {
    stream.write(`${formatBootstrapReconcileSummary(report.bootstrap_reconcile)}\n`);
  }
  for (const profile of report.attached_profiles) {
    if (profile.status === "drifted") {
      stream.write(
        `attached profile (${profile.target}): instructions DRIFTED — ` +
          `host file is older than current source. ` +
          `Run \`alaya attach ${profile.target}\` to refresh ` +
          `(${profile.profile_path}).\n`
      );
    } else if (profile.status === "in_sync") {
      stream.write(`attached profile (${profile.target}): in sync\n`);
    }
    // status === "absent" is silent — the user may have intentionally not
    // attached this target.
  }
}

function formatGraphHealthWarnings(warnings: readonly GraphHealthWarning[]): string {
  return warnings.join(",");
}

function formatCredentialSource(source: GardenComputeStatus["credential_source"]): string {
  switch (source.kind) {
    case "env":
      return `env:${source.name}`;
    case "file":
      return `file:${source.masked_path}`;
    case "keychain":
      return `keychain:${source.service}:${source.account}`;
    case "embedding-fallback":
      return "embedding-fallback (deprecated)";
    case "none":
      return "none";
  }
}

function formatGardenCredentialProvenance(provenance: GardenCredentialProvenance): string {
  return provenance.kind === "embedding-fallback"
    ? "deprecated embedding-fallback"
    : provenance.kind;
}

async function runBootstrapReconcile(
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
        return {
          status: "planted",
          paths_planted: result.paths_planted,
          record_id: result.record_id,
          template_ids: result.template_ids
        };
      case "already_planted":
        return {
          status: "already_planted",
          record_id: result.record_id,
          relation_count: result.relation_count
        };
      case "corrupt_partial":
        return {
          status: "corrupt_partial",
          record_id: result.record_id,
          relation_count: result.relation_count,
          reason: result.reason
        };
      case "skipped_no_templates":
        return {
          status: "skipped_no_templates",
          template_ids: result.template_ids
        };
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

function formatBootstrapReconcileSummary(summary: DoctorBootstrapReconcileSummary): string {
  switch (summary.status) {
    case "planted":
      return (
        `bootstrap reconcile: planted ${summary.paths_planted} seed path(s)` +
        ` (record=${summary.record_id})`
      );
    case "already_planted":
      return (
        `bootstrap reconcile: already planted` +
        ` (record=${summary.record_id ?? "absent"}, relations=${summary.relation_count})`
      );
    case "corrupt_partial":
      return (
        `bootstrap reconcile: corrupt partial state` +
        ` (record=${summary.record_id}, relations=${summary.relation_count}) - ${summary.reason}`
      );
    case "skipped_no_templates":
      return "bootstrap reconcile: skipped - no configured bootstrap templates";
    case "skipped_no_planner":
      return "bootstrap reconcile: skipped - planner not wired";
    case "skipped_no_handler":
      return "bootstrap reconcile: skipped - no handler available";
    case "failed":
      return `bootstrap reconcile: failed - ${summary.reason}`;
  }
}

function formatGardenKeychainCheck(check: GardenKeychainCheck): string {
  // Defensive: a malformed ref can reach this branch with empty
  // service/account when keychainCheckField is invoked directly with
  // an invalid ref string (post-schema-fallback this is unreachable
  // via the normal doctor pipeline, but the renderer still needs to
  // render something operator-actionable instead of "keychain::").
  const ref =
    check.service === "" || check.account === ""
      ? "keychain:<malformed>"
      : `keychain:${check.service}:${check.account}`;
  return check.ok
    ? `garden keychain: ok (${ref})`
    : `garden keychain: unavailable (${ref}) — ${check.remediation}`;
}
