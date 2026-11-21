import { localOnnxHostSingleFlightEnabled } from "@do-soul/alaya-core";
import { resolveEffectiveEmbeddingPosture } from "../../ai/daemon-embedding-runtime-config.js";
import { ATTACHED_MCP_CONFIRMATION_TOKEN_LEAK_PREVIEW } from "../../attach/profile-mutation/profile-mutation.js";
import type { GardenCaptureHealth } from "../../garden/host-session/capture-health.js";
import { processEnvLookup } from "../../runtime/config/daemon-config-environment.js";
import type { GardenCredentialProvenance } from "../../services/config/config-service.js";
import type { GraphHealthWarning } from "../../services/status/graph-health-service.js";
import { writeDoctorAuditSummary } from "./doctor-audit.js";
import type {
  DoctorBootstrapReconcileSummary,
  DoctorReport,
  GardenComputeStatus,
  GardenKeychainCheck
} from "./doctor.js";

export function writeHumanSummary(
  stream: NodeJS.WritableStream,
  report: DoctorReport,
  env: NodeJS.ProcessEnv = processEnvLookup()
): void {
  writeDoctorCoreSummary(stream, report);
  writeRuntimeWiringSummary(stream, report);
  writeGardenComputeSummary(stream, report);
  writeRecallGraphSummary(stream, report, env);
  writeDoctorAuditSummary(stream, report.audit);
  writeDoctorProfileSummary(stream, report);
  if (report.confirmation_token_isolation === "executor_holds_token") {
    stream.write(
      "attached MCP executor holds ALAYA_MCP_TOOL_CONFIRMATION_TOKEN; confirmation belongs in an isolated confirmer.\n"
    );
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
  stream.write(`storage exists: ${report.storage.exists ? "yes" : "no"}\n`);
  stream.write(`storage readable: ${report.storage.readable ? "yes" : "no"}\n`);
  stream.write(`storage writable: ${report.storage.writable ? "yes" : "no"}\n`);
  if (report.storage.error_code !== null) {
    stream.write(`storage error_code: ${report.storage.error_code}\n`);
  }
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
  stream.write(`garden scheduler activity: ${report.garden.status} (recent enqueue/dispatch; task success is separate)\n`);
  stream.write(`garden schema_ok: ${report.garden.schema_ok ? "yes" : "no"}\n`);
  if (report.garden_compute.degraded_reason) {
    stream.write(`garden compute degraded_reason: ${report.garden_compute.degraded_reason}\n`);
  }
  stream.write(`garden credential provenance: ${formatGardenCredentialProvenance(report.garden.credential_provenance)}\n`);
}

function writeRuntimeWiringSummary(stream: NodeJS.WritableStream, report: DoctorReport): void {
  stream.write(
    `runtime wiring: request_token=${report.runtime_wiring.request_token_source}` +
      ` daemon_socket=${report.runtime_wiring.daemon_socket ?? "none"}` +
      ` wildcard_bind=${report.runtime_wiring.wildcard_bind_opt_in ? "yes" : "no"}` +
      ` token_workspaces=${report.runtime_wiring.request_token_workspaces ?? "none"}\n`
  );
  if (report.runtime_wiring.request_token_source === "ephemeral") {
    stream.write(
      "runtime wiring WARNING: ALAYA_REQUEST_TOKEN unset; using a process-generated" +
        " ephemeral request token (rotates each restart — set ALAYA_REQUEST_TOKEN for a stable token).\n"
    );
  }
  if (report.runtime_wiring.wildcard_bind_opt_in) {
    stream.write(
      "runtime wiring WARNING: ALAYA_ALLOW_WILDCARD_BIND=1; wildcard TCP bind still requires loopback or ALAYA_DAEMON_SOCKET.\n"
    );
  }
}

function writeGardenComputeSummary(stream: NodeJS.WritableStream, report: DoctorReport): void {
  stream.write(
    `garden compute: kind=${report.garden_compute.provider_kind}` +
      ` routing=${report.garden_compute.routing_decision}` +
      ` model=${report.garden_compute.model_id ?? "default"}` +
      ` cred=${formatCredentialSource(report.garden_compute.credential_source)}\n`
  );
  if (report.garden_compute.keychain_check !== undefined) {
    stream.write(`${formatGardenKeychainCheck(report.garden_compute.keychain_check)}\n`);
  }
  stream.write(
    `recall-driven extraction: ${
      report.garden_compute.routing_decision === "host_worker"
        ? "queued for a host worker (provider_kind=host_worker)"
        : `in-process via ${report.garden_compute.routing_decision}`
    }\n`
  );
  if (report.garden_compute.host_worker_advisory !== undefined) {
    writeHostWorkerAdvisory(stream, report.garden_compute.host_worker_advisory);
  }
  const capture = report.garden_compute.capture;
  if (capture !== undefined) {
    writeCaptureSummary(stream, capture);
  }
}

function writeHostWorkerAdvisory(
  stream: NodeJS.WritableStream,
  advisory: NonNullable<GardenComputeStatus["host_worker_advisory"]>
): void {
  if (advisory.attach_worker_recommended) {
    stream.write(
      `garden compute WARNING: provider_kind=host_worker is the default and` +
        ` ${advisory.pending_extract_tasks} recall-driven SOURCE_STATEMENT_SESSION task(s) are unclaimed` +
        ` (${advisory.stale_claimed_extract_tasks} claimed-then-abandoned),` +
        ` ${advisory.pending_edge_classify_tasks} EDGE_CLASSIFY task(s) are unclaimed` +
        ` (${advisory.stale_claimed_edge_classify_tasks} claimed-then-abandoned). Attach Codex /` +
        ` Claude Code (\`alaya attach <target>\`) for LLM-quality extraction and edge refinement;` +
        ` unclaimed work falls back to the zero-cloud heuristic after the host-worker wait window.\n`
    );
    return;
  }
  stream.write(
    `garden compute: host_worker default — attach a CLI agent for LLM-quality extraction` +
      ` (zero-cloud heuristic fallback runs if no worker claims).\n`
  );
}

function writeCaptureSummary(stream: NodeJS.WritableStream, capture: GardenCaptureHealth): void {
  const host = capture.host_session;
  stream.write(
    host.captured_messages === 0
      ? "host session capture: none — the host must call soul.capture_host_session (report_context_usage no longer captures)\n"
      : `host session capture: messages=${host.captured_messages} excerpt=${host.excerpt_messages}` +
          ` unbound=${host.unbound_messages} overdue_unbound=${host.overdue_unbound_messages} last=${host.last_captured_at}\n`
  );
  const sessions = capture.statement_sessions;
  stream.write(
    `statement sessions: ${sessions.failed} failed of the last ${sessions.recent_window}` +
      (sessions.latest_error === null ? "" : ` (latest: ${sessions.latest_error})`) +
      "\n"
  );
  if (capture.legacy_post_turn_unprocessed > 0) {
    stream.write(`legacy post-turn captures without statements: ${capture.legacy_post_turn_unprocessed}\n`);
  }
}

function writeRecallGraphSummary(
  stream: NodeJS.WritableStream,
  report: DoctorReport,
  env: NodeJS.ProcessEnv
): void {
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
    writeLocalOnnxHostSingleFlightHint(stream, env);
  }
  if (report.provider.query_embedding_warmup !== null) {
    stream.write(
      `query embedding warmup: ${report.provider.query_embedding_warmup.status}` +
        ` ready=${report.provider.query_embedding_warmup.ready_count}` +
        ` requested=${report.provider.query_embedding_warmup.requested_count}` +
        (report.provider.query_embedding_warmup.last_error === undefined
          ? ""
          : ` last_error=${report.provider.query_embedding_warmup.last_error}`) +
        "\n"
    );
  }
  if (report.bootstrap_reconcile !== undefined) {
    stream.write(`${formatBootstrapReconcileSummary(report.bootstrap_reconcile)}\n`);
  }
}

