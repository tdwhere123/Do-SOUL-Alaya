import { access } from "node:fs/promises";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { createAlayaCliBridge } from "../../cli/bridge.js";
import {
  assessGardenPassHealth,
  assessMcpCatalogTransport,
  createDoctorCommand,
  GARDEN_SCHEDULER_INTERVAL_MS,
  GARDEN_STALE_PASS_INTERVALS
} from "../../cli/doctor/doctor.js";
import { inspectStorage } from "../../cli/doctor/doctor-support.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    access: vi.fn(actual.access)
  };
});

const mockedAccess = vi.mocked(access);

const STARTUP_STEPS = [
  "database",
  "repositories",
  "core-services",
  "garden-runtime",
  "mcp-tooling",
  "http-app"
] as const;

describe("doctor MCP and Garden health", () => {
  it("treats inactive catalog servers and last_error as not ready", () => {
    expect(
      assessMcpCatalogTransport({
        servers: [
          {
            status: "inactive",
            last_error: { code: "MCP_EXTERNAL_TIMEOUT", message: "External MCP server timed out." }
          }
        ]
      })
    ).toBe("not_ready");
    expect(assessMcpCatalogTransport({ servers: [] })).toBe("ready");
  });

  it("treats a last_pass_at older than two scheduler intervals as degraded", () => {
    const now = Date.parse("2026-05-05T00:04:00.000Z");
    expect(assessGardenPassHealth("2026-05-05T00:00:00.000Z", now)).toBe("degraded");
    expect(
      assessGardenPassHealth(
        new Date(now - GARDEN_STALE_PASS_INTERVALS * GARDEN_SCHEDULER_INTERVAL_MS + 1).toISOString(),
        now
      )
    ).toBe("healthy");
    expect(assessGardenPassHealth(null, now)).toBe("degraded");
  });

  it("exits non-zero for an inactive catalog and stale Garden pass", async () => {
    const daemon = {
      startupSteps: STARTUP_STEPS.map((step) => ({
        step,
        completedAt: "2026-05-05T00:00:00.000Z"
      }))
    };
    const bridge = createAlayaCliBridge(daemon, {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      isTTY: false
    });
    bridge.registerSubcommand(
      createDoctorCommand({
        getToolchainStatus: async () => ({
          tools: {},
          active_worktrees: 1,
          db_path: "",
          files_dir: "/tmp/files"
        }),
        getMcpHealth: async () => ({ transport: "not_ready", enrolled_tools: 0 }),
        getGardenHealth: async () => ({
          status: "degraded",
          last_pass_at: "2026-05-04T00:00:00.000Z"
        }),
        clock: () => "2026-05-05T00:00:00.000Z"
      })
    );

    const result = await bridge.dispatch(["doctor", "--json"]);
    expect(result.exitCode).not.toBe(0);
    expect(result.json).toMatchObject({
      overall: "degraded",
      checks: {
        mcp: "fail",
        garden: "fail"
      }
    });
  });

  it("reports garden schema_ok false when compute config is degraded", async () => {
    const daemon = {
      startupSteps: STARTUP_STEPS.map((step) => ({
        step,
        completedAt: "2026-05-05T00:00:00.000Z"
      }))
    };
    const bridge = createAlayaCliBridge(daemon, {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      isTTY: false
    });
    bridge.registerSubcommand(
      createDoctorCommand({
        getToolchainStatus: async () => ({
          tools: {},
          active_worktrees: 1,
          db_path: "",
          files_dir: "/tmp/files"
        }),
        getMcpHealth: async () => ({ transport: "ready", enrolled_tools: 0 }),
        getGardenHealth: async () => ({
          status: "healthy",
          last_pass_at: "2026-05-05T00:00:00.000Z"
        }),
        getGardenCompute: async () => ({
          provider_kind: "local_heuristics",
          model_id: null,
          provider_url: null,
          credential_source: { kind: "none" },
          routing_decision: "local_heuristics",
          schema_ok: false,
          degraded_reason: "schema_invalid"
        }),
        clock: () => "2026-05-05T00:00:00.000Z"
      })
    );

    const result = await bridge.dispatch(["doctor", "--json"]);
    expect(result.exitCode).not.toBe(0);
    expect(result.json).toMatchObject({
      garden: { schema_ok: false },
      garden_compute: { schema_ok: false, degraded_reason: "schema_invalid" },
      checks: { garden: "fail" }
    });
  });
});

describe("doctor storage access errors", () => {
  it("maps EACCES to exists true and readable false", async () => {
    mockedAccess.mockRejectedValueOnce(Object.assign(new Error("denied"), { code: "EACCES" }));

    await expect(inspectStorage("/var/lib/alaya/alaya.db")).resolves.toMatchObject({
      exists: true,
      readable: false,
      writable: false,
      error_code: "EACCES"
    });
  });
});
