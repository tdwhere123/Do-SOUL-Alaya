import { afterEach, describe, expect, it } from "vitest";
import { doctorAuditCheckStatus, readDoctorAuditSnapshot } from "../../cli/doctor/doctor-audit.js";

const ORIGINAL_MCP = process.env.ALAYA_MCP_SERVER_CONFIG_JSON;
const ORIGINAL_RETAIN = process.env.ALAYA_RETAIN_UNROUTED_FACTS;

afterEach(() => {
  restoreEnv("ALAYA_MCP_SERVER_CONFIG_JSON", ORIGINAL_MCP);
  restoreEnv("ALAYA_RETAIN_UNROUTED_FACTS", ORIGINAL_RETAIN);
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

function restoreEnv(name: string, original: string | undefined): void {
  if (original === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = original;
}
