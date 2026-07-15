import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import type { SourceGroundingDeferReason } from "@do-soul/alaya-protocol";
import { initDatabase } from "../../../sqlite/db.js";
import { SqliteSourceGroundingDeferQueueRepo } from "../../../repos/garden/source-grounding-defer-queue-repo.js";

const databases = new Set<ReturnType<typeof initDatabase>>();

afterEach(() => {
  for (const database of databases) database.close();
  databases.clear();
});

describe("SqliteSourceGroundingDeferQueueRepo", () => {
  it("enforces cap, list, and stats independently per workspace", () => {
    const { repo } = createHarness(1);

    repo.enqueue(entry("workspace-a", "signal-a1", "source_assertion_incomplete"));
    repo.enqueue(entry("workspace-b", "signal-b1", "source_assertion_too_long"));
    const result = repo.enqueue(entry("workspace-a", "signal-a2", "source_assertion_incomplete"));

    expect(result.evicted?.signal_id).toBe("signal-a1");
    expect(repo.list("workspace-a").map((item) => item.signal_id)).toEqual(["signal-a2"]);
    expect(repo.list("workspace-b").map((item) => item.signal_id)).toEqual(["signal-b1"]);
    expect(repo.stats("workspace-a")).toMatchObject({
      queue_depth: 1,
      deferred_by_reason: { source_assertion_incomplete: 2 }
    });
    expect(repo.stats("workspace-b")).toMatchObject({
      queue_depth: 1,
      deferred_by_reason: { source_assertion_too_long: 1 }
    });
  });

  it("rolls back reason count and FIFO eviction when the final upsert fails", () => {
    const { database, repo } = createHarness(1);
    repo.enqueue(entry("workspace-a", "signal-a1", "source_assertion_incomplete"));
    database.connection.exec(`
      CREATE TRIGGER fail_source_grounding_enqueue
      BEFORE INSERT ON source_grounding_defer_queue
      WHEN NEW.signal_id = 'signal-fail'
      BEGIN
        SELECT RAISE(ABORT, 'injected enqueue failure');
      END;
    `);

    expect(() =>
      repo.enqueue(entry("workspace-a", "signal-fail", "source_assertion_not_self_contained"))
    ).toThrow("Failed to enqueue source grounding defer row");

    expect(repo.list("workspace-a").map((item) => item.signal_id)).toEqual(["signal-a1"]);
    expect(repo.stats("workspace-a").deferred_by_reason).toEqual({
      source_assertion_incomplete: 1
    });
  });

  it("never evicts an active claim and temporarily overflows when every slot is claimed", () => {
    const { repo } = createHarness(1);
    repo.enqueue(entry("workspace-a", "signal-active", "source_assertion_incomplete"));
    expect(repo.claim(
      "workspace-a",
      "signal-active",
      "claim-active",
      fingerprint("claim-active"),
      "2026-07-15T01:00:00.000Z"
    )).not.toBeNull();

    const result = repo.enqueue(entry("workspace-a", "signal-new", "source_assertion_too_long"));

    expect(result.evicted).toBeNull();
    expect(repo.list("workspace-a").map((item) => item.signal_id)).toEqual([
      "signal-active",
      "signal-new"
    ]);
    expect(repo.get("workspace-a", "signal-active")).toMatchObject({
      claim_token_fingerprint: fingerprint("claim-active")
    });
    expect(repo.get("workspace-a", "signal-active")).not.toHaveProperty("claim_token");
    expect(repo.get("workspace-a", "signal-new")?.admission_state).toBe("capacity_blocked");
    expect(repo.stats("workspace-a")).toMatchObject({
      queue_depth: 2,
      queue_hard_limit_per_workspace: 2,
      claimable_depth: 0,
      capacity_blocked_depth: 1,
      capacity_state: "saturated"
    });
  });

  it("bounds overflow and admits its row only after capacity recovers", () => {
    const { repo } = createHarness(1);
    repo.enqueue(entry("workspace-a", "signal-active", "source_assertion_incomplete"));
    expect(repo.claim(
      "workspace-a",
      "signal-active",
      "claim-active",
      fingerprint("claim-active"),
      "2026-07-15T01:00:00.000Z"
    )).not.toBeNull();

    repo.enqueue(entry("workspace-a", "signal-overflow-1", "source_assertion_too_long"));
    expect(repo.claim(
      "workspace-a",
      "signal-overflow-1",
      "overflow-claim",
      fingerprint("overflow-claim"),
      "2026-07-15T02:00:00.000Z"
    )).toBeNull();
    let previousOverflowSignalId = "signal-overflow-1";
    for (let index = 2; index <= 16; index += 1) {
      const nextOverflowSignalId = `signal-overflow-${index}`;
      const replacement = repo.enqueue(
        entry("workspace-a", nextOverflowSignalId, "source_assertion_too_long")
      );

      expect(replacement.evicted?.signal_id).toBe(previousOverflowSignalId);
      expect(repo.list("workspace-a")).toHaveLength(2);
      expect(repo.stats("workspace-a").queue_depth).toBeLessThanOrEqual(2);
      expect(repo.claim(
        "workspace-a",
        nextOverflowSignalId,
        "early-overflow-claim",
        fingerprint("early-overflow-claim"),
        "2026-07-15T02:00:00.000Z"
      )).toBeNull();
      previousOverflowSignalId = nextOverflowSignalId;
    }

    expect(repo.removeClaimed("workspace-a", "signal-active", "claim-active")).toBe(true);
    expect(repo.get("workspace-a", previousOverflowSignalId)?.admission_state).toBe("ready");
    expect(repo.stats("workspace-a")).toMatchObject({
      queue_depth: 1,
      claimable_depth: 1,
      capacity_blocked_depth: 0,
      capacity_state: "ready"
    });
    expect(repo.claim(
      "workspace-a",
      previousOverflowSignalId,
      "recovered-overflow-claim",
      fingerprint("recovered-overflow-claim"),
      "2026-07-15T03:00:00.000Z"
    )).toMatchObject({
      signal_id: previousOverflowSignalId,
      admission_state: "ready"
    });
  });
});

function createHarness(cap: number) {
  const database = initDatabase({ filename: ":memory:" });
  databases.add(database);
  seedWorkspace(database, "workspace-a");
  seedWorkspace(database, "workspace-b");
  return {
    database,
    repo: new SqliteSourceGroundingDeferQueueRepo(database, cap)
  };
}

function seedWorkspace(database: ReturnType<typeof initDatabase>, workspaceId: string): void {
  database.connection.prepare(`
    INSERT INTO workspaces (
      workspace_id, name, root_path, workspace_kind,
      workspace_state, created_at, default_engine_class
    ) VALUES (?, ?, ?, 'local_repo', 'active', ?, NULL)
  `).run(workspaceId, workspaceId, `/tmp/${workspaceId}`, "2026-07-15T00:00:00.000Z");
}

function entry(workspaceId: string, signalId: string, reason: SourceGroundingDeferReason) {
  return {
    signal_id: signalId,
    workspace_id: workspaceId,
    run_id: `run-${workspaceId}`,
    defer_reason: reason,
    enqueued_at: "2026-07-15T00:00:00.000Z"
  };
}

function fingerprint(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}
