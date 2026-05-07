import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { createAlayaCliBridge } from "../cli/bridge.js";
import { createDoctorCommand } from "../cli/doctor.js";

const STARTUP_STEPS = [
  "database",
  "repositories",
  "core-services",
  "garden-runtime",
  "mcp-tooling",
  "http-app"
] as const;

describe("doctor CLI", () => {
  it.each([
    ["env", "env"],
    ["file", "file"],
    ["embedding-fallback", "deprecated embedding-fallback"],
    ["none", "none"]
  ] as const)(
    "reports Garden credential provenance %s in JSON and human output",
    async (kind, humanLabel) => {
      const harness = createDoctorHarness({
        getGardenCredentialProvenance: async () => ({ kind }),
        getPathPlasticityLookupTelemetry: () => ({
          lookup_count: 0,
          sample_count: 0,
          duration_p99_ms: null,
          window_size: 128
        })
      });

      const jsonResult = await harness.bridge.dispatch(["doctor", "--workspace", "workspace-1", "--json"]);
      const humanResult = await harness.bridge.dispatch(["doctor", "--workspace", "workspace-1"]);

      expect(jsonResult.json).toMatchObject({
        garden: {
          credential_provenance: { kind }
        }
      });
      expect(humanResult.exitCode).toBe(75);
      expect(harness.stdoutText()).toContain(`garden credential provenance: ${humanLabel}`);
    }
  );

  it("reports recall path plasticity lookup count and p99 in JSON and human output", async () => {
    const harness = createDoctorHarness({
      getPathPlasticityLookupTelemetry: () => ({
        lookup_count: 5,
        sample_count: 4,
        duration_p99_ms: 17,
        window_size: 128
      })
    });

    const jsonResult = await harness.bridge.dispatch(["doctor", "--workspace", "workspace-1", "--json"]);
    const humanResult = await harness.bridge.dispatch(["doctor", "--workspace", "workspace-1"]);

    expect(jsonResult.json).toMatchObject({
      recall: {
        path_plasticity_lookup: {
          lookup_count: 5,
          sample_count: 4,
          duration_p99_ms: 17,
          window_size: 128
        }
      }
    });
    expect(humanResult.exitCode).toBe(75);
    expect(harness.stdoutText()).toContain(
      "recall path plasticity lookup: count=5 p99_ms=17 samples=4 window=128"
    );
  });
});

function createDoctorHarness(overrides: Partial<Parameters<typeof createDoctorCommand>[0]> = {}) {
  const daemon = {
    startupSteps: STARTUP_STEPS.map((step) => ({
      step,
      completedAt: "2026-05-05T00:00:00.000Z"
    }))
  };
  const stdout = new PassThrough();
  const stdoutChunks: string[] = [];
  stdout.on("data", (chunk) => stdoutChunks.push(chunk.toString("utf8")));
  const bridge = createAlayaCliBridge(daemon, {
    stdout,
    stderr: new PassThrough(),
    isTTY: false
  });
  bridge.registerSubcommand(createDoctorCommand({
    getToolchainStatus: async () => ({
      tools: {},
      active_worktrees: 1,
      db_path: "",
      files_dir: "/tmp/files"
    }),
    getEmbeddingStatus: async (workspaceId) => ({
      workspace_id: workspaceId,
      embedding_enabled: false,
      provider_configured: true,
      model_id: null,
      storage_available: true,
      effective_mode: "keyword_only",
      degraded_reason: null,
      checked_at: "2026-05-05T00:00:00.000Z"
    }),
    getMcpHealth: async () => ({ transport: "ready", enrolled_tools: 9 }),
    getGardenHealth: async () => ({
      status: "healthy",
      last_pass_at: "2026-05-05T00:00:00.000Z"
    }),
    clock: () => "2026-05-05T00:00:00.000Z",
    ...overrides
  }));

  return {
    bridge,
    stdoutText: () => stdoutChunks.join("")
  };
}
