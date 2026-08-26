import {
  inspectTemporalProjectionSelection,
  openReadOnlyDatabase
} from "@do-soul/alaya-storage";
import { parseDaemonMcpServerRuntimeConfigs } from "../../mcp/catalog/mcp-catalog-parsing.js";
import { listRegisteredDaemonEnvKeys } from "../../runtime/config/daemon-config-environment.js";
import { isRetainUnroutedFactsEnabled } from "../../runtime/recall-materialization/recall-materialization-router.js";

export type DoctorMcpConfigStatus = "unset" | "valid" | "invalid";

export interface DoctorAuditSnapshot {
  readonly retain_unrouted_facts: boolean;
  readonly recall_conf_flood_cap: Readonly<{
    readonly raw: string | null;
    readonly defaulted: boolean;
  }>;
  readonly mcp_server_config: DoctorMcpConfigStatus;
  readonly temporal_projection: Readonly<{
    readonly schema: "legacy" | "temporal" | "unknown";
    readonly selected: boolean;
    readonly selection_required: boolean;
  }>;
  readonly conflict_llm_raw_key_only: boolean;
  readonly registered_env_keys: readonly string[];
}

export function readDoctorAuditSnapshot(dbPath: string): DoctorAuditSnapshot {
  const floodCap = process.env.ALAYA_RECALL_CONF_FLOOD_CAP?.trim() ?? null;
  return {
    retain_unrouted_facts: isRetainUnroutedFactsEnabled(),
    recall_conf_flood_cap: {
      raw: floodCap !== null && floodCap.length > 0 ? floodCap : null,
      defaulted: floodCap === null || floodCap.length === 0 || floodCap === "1" || floodCap === "1.0"
    },
    mcp_server_config: readMcpServerConfigStatus(),
    temporal_projection: readTemporalProjectionStatus(dbPath),
    conflict_llm_raw_key_only: isConflictLlmRawKeyOnly(),
    registered_env_keys: listRegisteredDaemonEnvKeys()
  };
}

export function doctorAuditCheckStatus(snapshot: DoctorAuditSnapshot): "pass" | "fail" {
  if (snapshot.mcp_server_config === "invalid") return "fail";
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
  if (snapshot.recall_conf_flood_cap.defaulted) {
    stream.write(
      "recall flood cap WARNING: ALAYA_RECALL_CONF_FLOOD_CAP is unset or default 1.0;" +
        " flood damping is effectively disabled.\n"
    );
  } else {
    stream.write(`recall flood cap: ${snapshot.recall_conf_flood_cap.raw}\n`);
  }
  stream.write(`mcp server config json: ${snapshot.mcp_server_config}\n`);
  stream.write(
    `temporal projection: schema=${snapshot.temporal_projection.schema}` +
      ` selected=${snapshot.temporal_projection.selected ? "yes" : "no"}` +
      ` required=${snapshot.temporal_projection.selection_required ? "yes" : "no"}\n`
  );
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

function readMcpServerConfigStatus(): DoctorMcpConfigStatus {
  const raw = process.env.ALAYA_MCP_SERVER_CONFIG_JSON;
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
    return { schema: "unknown", selected: false, selection_required: false };
  }
  try {
    const database = openReadOnlyDatabase(normalized);
    try {
      const state = inspectTemporalProjectionSelection(database);
      return {
        schema: state.schema,
        selected: state.selected,
        selection_required: state.selectionRequired
      };
    } finally {
      database.close();
    }
  } catch {
    return { schema: "unknown", selected: false, selection_required: false };
  }
}

function isConflictLlmRawKeyOnly(): boolean {
  const rawKey = process.env.ALAYA_CONFLICT_LLM_API_KEY?.trim();
  const secretRef = process.env.ALAYA_CONFLICT_LLM_SECRET_REF?.trim();
  return Boolean(rawKey) && !secretRef;
}
