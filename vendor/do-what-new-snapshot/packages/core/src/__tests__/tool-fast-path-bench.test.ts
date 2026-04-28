import { performance } from "node:perf_hooks";
import type { EventLogEntry, RuntimeSessionConfig, ToolExecutionRecord, ToolSpec } from "@do-what/protocol";
import { describe, expect, it } from "vitest";
import { ToolFastPath, ToolSubstrate } from "../index.js";

describe("ToolFastPath benchmark", () => {
  it("keeps p95 under 50ms with in-memory dependencies", async () => {
    let executionCounter = 0;
    let eventCounter = 0;

    const fastPath = new ToolFastPath({
      substrate: new ToolSubstrate({
        generateExecutionId: () => `exec-${++executionCounter}`,
        now: () => "2026-04-12T11:00:00.000Z"
      }),
      executionRecordRepo: {
        insert: async (record: ToolExecutionRecord) => record
      },
      eventLogRepo: {
        append: async (entry: Omit<EventLogEntry, "event_id" | "created_at">) => ({
          ...entry,
          event_id: `event-${++eventCounter}`,
          created_at: "2026-04-12T11:00:00.000Z"
        })
      },
      sseBroadcaster: {
        broadcastEntry: () => undefined
      },
      now: () => "2026-04-12T11:00:00.001Z"
    });

    const durations: number[] = [];

    for (let index = 0; index < 100; index += 1) {
      const start = performance.now();
      await fastPath.execute({
        toolSpec: createToolSpec(),
        rawInput: {},
        sessionConfig: createSessionConfig(),
        requestedBy: "principal",
        requestingRunId: "run-principal-1",
        handler: async () => ({ ok: true, index })
      });
      durations.push(performance.now() - start);
    }

    const sorted = [...durations].sort((left, right) => left - right);
    const p95 = sorted[Math.ceil(sorted.length * 0.95) - 1] ?? Number.POSITIVE_INFINITY;

    expect(durations).toHaveLength(100);
    expect(p95).toBeLessThan(50);
  });
});

function createToolSpec(): ToolSpec {
  return {
    tool_id: "tools.read_file",
    category: "read",
    description: "Read a file from the workspace.",
    scope_guard: "workspace",
    read_only: true,
    destructive: false,
    concurrency_safe: true,
    interrupt_behavior: "continue",
    requires_confirmation: false,
    requires_evidence_reopen: false,
    rollback_support: "none",
    fast_path_eligible: true
  };
}

function createSessionConfig(): RuntimeSessionConfig {
  return {
    role: "worker",
    workspace_id: "ws-fast-path",
    run_id: "principal-run-1",
    cwd: "/workspace/project",
    writable_roots: ["/workspace/project"],
    tool_profile: "default",
    allowed_mcp_servers: ["filesystem"],
    sandbox_policy: "workspace_write",
    permission_policy: "ask",
    network_policy: "enabled"
  };
}
