import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  createAlayaCliBridge,
  type AlayaCliDaemonRuntime
} from "../../cli/bridge.js";
import { createStatusCommand } from "../../cli/status.js";

describe("status source-grounding defer semantics", () => {
  it("labels aggregate depth and per-workspace cap without implying a total cap", async () => {
    const stdout = createTextSink();
    const bridge = createAlayaCliBridge(
      { startupSteps: STARTUP_STEPS.map((step) => ({ step })) } as unknown as AlayaCliDaemonRuntime,
      { stdout: stdout.stream, stderr: new PassThrough(), isTTY: false }
    );
    bridge.registerSubcommand(createStatusCommand({
      trustStateSummaryProvider: async (agentTarget) => ({
        agent_target: agentTarget,
        state: "installed",
        installed_count: 1,
        configured_count: 1,
        delivered_count: 0,
        used_count: 0,
        skipped_count: 0,
        not_applicable_count: 0,
        unverifiable_count: 0,
        last_evidence_at: null,
        last_delivery_at: null,
        last_usage_report_at: null
      }),
      resolveAgentTargets: () => ["codex"],
      getSourceGroundingDeferStats: () => ({
        queue_depth: 4_096,
        queue_cap: 2_048,
        queue_cap_per_workspace: 2_048,
        queue_hard_limit_per_workspace: 2_049,
        queue_scope: "aggregate",
        claimable_depth: 4_094,
        capacity_blocked_depth: 2,
        capacity_state: "saturated",
        deferred_by_reason: {
          source_assertion_incomplete: 4_096,
          secret_reason: 11
        },
        private_stats: "status-stats-secret"
      }),
      recallUtilizationService: { getStats: vi.fn() } as never,
      clock: () => "2026-07-15T00:00:00.000Z"
    }));

    const result = await bridge.dispatch(["status"]);

    expect(stdout.readText()).toContain(
      "queue_total=4096 cap_per_workspace=2048 hard_limit_per_workspace=2049 blocked_total=2 capacity=saturated scope=aggregate"
    );
    expect(result.json).toMatchObject({
      garden: {
        source_grounding_defers: {
          queue_depth: 4_096,
          queue_cap: 2_048,
          queue_cap_per_workspace: 2_048,
          queue_hard_limit_per_workspace: 2_049,
          claimable_depth: 4_094,
          capacity_blocked_depth: 2,
          capacity_state: "saturated",
          queue_scope: "aggregate"
        }
      }
    });
    expect(stdout.readText()).not.toContain("secret_reason");
    expect(stdout.readText()).not.toContain("status-stats-secret");
    expect(JSON.stringify(result.json)).not.toContain("secret_reason");
    expect(JSON.stringify(result.json)).not.toContain("status-stats-secret");
  });
});

const STARTUP_STEPS = [
  "database",
  "repositories",
  "core-services",
  "garden-runtime",
  "mcp-tooling",
  "http-app"
] as const;

function createTextSink() {
  const stream = new PassThrough();
  let content = "";
  stream.on("data", (chunk) => {
    content += chunk.toString("utf8");
  });
  return { stream, readText: () => content };
}
