import { afterEach, describe, expect, it } from "vitest";
import { doctorAuditCheckStatus, readDoctorAuditSnapshot } from "../../cli/doctor/doctor-audit.js";
import { restoreProcessEnv } from "../support/restore-process-env.js";

const ORIGINAL_MCP = process.env.ALAYA_MCP_SERVER_CONFIG_JSON;
const ORIGINAL_RETAIN = process.env.ALAYA_RETAIN_UNROUTED_FACTS;

afterEach(() => {
  restoreProcessEnv("ALAYA_MCP_SERVER_CONFIG_JSON", ORIGINAL_MCP);
  restoreProcessEnv("ALAYA_RETAIN_UNROUTED_FACTS", ORIGINAL_RETAIN);
});

describe("doctor audit snapshot", () => {
  it("fails closed on invalid MCP JSON and reports retain-unrouted default off", () => {
    delete process.env.ALAYA_RETAIN_UNROUTED_FACTS;
    process.env.ALAYA_MCP_SERVER_CONFIG_JSON = "{not-json";
    const snapshot = readDoctorAuditSnapshot("");
    expect(snapshot.retain_unrouted_facts).toBe(false);
    expect(snapshot.mcp_server_config).toBe("invalid");
    expect(doctorAuditCheckStatus(snapshot)).toBe("fail");
    expect(snapshot.registered_env_keys).toEqual(
      expect.arrayContaining(["PORT", "DAEMON_HOST", "LOG_LEVEL", "ALLOWED_ORIGIN"])
    );
  });
});
