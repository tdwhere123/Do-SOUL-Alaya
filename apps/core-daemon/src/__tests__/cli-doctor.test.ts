import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
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

  it("reports a successful Garden keychain check only when a keychain ref is configured", async () => {
    const harness = createDoctorHarness({
      getGardenCompute: async () => ({
        provider_kind: "official_api",
        model_id: "gpt-4.1-mini",
        provider_url: null,
        credential_source: { kind: "keychain", service: "alaya-garden", account: "openai" },
        routing_decision: "official_api",
        keychain_check: {
          ok: true,
          service: "alaya-garden",
          account: "openai"
        }
      })
    });

    const jsonResult = await harness.bridge.dispatch(["doctor", "--workspace", "workspace-1", "--json"]);
    const humanResult = await harness.bridge.dispatch(["doctor", "--workspace", "workspace-1"]);

    expect(jsonResult.exitCode).toBe(75);
    expect(jsonResult.json).toMatchObject({
      checks: { garden: "pass" },
      garden_compute: {
        credential_source: { kind: "keychain", service: "alaya-garden", account: "openai" },
        keychain_check: { ok: true, service: "alaya-garden", account: "openai" }
      }
    });
    expect(humanResult.exitCode).toBe(75);
    expect(harness.stdoutText()).toContain("garden keychain: ok (keychain:alaya-garden:openai)");
  });

  it("degrades Garden when the configured keychain entry is missing without leaking a secret", async () => {
    const harness = createDoctorHarness({
      getGardenCompute: async () => ({
        provider_kind: "official_api",
        model_id: "gpt-4.1-mini",
        provider_url: null,
        credential_source: { kind: "keychain", service: "alaya-garden", account: "openai" },
        routing_decision: "local_heuristics",
        keychain_check: {
          ok: false,
          service: "alaya-garden",
          account: "openai",
          error_kind: "keychain_entry_not_found",
          remediation: "Populate keychain service alaya-garden account openai."
        }
      })
    });

    const jsonResult = await harness.bridge.dispatch(["doctor", "--workspace", "workspace-1", "--json"]);
    const humanResult = await harness.bridge.dispatch(["doctor", "--workspace", "workspace-1"]);
    const serialized = JSON.stringify(jsonResult.json);

    expect(jsonResult.exitCode).toBe(75);
    expect(jsonResult.json).toMatchObject({
      overall: "degraded",
      checks: { garden: "fail" },
      garden_compute: {
        keychain_check: {
          ok: false,
          service: "alaya-garden",
          account: "openai",
          error_kind: "keychain_entry_not_found"
        }
      }
    });
    expect(serialized).toContain("alaya-garden");
    expect(serialized).toContain("openai");
    expect(serialized).not.toContain("sk-test-secret");
    expect(humanResult.exitCode).toBe(75);
    expect(harness.stdoutText()).toContain(
      "garden keychain: unavailable (keychain:alaya-garden:openai) — Populate keychain service alaya-garden account openai."
    );
  });

  it("degrades Garden when keychain tooling is unavailable and names the prerequisite", async () => {
    const harness = createDoctorHarness({
      getGardenCompute: async () => ({
        provider_kind: "official_api",
        model_id: "gpt-4.1-mini",
        provider_url: null,
        credential_source: { kind: "keychain", service: "alaya-garden", account: "openai" },
        routing_decision: "local_heuristics",
        keychain_check: {
          ok: false,
          service: "alaya-garden",
          account: "openai",
          error_kind: "keychain_tooling_unavailable",
          remediation: "secret-tool was not found on PATH; install the libsecret-tools package."
        }
      })
    });

    const jsonResult = await harness.bridge.dispatch(["doctor", "--workspace", "workspace-1", "--json"]);

    expect(jsonResult.exitCode).toBe(75);
    expect(jsonResult.json).toMatchObject({
      checks: { garden: "fail" },
      garden_compute: {
        keychain_check: {
          ok: false,
          error_kind: "keychain_tooling_unavailable",
          remediation: "secret-tool was not found on PATH; install the libsecret-tools package."
        }
      }
    });
  });

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
      template_ids: ["workspace.bootstrap.conservative-start"] as const
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
        active_relation_count: 3
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

    expect(jsonResult.json).toMatchObject({
      bootstrap_reconcile: { status: "failed", reason: "planner_unavailable" }
    });
  });

  it("rejects --reconcile-bootstrap when passed twice", async () => {
    const harness = createDoctorHarness({});

    const result = await harness.bridge.dispatch([
      "doctor",
      "--reconcile-bootstrap",
      "--reconcile-bootstrap"
    ]);

    expect(result.exitCode).not.toBe(0);
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
