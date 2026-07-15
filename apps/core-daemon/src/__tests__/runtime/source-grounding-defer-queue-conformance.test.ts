import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createInMemorySourceGroundingDeferQueue,
  type SourceGroundingDeferQueueStatePort
} from "@do-soul/alaya-core";
import {
  SqliteSourceGroundingDeferQueueRepo,
  initDatabase
} from "@do-soul/alaya-storage";

describe.each(["in-memory", "sqlite"] as const)("source-grounding queue conformance: %s", (kind) => {
  it("keeps active claims private and promotes overflow only after capacity recovers", () => {
    const harness = createHarness(kind, 1);
    try {
      const queue = harness.queue;
      queue.enqueue(entry("signal-active"));
      expect(queue.claim(
        "workspace-1",
        "signal-active",
        "raw-active-claim",
        fingerprint("raw-active-claim"),
        "2026-07-16T01:00:00.000Z"
      )).not.toBeNull();

      expect(queue.get("workspace-1", "signal-active")).toMatchObject({
        claim_token_fingerprint: fingerprint("raw-active-claim")
      });
      expect(queue.get("workspace-1", "signal-active")).not.toHaveProperty("claim_token");
      expect(queue.ownsClaim("workspace-1", "signal-active", "raw-active-claim")).toBe(true);

      queue.enqueue(entry("signal-overflow"));
      expect(queue.get("workspace-1", "signal-overflow")?.admission_state).toBe(
        "capacity_blocked"
      );
      expect(queue.stats("workspace-1")).toMatchObject({
        queue_depth: 2,
        claimable_depth: 0,
        capacity_blocked_depth: 1,
        capacity_state: "saturated"
      });
      expect(queue.claim(
        "workspace-1",
        "signal-overflow",
        "raw-early-claim",
        fingerprint("raw-early-claim"),
        "2026-07-16T02:00:00.000Z"
      )).toBeNull();

      expect(queue.removeClaimed(
        "workspace-1",
        "signal-active",
        "raw-active-claim"
      )).toBe(true);
      expect(queue.get("workspace-1", "signal-overflow")?.admission_state).toBe("ready");
      expect(queue.stats("workspace-1")).toMatchObject({
        queue_depth: 1,
        claimable_depth: 1,
        capacity_blocked_depth: 0,
        capacity_state: "ready"
      });
    } finally {
      harness.close();
    }
  });

  it("uses workspace FIFO order with signal id as the stable tie-breaker", () => {
    const harness = createHarness(kind, 2);
    try {
      const queue = harness.queue;
      queue.enqueue(entry("signal-b", "workspace-1", "2026-07-16T00:00:00.000Z"));
      queue.enqueue(entry("signal-a", "workspace-1", "2026-07-16T00:00:00.000Z"));
      const result = queue.enqueue(
        entry("signal-c", "workspace-1", "2026-07-16T00:00:01.000Z")
      );

      expect(result.evicted?.signal_id).toBe("signal-a");
      expect(queue.list("workspace-1").map((item) => item.signal_id)).toEqual([
        "signal-b",
        "signal-c"
      ]);
    } finally {
      harness.close();
    }
  });

  it("bounds continuous claimed overflow to cap plus one", () => {
    const harness = createHarness(kind, 1);
    try {
      const queue = harness.queue;
      queue.enqueue(entry("signal-active"));
      queue.claim(
        "workspace-1",
        "signal-active",
        "raw-active-claim",
        fingerprint("raw-active-claim"),
        "2026-07-16T01:00:00.000Z"
      );

      for (let index = 1; index <= 16; index += 1) {
        const signalId = `signal-overflow-${index}`;
        queue.enqueue(entry(signalId, "workspace-1", `2026-07-16T02:00:${pad(index)}.000Z`));
        expect(queue.list("workspace-1")).toHaveLength(2);
        expect(queue.get("workspace-1", signalId)?.admission_state).toBe("capacity_blocked");
      }
      expect(queue.stats("workspace-1").queue_depth).toBeLessThanOrEqual(2);
    } finally {
      harness.close();
    }
  });

  it("keeps lifetime reason counts after eviction and replacement", () => {
    const harness = createHarness(kind, 1);
    try {
      const queue = harness.queue;
      queue.enqueue(entry("signal-1", "workspace-1", undefined, "source_assertion_incomplete"));
      queue.enqueue(entry("signal-2", "workspace-1", undefined, "source_assertion_too_long"));
      queue.enqueue(entry("signal-2", "workspace-1", undefined, "source_assertion_too_long"));

      expect(queue.stats("workspace-1").deferred_by_reason).toEqual({
        source_assertion_incomplete: 1,
        source_assertion_too_long: 2
      });
    } finally {
      harness.close();
    }
  });

  it("isolates cap, FIFO, and stats between workspaces", () => {
    const harness = createHarness(kind, 1);
    try {
      const queue = harness.queue;
      queue.enqueue(entry("workspace-1-old", "workspace-1"));
      queue.enqueue(entry("workspace-2-only", "workspace-2"));
      queue.enqueue(entry("workspace-1-new", "workspace-1", "2026-07-16T00:01:00.000Z"));

      expect(queue.list("workspace-1").map((item) => item.signal_id)).toEqual([
        "workspace-1-new"
      ]);
      expect(queue.list("workspace-2").map((item) => item.signal_id)).toEqual([
        "workspace-2-only"
      ]);
      expect(queue.stats("workspace-1").queue_depth).toBe(1);
      expect(queue.stats("workspace-2").queue_depth).toBe(1);
    } finally {
      harness.close();
    }
  });
});

function createHarness(kind: "in-memory" | "sqlite", cap: number): {
  readonly queue: SourceGroundingDeferQueueStatePort;
  readonly close: () => void;
} {
  if (kind === "in-memory") {
    return {
      queue: createInMemorySourceGroundingDeferQueue(cap),
      close: () => undefined
    };
  }
  const database = initDatabase({ filename: ":memory:" });
  const insertWorkspace = database.connection.prepare(`
    INSERT INTO workspaces (
      workspace_id, name, root_path, workspace_kind,
      workspace_state, created_at, default_engine_class
    ) VALUES (?, ?, ?, 'local_repo', 'active', '2026-07-16T00:00:00.000Z', NULL)
  `);
  for (const workspaceId of ["workspace-1", "workspace-2"]) {
    insertWorkspace.run(workspaceId, workspaceId, `/tmp/${workspaceId}`);
  }
  return {
    queue: new SqliteSourceGroundingDeferQueueRepo(database, cap),
    close: () => database.close()
  };
}

function entry(
  signalId: string,
  workspaceId = "workspace-1",
  enqueuedAt = "2026-07-16T00:00:00.000Z",
  reason: "source_assertion_incomplete" | "source_assertion_too_long" =
    "source_assertion_incomplete"
) {
  return {
    signal_id: signalId,
    workspace_id: workspaceId,
    run_id: "run-1",
    defer_reason: reason,
    enqueued_at: enqueuedAt
  };
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function fingerprint(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}
