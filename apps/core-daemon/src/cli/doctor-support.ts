import { access, constants as fsConstants, stat } from "node:fs/promises";
import type { WorkspaceBootstrapReconcileResult } from "@do-soul/alaya-core";
import type { GardenCredentialProvenance } from "../services/config-service.js";
import type { GraphHealthWarning } from "../services/graph-health-service.js";
import type { AlayaCliArgsSchema } from "./bridge.js";
import type {
  DoctorArgs,
  DoctorBootstrapReconcileSummary,
  DoctorCommandDependencies,
  DoctorReport,
  GardenComputeStatus,
  GardenKeychainCheck
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
        | {
            readonly success: false;
            readonly error: {
              readonly issues: readonly {
                readonly path: readonly number[];
                readonly message: string;
              }[];
            };
          };
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
    return createStorageSnapshot(dbPath, normalizedPath, false, false);
  }

  const accessState = await inspectStorageAccess(normalizedPath);
  if (!accessState.exists || !accessState.writable) {
    return createStorageSnapshot(dbPath, normalizedPath, accessState.exists, accessState.writable);
  }
  if (getSchemaSummary === undefined) {
    return createStorageSnapshot(dbPath, normalizedPath, true, true);
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

export function writeHumanSummary(stream: NodeJS.WritableStream, report: DoctorReport): void {
  writeDoctorCoreSummary(stream, report);
  writeGardenComputeSummary(stream, report);
  writeRecallGraphSummary(stream, report);
  writeDoctorProfileSummary(stream, report);
}

function createStorageSnapshot(
  originalPath: string,
  normalizedPath: string,
  existsValue: boolean,
  writableValue: boolean
): DoctorReport["storage"] {
  return {
    db_path: normalizedPath.length === 0 ? originalPath : normalizedPath,
    exists: existsValue,
    writable: writableValue,
    schema_ok: null,
    schema_version_persisted: null,
    schema_version_expected: null
  };
}

async function inspectStorageAccess(
  normalizedPath: string
): Promise<Readonly<{ exists: boolean; writable: boolean }>> {
  try {
    await access(normalizedPath, fsConstants.F_OK);
  } catch {
    return { exists: false, writable: false };
  }
  try {
    await access(normalizedPath, fsConstants.W_OK);
    return { exists: true, writable: true };
  } catch {
    return { exists: true, writable: false };
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

function writeDoctorCoreSummary(stream: NodeJS.WritableStream, report: DoctorReport): void {
  stream.write(`doctor overall: ${report.overall}\n`);
  stream.write(
    `version: ${report.build_info.version}` +
      ` git_head: ${shortenGitHead(report.build_info.git_head)}` +
      ` built_at: ${report.build_info.built_at}\n`
  );
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
  stream.write(
    `storage growth: db_size_bytes=${report.storage_growth.db_size_bytes ?? "unknown"}` +
      ` advisory=${report.storage_growth.advisory}\n`
  );
  if (report.storage_growth.advisory === "large") {
    stream.write(
      "storage growth WARNING: the SQLite DB has grown past the advisory" +
        " threshold; monitor tail latency and plan compaction/retention.\n"
    );
  }
  stream.write(`mcp transport: ${report.mcp.transport}\n`);
  stream.write(`garden status: ${report.garden.status}\n`);
  stream.write(`garden credential provenance: ${formatGardenCredentialProvenance(report.garden.credential_provenance)}\n`);
  stream.write(`runtime wiring: request_token=${report.runtime_wiring.request_token_source}\n`);
  if (report.runtime_wiring.request_token_source === "ephemeral") {
    stream.write(
      "runtime wiring WARNING: ALAYA_REQUEST_TOKEN unset; using a process-generated" +
        " ephemeral request token (rotates each restart — set ALAYA_REQUEST_TOKEN for a stable token).\n"
    );
  }
}

function writeGardenComputeSummary(stream: NodeJS.WritableStream, report: DoctorReport): void {
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
  // Surface the zero-own-LLM default's operating mode: under host_worker, tell
  // the operator whether an attached CLI agent is claiming extract work (LLM
  // quality) or whether it is aging unclaimed and falling back to the zero-cloud
  // heuristic — so "attach an agent for better extraction" is diagnosable from
  // doctor alone.
  if (report.garden_compute.host_worker_advisory !== undefined) {
    const advisory = report.garden_compute.host_worker_advisory;
    if (advisory.attach_worker_recommended) {
      stream.write(
        `garden compute WARNING: provider_kind=host_worker is the default and` +
          ` ${advisory.pending_extract_tasks} recall-driven POST_TURN_EXTRACT task(s) are unclaimed` +
          ` (${advisory.stale_claimed_extract_tasks} claimed-then-abandoned),` +
          ` ${advisory.pending_edge_classify_tasks} EDGE_CLASSIFY task(s) are unclaimed` +
          ` (${advisory.stale_claimed_edge_classify_tasks} claimed-then-abandoned). Attach Codex /` +
          ` Claude Code (\`alaya attach <target>\`) for LLM-quality extraction and edge refinement;` +
          ` unclaimed work falls back to the zero-cloud heuristic after the host-worker wait window.\n`
      );
    } else {
      stream.write(
        `garden compute: host_worker default — attach a CLI agent for LLM-quality extraction` +
          ` (zero-cloud heuristic fallback runs if no worker claims).\n`
      );
    }
  }
}

function writeRecallGraphSummary(stream: NodeJS.WritableStream, report: DoctorReport): void {
  stream.write(
    `recall path plasticity lookup: count=${report.recall.path_plasticity_lookup.lookup_count}` +
      ` p99_ms=${report.recall.path_plasticity_lookup.duration_p99_ms ?? "n/a"}` +
      ` samples=${report.recall.path_plasticity_lookup.sample_count}` +
      ` window=${report.recall.path_plasticity_lookup.window_size}\n`
  );
  stream.write(
    `graph health: ${report.graph_health.status}` +
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
}

function writeDoctorProfileSummary(stream: NodeJS.WritableStream, report: DoctorReport): void {
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

function shortenGitHead(head: string): string {
  if (head === "unknown") {
    return head;
  }
  return head.length >= 7 ? head.slice(0, 7) : head;
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
