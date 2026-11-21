import { statSync } from "node:fs";
import {
  inspectTemporalProjectionSelection,
  openReadOnlyDatabase
} from "@do-soul/alaya-storage";
import { parseDaemonMcpServerRuntimeConfigs } from "../../mcp/catalog/mcp-catalog-parsing.js";
import { listRegisteredDaemonEnvKeys, processEnvLookup } from "../../runtime/config/daemon-config-environment.js";
import { isRetainUnroutedFactsEnabled } from "../../runtime/recall-materialization/recall-materialization-router.js";

export type DoctorMcpConfigStatus = "unset" | "valid" | "invalid";

export interface DoctorAuditSnapshot {
  readonly retain_unrouted_facts: boolean;
  readonly mcp_server_config: DoctorMcpConfigStatus;
  readonly temporal_projection: Readonly<{
    readonly schema: "legacy" | "temporal" | "uninitialized" | "error";
    readonly selected: boolean;
    readonly selection_required: boolean;
    readonly error: string | null;
  }>;
  readonly conflict_llm_raw_key_only: boolean;
  readonly registered_env_keys: readonly string[];
}

export function readDoctorAuditSnapshot(
  dbPath: string,
  env: NodeJS.ProcessEnv = processEnvLookup()
): DoctorAuditSnapshot {
  return {
    retain_unrouted_facts: isRetainUnroutedFactsEnabled(env.ALAYA_RETAIN_UNROUTED_FACTS),
    mcp_server_config: readMcpServerConfigStatus(env),
    temporal_projection: readTemporalProjectionStatus(dbPath),
    conflict_llm_raw_key_only: isConflictLlmRawKeyOnly(env),
    registered_env_keys: listRegisteredDaemonEnvKeys()
  };
}

export function doctorAuditCheckStatus(snapshot: DoctorAuditSnapshot): "pass" | "fail" {
  if (snapshot.mcp_server_config === "invalid") return "fail";
  if (snapshot.temporal_projection.schema === "error") return "fail";
  if (
    snapshot.temporal_projection.schema === "temporal" &&
    snapshot.temporal_projection.selection_required &&
    !snapshot.temporal_projection.selected
  ) {
    return "fail";
  }
  return "pass";
}

export function writeDoctorAuditSummary(
  stream: NodeJS.WritableStream,
  snapshot: DoctorAuditSnapshot
): void {
  stream.write(
    `retain unrouted facts: ${snapshot.retain_unrouted_facts ? "on" : "off"}` +
      ` (ALAYA_RETAIN_UNROUTED_FACTS default off; set 1/true to enable)\n`
  );
  stream.write(`mcp server config json: ${snapshot.mcp_server_config}\n`);
  stream.write(
    `temporal projection: schema=${snapshot.temporal_projection.schema}` +
      ` selected=${snapshot.temporal_projection.selected ? "yes" : "no"}` +
      ` required=${snapshot.temporal_projection.selection_required ? "yes" : "no"}\n`
  );
  if (snapshot.temporal_projection.schema === "error") {
    stream.write(
      `temporal projection ERROR: ${snapshot.temporal_projection.error ?? "failed to inspect temporal projection state."}\n`
    );
  }
  if (
    snapshot.temporal_projection.schema === "temporal" &&
    snapshot.temporal_projection.selection_required &&
    !snapshot.temporal_projection.selected
  ) {
    stream.write(
      "temporal projection ERROR: temporal schema exists but is unselected (mixed-mode);" +
        " complete cutover selection or rollback before serving writes.\n"
    );
  }
  if (snapshot.conflict_llm_raw_key_only) {
    stream.write(
      "conflict LLM WARNING: ALAYA_CONFLICT_LLM_API_KEY is set without" +
        " ALAYA_CONFLICT_LLM_SECRET_REF; move the key to secret_ref/keychain.\n"
    );
  }
  stream.write(
    `effective env keys: ${snapshot.registered_env_keys.join(",")}\n`
  );
}

function readMcpServerConfigStatus(env: NodeJS.ProcessEnv): DoctorMcpConfigStatus {
  const raw = env.ALAYA_MCP_SERVER_CONFIG_JSON;
  if (raw === undefined || raw.trim().length === 0) {
    return "unset";
  }
  try {
    parseDaemonMcpServerRuntimeConfigs(raw);
    return "valid";
  } catch {
    return "invalid";
  }
}

function readTemporalProjectionStatus(dbPath: string): DoctorAuditSnapshot["temporal_projection"] {
  const normalized = dbPath.trim();
  if (normalized.length === 0) {
    return { schema: "uninitialized", selected: false, selection_required: false, error: null };
  }
  const existence = checkDatabaseExists(normalized);
  if (existence.status === "missing") {
    return { schema: "uninitialized", selected: false, selection_required: false, error: null };
  }
  if (existence.status === "error") {
    return { schema: "error", selected: false, selection_required: false, error: existence.error };
  }
  try {
    const database = openReadOnlyDatabase(normalized);
    try {
      const state = inspectTemporalProjectionSelection(database);
      return {
        schema: state.schema,
        selected: state.selected,
        selection_required: state.selectionRequired,
        error: null
      };
    } finally {
      database.close();
    }
  } catch (error) {
    return {
      schema: "error",
      selected: false,
      selection_required: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

function checkDatabaseExists(
  dbPath: string
): { readonly status: "exists" | "missing" } | { readonly status: "error"; readonly error: string } {
  try {
    statSync(dbPath);
    return { status: "exists" };
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? (error as { readonly code?: unknown }).code
        : undefined;
    if (code === "ENOENT") {
      return { status: "missing" };
    }
    return { status: "error", error: error instanceof Error ? error.message : String(error) };
  }
}

function isConflictLlmRawKeyOnly(env: NodeJS.ProcessEnv): boolean {
  const rawKey = env.ALAYA_CONFLICT_LLM_API_KEY?.trim();
  const secretRef = env.ALAYA_CONFLICT_LLM_SECRET_REF?.trim();
  return Boolean(rawKey) && !secretRef;
}
