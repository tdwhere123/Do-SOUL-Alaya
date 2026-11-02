import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import { createAlayaCliBridge } from "../../cli/bridge.js";

import { createDoctorCommand } from "../../cli/doctor/doctor.js";

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

  it("reports degraded graph health when graph and path evidence are sparse", async () => {
    const harness = createDoctorHarness({
      getGraphHealth: async (workspaceId) => ({
        workspace_id: workspaceId,
        status: "degraded",
        path_relations_total: 0,
        path_relations_by_kind: {},
        latest_path_event_at: null,
        warnings: ["path_relations_empty"],
        hint: "Path evidence is sparse; this is expected for a new install or workspace before recall/report and Garden path activity."
      })
    });

    const jsonResult = await harness.bridge.dispatch(["doctor", "--workspace", "workspace-1", "--json"]);
    const humanResult = await harness.bridge.dispatch(["doctor", "--workspace", "workspace-1"]);

    expect(jsonResult.json).toMatchObject({
      graph_health: {
        workspace_id: "workspace-1",
        status: "degraded",
        path_relations_total: 0,
        latest_path_event_at: null,
        warnings: ["path_relations_empty"]
      }
    });
    expect(humanResult.exitCode).toBe(75);
    expect(harness.stdoutText()).toContain(
      "graph health: degraded path_relations=0 latest_path_event=none"
    );
    expect(harness.stdoutText()).toContain(
      "graph health warnings: path_relations_empty"
    );
  });

  it("reports healthy graph health counts and recent path event", async () => {
    const harness = createDoctorHarness({
      getGraphHealth: async (workspaceId) => ({
        workspace_id: workspaceId,
        status: "healthy",
        path_relations_total: 4,
        path_relations_by_kind: {
          supports: 1,
          recalls: 2,
          co_recalled: 1
        },
        latest_path_event_at: "2026-05-12T00:00:00.000Z",
        warnings: [],
        hint: null
      })
    });

    const jsonResult = await harness.bridge.dispatch(["doctor", "--workspace", "workspace-1", "--json"]);
    const humanResult = await harness.bridge.dispatch(["doctor", "--workspace", "workspace-1"]);

    expect(jsonResult.json).toMatchObject({
      graph_health: {
        workspace_id: "workspace-1",
        status: "healthy",
        path_relations_total: 4,
        path_relations_by_kind: {
          supports: 1,
          recalls: 2
        },
        latest_path_event_at: "2026-05-12T00:00:00.000Z",
        warnings: []
      }
    });
    expect(humanResult.exitCode).toBe(75);
    expect(harness.stdoutText()).toContain(
      "graph health: healthy path_relations=4 latest_path_event=2026-05-12T00:00:00.000Z"
    );
    expect(harness.stdoutText()).not.toContain("graph health warnings:");
  });

  it("reports Garden compute provider truth — kind / routing / model / cred", async () => {
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

  it("reports a clean local_heuristics + none state when Garden is unconfigured", async () => {
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

  it("fails garden and names the cause when statement sessions failed or captured tails were never closed", async () => {
    const capture = (failed: number, overdue: number) => ({
      host_session: { captured_messages: 9, excerpt_messages: 1, last_captured_at: "2026-11-02T10:00:00.000Z",
        unbound_messages: overdue, overdue_unbound_messages: overdue },
      statement_sessions: { recent_window: 50, failed, latest_error: failed === 0 ? null : "provider_failure" },
      legacy_post_turn_unprocessed: 2
    });
    for (const [failed, overdue] of [[3, 0], [0, 1]] as const) {
      const harness = createDoctorHarness({
        getGardenCompute: async () => ({
          provider_kind: "local_heuristics", model_id: null, provider_url: null,
          credential_source: { kind: "none" }, routing_decision: "local_heuristics", capture: capture(failed, overdue)
        })
      });
      const jsonResult = await harness.bridge.dispatch(["doctor", "--json"]);
      expect(jsonResult.json).toMatchObject({ checks: { garden: "fail" }, garden_compute: { capture: capture(failed, overdue) } });
      expect((await harness.bridge.dispatch(["doctor"])).exitCode).toBe(75);
      expect(harness.stdoutText()).toContain(
        `host session capture: messages=9 excerpt=1 unbound=${overdue} overdue_unbound=${overdue} last=2026-11-02T10:00:00.000Z`);
      expect(harness.stdoutText()).toContain(failed === 0
        ? "statement sessions: 0 failed of the last 50\n"
        : "statement sessions: 3 failed of the last 50 (latest: provider_failure)");
      expect(harness.stdoutText()).toContain("legacy post-turn captures without statements: 2");
    }
  });

  it("says when no host session was ever captured without failing garden", async () => {
    const harness = createDoctorHarness({
      getGardenCompute: async () => ({
        provider_kind: "local_heuristics", model_id: null, provider_url: null,
        credential_source: { kind: "none" }, routing_decision: "local_heuristics",
        capture: {
          host_session: { captured_messages: 0, excerpt_messages: 0, last_captured_at: null,
            unbound_messages: 0, overdue_unbound_messages: 0 },
          statement_sessions: { recent_window: 50, failed: 0, latest_error: null },
          legacy_post_turn_unprocessed: 0
        }
      })
    });
    await harness.bridge.dispatch(["doctor"]);
    expect(harness.stdoutText()).toContain(
      "host session capture: none — the host must call soul.capture_host_session (report_context_usage no longer captures)");
    expect(harness.stdoutText()).not.toContain("legacy post-turn");
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
});
