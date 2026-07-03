import { afterEach, describe, expect, it } from "vitest";
import {
  createFixture,
  seedMemoryEntry,
  trackedDatabases
} from "./garden-data-ports-fixture.js";

const databases = trackedDatabases;

afterEach(() => {
  for (const database of databases) {
    database.close();
  }
  databases.clear();
});

describe("garden janitor and librarian SQL workspace isolation", () => {
  it("janitor dormant demotion scans and demotes only within the requested workspace", async () => {
    const { database, ports } = await createFixture();
    const staleAccess = "2026-01-01T00:00:00.000Z";

    seedMemoryEntry(database, {
      objectId: "memory-ws1-dormant",
      workspaceId: "workspace-1",
      runId: "run-1",
      activationScore: 0.1,
      lastHitAt: staleAccess
    });
    seedMemoryEntry(database, {
      objectId: "memory-ws2-dormant",
      workspaceId: "workspace-2",
      runId: "run-2",
      activationScore: 0.1,
      lastHitAt: staleAccess
    });
    seedMemoryEntry(database, {
      objectId: "memory-ws1-active",
      workspaceId: "workspace-1",
      runId: "run-1",
      activationScore: 0.9,
      lastHitAt: staleAccess
    });

    const ws1Candidates = await ports.dormantDemotionPort.findLowActivityActiveMemories("workspace-1");
    const ws2Candidates = await ports.dormantDemotionPort.findLowActivityActiveMemories("workspace-2");

    expect(ws1Candidates.map((row) => row.memory_id)).toEqual(["memory-ws1-dormant"]);
    expect(ws2Candidates.map((row) => row.memory_id)).toEqual(["memory-ws2-dormant"]);

    expect(await ports.dormantDemotionPort.setLifecycleDormant("memory-ws1-dormant", "task-1")).toBe(
      "demoted"
    );

    const ws1Row = database.connection
      .prepare("SELECT lifecycle_state FROM memory_entries WHERE object_id = ? LIMIT 1")
      .get("memory-ws1-dormant") as { readonly lifecycle_state: string } | undefined;
    const ws2Row = database.connection
      .prepare("SELECT lifecycle_state FROM memory_entries WHERE object_id = ? LIMIT 1")
      .get("memory-ws2-dormant") as { readonly lifecycle_state: string } | undefined;

    expect(ws1Row?.lifecycle_state).toBe("dormant");
    expect(ws2Row?.lifecycle_state).toBe("active");
  });

  it("janitor hot demotion does not demote rows when workspace_id mismatches", async () => {
    const { database, ports } = await createFixture();
    seedMemoryEntry(database, {
      objectId: "memory-cross-ws",
      workspaceId: "workspace-1",
      runId: "run-1",
      activationScore: 0.1,
      lastHitAt: "2026-01-01T00:00:00.000Z"
    });

    await ports.tieringPort.demoteToWarm("workspace-2", ["memory-cross-ws"]);

    const row = database.connection
      .prepare("SELECT storage_tier FROM memory_entries WHERE object_id = ? LIMIT 1")
      .get("memory-cross-ws") as { readonly storage_tier: string } | undefined;
    expect(row?.storage_tier).toBe("hot");
  });

  it("librarian merge detection ignores duplicate content in other workspaces", async () => {
    const { database, ports } = await createFixture();
    const sharedContent = "Shared subject line for merge";

    seedMemoryEntry(database, {
      objectId: "memory-ws1-a",
      workspaceId: "workspace-1",
      runId: "run-1",
      content: sharedContent,
      dimension: "fact"
    });
    seedMemoryEntry(database, {
      objectId: "memory-ws1-b",
      workspaceId: "workspace-1",
      runId: "run-1",
      content: sharedContent,
      dimension: "fact"
    });
    seedMemoryEntry(database, {
      objectId: "memory-ws2-a",
      workspaceId: "workspace-2",
      runId: "run-2",
      content: sharedContent,
      dimension: "fact"
    });
    seedMemoryEntry(database, {
      objectId: "memory-ws2-b",
      workspaceId: "workspace-2",
      runId: "run-2",
      content: sharedContent,
      dimension: "fact"
    });

    const ws1Merges = await ports.mergePort.findMergeCandidates("workspace-1");
    const ws2Merges = await ports.mergePort.findMergeCandidates("workspace-2");

    expect(ws1Merges.length).toBeGreaterThan(0);
    expect(ws2Merges.length).toBeGreaterThan(0);
    expect(ws1Merges[0]?.duplicate_ids.every((id) => id.startsWith("memory-ws1-"))).toBe(true);
    expect(ws2Merges[0]?.duplicate_ids.every((id) => id.startsWith("memory-ws2-"))).toBe(true);
    expect(ws1Merges[0]?.duplicate_ids).not.toContain("memory-ws2-a");
    expect(ws2Merges[0]?.duplicate_ids).not.toContain("memory-ws1-a");
  });
});
