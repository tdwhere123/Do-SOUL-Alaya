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
  it("reports recall path plasticity lookup count and p99 in JSON and human output", async () => {
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
      getPathPlasticityLookupTelemetry: () => ({
        lookup_count: 5,
        sample_count: 4,
        duration_p99_ms: 17,
        window_size: 128
      }),
      clock: () => "2026-05-05T00:00:00.000Z"
    }));

    const jsonResult = await bridge.dispatch(["doctor", "--workspace", "workspace-1", "--json"]);
    const humanResult = await bridge.dispatch(["doctor", "--workspace", "workspace-1"]);

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
    expect(stdoutChunks.join("")).toContain(
      "recall path plasticity lookup: count=5 p99_ms=17 samples=4 window=128"
    );
  });

  it("reports Garden compute provider truth (C2) — kind / routing / model / cred", async () => {
    const daemon = {
      startupSteps: STARTUP_STEPS.map((step) => ({
        step,
        completedAt: "2026-05-07T00:00:00.000Z"
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
      getMcpHealth: async () => ({ transport: "ready", enrolled_tools: 9 }),
      getGardenHealth: async () => ({
        status: "healthy",
        last_pass_at: "2026-05-07T00:00:00.000Z"
      }),
      getGardenCompute: async () => ({
        provider_kind: "official_api",
        model_id: "gpt-4.1-mini",
        provider_url: null,
        credential_source: { kind: "env", name: "ALAYA_OFFICIAL_GARDEN_API_KEY" },
        routing_decision: "official_api"
      }),
      clock: () => "2026-05-07T00:00:00.000Z"
    }));

    const jsonResult = await bridge.dispatch(["doctor", "--workspace", "workspace-1", "--json"]);
    const humanResult = await bridge.dispatch(["doctor", "--workspace", "workspace-1"]);

    expect(jsonResult.json).toMatchObject({
      garden_compute: {
        provider_kind: "official_api",
        model_id: "gpt-4.1-mini",
        credential_source: { kind: "env", name: "ALAYA_OFFICIAL_GARDEN_API_KEY" },
        routing_decision: "official_api"
      }
    });
    expect(humanResult.exitCode).toBe(75);
    expect(stdoutChunks.join("")).toContain(
      "garden compute: kind=official_api routing=official_api model=gpt-4.1-mini cred=env:ALAYA_OFFICIAL_GARDEN_API_KEY"
    );
  });

  it("reports a clean local_heuristics + none state when Garden is unconfigured (C2)", async () => {
    const daemon = {
      startupSteps: STARTUP_STEPS.map((step) => ({
        step,
        completedAt: "2026-05-07T00:00:00.000Z"
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
      getMcpHealth: async () => ({ transport: "ready", enrolled_tools: 9 }),
      getGardenCompute: async () => ({
        provider_kind: "local_heuristics",
        model_id: null,
        provider_url: null,
        credential_source: { kind: "none" },
        routing_decision: "local_heuristics"
      }),
      clock: () => "2026-05-07T00:00:00.000Z"
    }));

    const humanResult = await bridge.dispatch(["doctor"]);
    expect(humanResult.exitCode).toBe(75);
    expect(stdoutChunks.join("")).toContain(
      "garden compute: kind=local_heuristics routing=local_heuristics model=default cred=none"
    );
  });
});
