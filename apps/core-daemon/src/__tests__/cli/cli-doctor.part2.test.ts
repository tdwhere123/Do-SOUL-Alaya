import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import { createAlayaCliBridge } from "../../cli/bridge.js";

import { createDoctorCommand } from "../../cli/doctor.js";

const STARTUP_STEPS = [
  "database",
  "repositories",
  "core-services",
  "garden-runtime",
  "mcp-tooling",
  "http-app"
] as const;

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

describe("doctor CLI", () => {

  it("renders the malformed keychain branch as keychain:<malformed> instead of an empty pair", async () => {
    const harness = createDoctorHarness({
      getGardenCompute: async () => ({
        provider_kind: "official_api",
        model_id: "gpt-4.1-mini",
        provider_url: null,
        credential_source: { kind: "none" },
        routing_decision: "local_heuristics",
        keychain_check: {
          ok: false,
          service: "",
          account: "",
          error_kind: "malformed",
          remediation:
            "Keychain secret_ref must match keychain:<service>:<account> with each segment limited to [A-Za-z0-9._-]+."
        }
      })
    });

    const humanResult = await harness.bridge.dispatch(["doctor", "--workspace", "workspace-1"]);

    expect(humanResult.exitCode).toBe(75);
    expect(harness.stdoutText()).toContain("garden keychain: unavailable (keychain:<malformed>) —");
    expect(harness.stdoutText()).not.toContain("keychain::");
  });

  it("keeps non-keychain Garden compute reports free of keychain_check", async () => {
    const harness = createDoctorHarness({
      getGardenCompute: async () => ({
        provider_kind: "official_api",
        model_id: "gpt-4.1-mini",
        provider_url: null,
        credential_source: { kind: "env", name: "ALAYA_OFFICIAL_GARDEN_API_KEY" },
        routing_decision: "official_api"
      })
    });

    const jsonResult = await harness.bridge.dispatch(["doctor", "--workspace", "workspace-1", "--json"]);
    expect(jsonResult.exitCode).toBe(75);
    expect((jsonResult.json as { garden_compute: Record<string, unknown> }).garden_compute).not.toHaveProperty(
      "keychain_check"
    );
  });

  it("does not fail the provider check when embedding is disabled and keyword-only", async () => {
    const harness = createDoctorHarness({
      getEmbeddingStatus: async (workspaceId) => ({
        workspace_id: workspaceId,
        embedding_enabled: false,
        provider_configured: false,
        model_id: null,
        storage_available: true,
        effective_mode: "keyword_only",
        degraded_reason: null,
        checked_at: "2026-05-05T00:00:00.000Z"
      })
    });

    const jsonResult = await harness.bridge.dispatch(["doctor", "--workspace", "workspace-1", "--json"]);

    expect(jsonResult.json).toMatchObject({
      checks: {
        provider: "pass"
      },
      provider: {
        configured: false
      }
    });
  });

  it("invokes reconcileBootstrapPaths only when --reconcile-bootstrap is passed", async () => {
    const reconcile = vi.fn(async (workspaceId: string) => ({
      status: "planted" as const,
      workspace_id: workspaceId,
      paths_planted: 1,
      record_id: "bootstrap-record-1",
      template_ids: ["workspace.bootstrap.explicit-test"] as const
    }));
    const harness = createDoctorHarness({
      reconcileBootstrapPaths: reconcile
    });

    await harness.bridge.dispatch(["doctor", "--workspace", "workspace-1"]);
    expect(reconcile).not.toHaveBeenCalled();

    const jsonResult = await harness.bridge.dispatch([
      "doctor",
      "--workspace",
      "workspace-1",
      "--reconcile-bootstrap",
      "--json"
    ]);

    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(reconcile).toHaveBeenCalledWith("workspace-1");
    expect(jsonResult.json).toMatchObject({
      bootstrap_reconcile: {
        status: "planted",
        paths_planted: 1,
        record_id: "bootstrap-record-1"
      }
    });
  });

  it("renders bootstrap_reconcile in the human summary when --reconcile-bootstrap is passed", async () => {
    const harness = createDoctorHarness({
      reconcileBootstrapPaths: async () => ({
        status: "already_planted" as const,
        workspace_id: "workspace-1",
        record_id: "bootstrap-record-1",
        relation_count: 3
      })
    });

    await harness.bridge.dispatch([
      "doctor",
      "--workspace",
      "workspace-1",
      "--reconcile-bootstrap"
    ]);

    expect(harness.stdoutText()).toContain(
      "bootstrap reconcile: already planted (record=bootstrap-record-1, relations=3)"
    );
  });

  it("parses --reconcile-bootstrap before --workspace in any order", async () => {
    const reconcile = vi.fn(async (workspaceId: string) => ({
      status: "planted" as const,
      workspace_id: workspaceId,
      paths_planted: 1,
      record_id: "rec-1",
      template_ids: ["t1"] as const
    }));
    const harness = createDoctorHarness({ reconcileBootstrapPaths: reconcile });

    const reversed = await harness.bridge.dispatch([
      "doctor",
      "--reconcile-bootstrap",
      "--workspace",
      "workspace-1",
      "--json"
    ]);

    expect(reconcile).toHaveBeenCalledWith("workspace-1");
    expect(reversed.json).toMatchObject({
      bootstrap_reconcile: { status: "planted" }
    });
  });

  it("rejects --workspace followed by another flag (instead of swallowing it as id)", async () => {
    const reconcile = vi.fn();
    const harness = createDoctorHarness({ reconcileBootstrapPaths: reconcile });

    const result = await harness.bridge.dispatch([
      "doctor",
      "--workspace",
      "--reconcile-bootstrap"
    ]);

    expect(result.exitCode).toBe(64);
    expect(reconcile).not.toHaveBeenCalled();
  });

  it("reports skipped_no_handler when --reconcile-bootstrap runs without a handler wired", async () => {
    const harness = createDoctorHarness({});

    const jsonResult = await harness.bridge.dispatch([
      "doctor",
      "--workspace",
      "workspace-1",
      "--reconcile-bootstrap",
      "--json"
    ]);

    expect(jsonResult.json).toMatchObject({
      bootstrap_reconcile: { status: "skipped_no_handler" }
    });
  });

  it("reports skipped_no_templates without degrading bootstrap reconcile", async () => {
    const harness = createDoctorHarness({
      reconcileBootstrapPaths: async () => ({
        status: "skipped_no_templates" as const,
        workspace_id: "workspace-1",
        template_ids: []
      })
    });

    const jsonResult = await harness.bridge.dispatch([
      "doctor",
      "--workspace",
      "workspace-1",
      "--reconcile-bootstrap",
      "--json"
    ]);
    const humanResult = await harness.bridge.dispatch([
      "doctor",
      "--workspace",
      "workspace-1",
      "--reconcile-bootstrap"
    ]);

    expect(jsonResult.json).toMatchObject({
      bootstrap_reconcile: {
        status: "skipped_no_templates",
        template_ids: []
      },
      checks: { bootstrap_reconcile: "pass" }
    });
    expect(humanResult.exitCode).toBe(75);
    expect(harness.stdoutText()).toContain(
      "bootstrap reconcile: skipped - no configured bootstrap templates"
    );
  });

  it("surfaces handler errors as a failed reconcile summary instead of throwing", async () => {
    const harness = createDoctorHarness({
      reconcileBootstrapPaths: async () => {
        throw new Error("planner_unavailable");
      }
    });

    const jsonResult = await harness.bridge.dispatch([
      "doctor",
      "--workspace",
      "workspace-1",
      "--reconcile-bootstrap",
      "--json"
    ]);

    expect(jsonResult.exitCode).toBe(75);
    expect(jsonResult.json).toMatchObject({
      overall: "degraded",
      bootstrap_reconcile: { status: "failed", reason: "planner_unavailable" },
      checks: { bootstrap_reconcile: "fail" }
    });
  });

  it("marks doctor degraded when explicit bootstrap reconcile finds corrupt partial state", async () => {
    const harness = createDoctorHarness({
      reconcileBootstrapPaths: async () => ({
        status: "corrupt_partial" as const,
        workspace_id: "workspace-1",
        record_id: "bootstrap-record-1",
        relation_count: 0,
        reason: "bootstrapping_record_without_relations" as const
      })
    });

    const jsonResult = await harness.bridge.dispatch([
      "doctor",
      "--workspace",
      "workspace-1",
      "--reconcile-bootstrap",
      "--json"
    ]);

    expect(jsonResult.exitCode).toBe(75);
    expect(jsonResult.json).toMatchObject({
      overall: "degraded",
      bootstrap_reconcile: {
        status: "corrupt_partial",
        record_id: "bootstrap-record-1",
        relation_count: 0
      },
      checks: { bootstrap_reconcile: "fail" }
    });
  });

  it("rejects --reconcile-bootstrap when passed twice with USAGE exit code", async () => {
    const harness = createDoctorHarness({});

    const result = await harness.bridge.dispatch([
      "doctor",
      "--reconcile-bootstrap",
      "--reconcile-bootstrap"
    ]);

    expect(result.exitCode).toBe(64);
  });

  it("fails the provider check when embedding status is degraded", async () => {
    const harness = createDoctorHarness({
      getEmbeddingStatus: async (workspaceId) => ({
        workspace_id: workspaceId,
        embedding_enabled: true,
        provider_configured: false,
        model_id: "text-embedding-3-small",
        storage_available: true,
        effective_mode: "degraded",
        degraded_reason: "provider_unconfigured",
        checked_at: "2026-05-05T00:00:00.000Z"
      })
    });

    const jsonResult = await harness.bridge.dispatch(["doctor", "--workspace", "workspace-1", "--json"]);

    expect(jsonResult.json).toMatchObject({
      overall: "degraded",
      checks: {
        provider: "fail"
      }
    });
  });

  it("reports build_info in JSON and human output when provided", async () => {
    const harness = createDoctorHarness({
      getBuildInfo: () => ({
        version: "0.3.4",
        git_head: "abcdef1234567890",
        built_at: "2026-05-14T03:00:00.000Z"
      })
    });

    const jsonResult = await harness.bridge.dispatch(["doctor", "--workspace", "workspace-1", "--json"]);
    const humanResult = await harness.bridge.dispatch(["doctor", "--workspace", "workspace-1"]);

    expect(jsonResult.json).toMatchObject({
      build_info: {
        version: "0.3.4",
        git_head: "abcdef1234567890",
        built_at: "2026-05-14T03:00:00.000Z"
      }
    });
    expect(humanResult.exitCode).toBe(75);
    expect(harness.stdoutText()).toContain(
      "version: 0.3.4 git_head: abcdef1 built_at: 2026-05-14T03:00:00.000Z"
    );
  });
});
