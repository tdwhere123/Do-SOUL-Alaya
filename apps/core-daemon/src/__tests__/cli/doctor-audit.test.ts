import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { initDatabase } from "@do-soul/alaya-storage";
import { afterEach, describe, expect, it } from "vitest";
import {
  doctorAuditCheckStatus,
  readDoctorAuditSnapshot,
  writeDoctorAuditSummary
} from "../../cli/doctor/doctor-audit.js";
import { restoreProcessEnv } from "../support/restore-process-env.js";

const ORIGINAL_MCP = process.env.ALAYA_MCP_SERVER_CONFIG_JSON;
const ORIGINAL_RETAIN = process.env.ALAYA_RETAIN_UNROUTED_FACTS;
const tempDirs: string[] = [];

afterEach(() => {
  restoreProcessEnv("ALAYA_MCP_SERVER_CONFIG_JSON", ORIGINAL_MCP);
  restoreProcessEnv("ALAYA_RETAIN_UNROUTED_FACTS", ORIGINAL_RETAIN);
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("doctor audit snapshot", () => {
  it("fails closed on invalid MCP JSON and reports retain-unrouted default off", () => {
    delete process.env.ALAYA_RETAIN_UNROUTED_FACTS;
    process.env.ALAYA_MCP_SERVER_CONFIG_JSON = "{not-json";
    const snapshot = readDoctorAuditSnapshot("");
    expect(snapshot.retain_unrouted_facts).toBe(false);
    expect(snapshot.mcp_server_config).toBe("invalid");
    expect(snapshot).not.toHaveProperty("recall_conf_flood_cap");
    expect(doctorAuditCheckStatus(snapshot)).toBe("fail");
    expect(snapshot.registered_env_keys).toEqual(
      expect.arrayContaining(["PORT", "DAEMON_HOST", "LOG_LEVEL", "ALLOWED_ORIGIN"])
    );
    const chunks: string[] = [];
    writeDoctorAuditSummary({
      write(chunk: string) {
        chunks.push(chunk);
        return true;
      }
    } as NodeJS.WritableStream, snapshot);
    expect(chunks.join("")).not.toContain("ALAYA_RECALL_CONF_FLOOD_CAP");
  });

  it("distinguishes uninitialized missing DBs from corrupt or failing DBs", () => {
    const work = mkdtempSync(path.join(tmpdir(), "alaya-doctor-audit-"));
    tempDirs.push(work);

    const missing = readDoctorAuditSnapshot(path.join(work, "does-not-exist.db"), {});
    expect(missing.temporal_projection).toEqual({
      schema: "uninitialized",
      selected: false,
      selection_required: false,
      error: null
    });
    expect(doctorAuditCheckStatus(missing)).toBe("pass");

    const corruptPath = path.join(work, "corrupt.db");
    writeFileSync(corruptPath, "not-a-sqlite-database", "utf8");
    const corrupt = readDoctorAuditSnapshot(corruptPath, {});
    expect(corrupt.temporal_projection.schema).toBe("error");
    expect(corrupt.temporal_projection.error).toBeTruthy();
    expect(doctorAuditCheckStatus(corrupt)).toBe("fail");

    const chunks: string[] = [];
    writeDoctorAuditSummary({
      write(chunk: string) {
        chunks.push(chunk);
        return true;
      }
    } as NodeJS.WritableStream, corrupt);
    expect(chunks.join("")).toContain("temporal projection ERROR:");

    const brokenTemporalPath = path.join(work, "broken-temporal.db");
    const db = initDatabase({ filename: brokenTemporalPath });
    try {
      db.connection.exec("DELETE FROM temporal_schema_state;");
    } finally {
      db.close();
    }
    const brokenTemporal = readDoctorAuditSnapshot(brokenTemporalPath, {});
    expect(brokenTemporal.temporal_projection.schema).toBe("error");
    expect(doctorAuditCheckStatus(brokenTemporal)).toBe("fail");
  });

  it("reads injected env instead of raw process.env", () => {
    delete process.env.ALAYA_RETAIN_UNROUTED_FACTS;
    delete process.env.ALAYA_MCP_SERVER_CONFIG_JSON;
    const snapshot = readDoctorAuditSnapshot("", {
      ALAYA_RETAIN_UNROUTED_FACTS: "true",
      ALAYA_CONFLICT_LLM_API_KEY: "raw-key-without-ref",
      ALAYA_MCP_SERVER_CONFIG_JSON: "{}"
    });
    expect(snapshot.retain_unrouted_facts).toBe(true);
    expect(snapshot.conflict_llm_raw_key_only).toBe(true);
    expect(snapshot.mcp_server_config).toBe("valid");
    expect(doctorAuditCheckStatus(snapshot)).toBe("pass");
  });
});