function writeLocalOnnxHostSingleFlightHint(
  stream: NodeJS.WritableStream,
  env: NodeJS.ProcessEnv
): void {
  const posture = resolveEffectiveEmbeddingPosture((key) => env[key]);
  if (posture.providerKind !== "local_onnx") {
    return;
  }
  if (localOnnxHostSingleFlightEnabled(env)) {
    stream.write("local ONNX host single-flight: enabled\n");
    return;
  }
  stream.write(
    "local ONNX host single-flight: off (set ALAYA_LOCAL_ONNX_HOST_SINGLE_FLIGHT=1 when multiple local ONNX processes share a host)\n"
  );
}

function writeDoctorProfileSummary(stream: NodeJS.WritableStream, report: DoctorReport): void {
  for (const profile of report.attached_profiles) {
    if (profile.attached_preview === ATTACHED_MCP_CONFIRMATION_TOKEN_LEAK_PREVIEW) {
      stream.write(
        `attached profile (${profile.target}): MCP env must not contain ALAYA_MCP_TOOL_CONFIRMATION_TOKEN ` +
          `(${profile.profile_path}).\n`
      );
      continue;
    }
    if (profile.status === "drifted") {
      stream.write(
        `attached profile (${profile.target}): instructions DRIFTED — ` +
          `host file is older than current source. ` +
          `Run \`alaya attach ${profile.target}\` to refresh ` +
          `(${profile.profile_path}).\n`
      );
    } else if (profile.status === "in_sync") {
      stream.write(`attached profile (${profile.target}): in sync\n`);
    } else if (profile.status === "error") {
      stream.write(
        `attached profile (${profile.target}): ERROR reading profile drift` +
          `${profile.profile_path.length > 0 ? ` (${profile.profile_path})` : ""}\n`
      );
    }
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
  const ref =
    check.service === "" || check.account === ""
      ? "keychain:<malformed>"
      : `keychain:${check.service}:${check.account}`;
  return check.ok
    ? `garden keychain: ok (${ref})`
    : `garden keychain: unavailable (${ref}) — ${check.remediation}`;
}
