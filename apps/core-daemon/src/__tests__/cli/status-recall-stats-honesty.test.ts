import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  createAlayaCliBridge,
  type AlayaCliDaemonRuntime
} from "../../cli/bridge.js";
import { createStatusCommand } from "../../cli/status.js";
import type { RecallUtilizationStats } from "../../services/status/recall-utilization-service.js";

const EMPTY_LATENCY_STATS: RecallUtilizationStats = {
  window: {
    workspace_id: "ws1",
    since: "2026-07-29T00:00:00.000Z",
    until: "2026-07-30T00:00:00.000Z",
    excluded_agent_targets: ["cli", "inspector", "tools-cli"]
  },
  recall: {
    total: 0,
    unique_sessions: 0,
    unique_runs: 0,
    null_run: 0,
    miss_count: 0,
    miss_ratio: 0,
    p50_pointer_count: 0,
    p50_latency_ms: null,
    p95_latency_ms: null,
    p99_latency_ms: null
  },
  embedding: {
    total_queries: 0,
    returned_candidate_count: 0,
    p50_latency_ms: null,
    p95_latency_ms: null,
    p99_latency_ms: null,
    latency_buckets: [
      { label: "<=150ms", count: 0 },
      { label: "<=300ms", count: 0 },
      { label: "<=800ms", count: 0 },
      { label: "<=1100ms", count: 0 },
      { label: ">1100ms", count: 0 }
    ]
  },
  usage: {
    total: 0,
    used: 0,
    skipped: 0,
    not_applicable: 0,
    used_ratio: 0,
    follow_through_ratio: 0
  }
};

describe("status recall-stats latency honesty", () => {
  it("prints n/a for null latency percentiles instead of inventing zero", async () => {
    const stdout = createTextSink();
    const getStats = vi.fn().mockResolvedValue(EMPTY_LATENCY_STATS);
    const bridge = createAlayaCliBridge(
      { startupSteps: STARTUP_STEPS.map((step) => ({ step })) } as unknown as AlayaCliDaemonRuntime,
      { stdout: stdout.stream, stderr: new PassThrough(), isTTY: false }
    );
    bridge.registerSubcommand(
      createStatusCommand({
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
        recallUtilizationService: { getStats },
        clock: () => "2026-07-30T00:00:00.000Z"
      })
    );

    const result = await bridge.dispatch([
      "status",
      "--recall-stats",
      "--workspace",
      "ws1",
      "--since",
      "2026-07-29T00:00:00.000Z",
      "--until",
      "2026-07-30T00:00:00.000Z"
    ]);

    const text = stdout.readText();
    expect(text).toContain("p50_ms=n/a p95_ms=n/a p99_ms=n/a");
    expect(text).not.toMatch(/p50_ms=0\b/);
    expect(result.json).toMatchObject({
      recall_stats: {
        recall: {
          p50_latency_ms: null,
          p95_latency_ms: null,
          p99_latency_ms: null
        },
        embedding: {
          p50_latency_ms: null,
          p95_latency_ms: null,
          p99_latency_ms: null
        }
      }
    });
    expect(getStats).toHaveBeenCalledWith({
      workspaceId: "ws1",
      since: "2026-07-29T00:00:00.000Z",
      until: "2026-07-30T00:00:00.000Z"
    });
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
