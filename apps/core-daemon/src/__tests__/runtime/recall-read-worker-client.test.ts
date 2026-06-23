import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { beforeAll, describe, expect, it } from "vitest";
import { initDatabase, SqliteMemoryEntryRepo } from "@do-soul/alaya-storage";
import { createRecallReadWorkerClient } from "../../runtime/recall-read-worker-client.js";

const builtWorkerUrl = new URL("../../../dist/runtime/recall-read-worker.js", import.meta.url);

describe("RecallReadWorkerClient", () => {
  // Loud failure (not skip): the wave gate builds before testing, so a missing
  // dist is a real regression, never an excuse to silently pass.
  beforeAll(() => {
    if (!existsSync(fileURLToPath(builtWorkerUrl))) {
      throw new Error("Built recall-read-worker dist missing. Run `rtk pnpm build` before this test.");
    }
  });

  it("keeps the daemon event loop available during a file-backed SQLite recall read", async () => {
    const directory = mkdtempSync(join(tmpdir(), "alaya-recall-worker-test-"));
    const database = initDatabase({ filename: join(directory, "alaya.db") });
    const repo = new SqliteMemoryEntryRepo(database);
    const workspaceId = "workspace-1";
    const rowCount = 900;

    try {
      for (let index = 0; index < rowCount; index += 1) {
        await repo.create(createMemoryEntry({
          object_id: randomUUID(),
          workspace_id: workspaceId,
          content: `Worker recall load row ${index}`,
          activation_score: 1 - index / rowCount
        }));
      }

      const client = createRecallReadWorkerClient({
        databaseFilename: database.filename,
        workerUrl: builtWorkerUrl
      });
      expect(client).not.toBeNull();
      if (client === null) {
        return;
      }

      try {
        const startedAt = performance.now();
        const timerDelayPromise = new Promise<number>((resolve) => {
          setTimeout(() => resolve(performance.now() - startedAt), 0);
        });
        const rowsPromise = client.memoryRepo.findByWorkspaceId(workspaceId, "hot", {
          limit: rowCount,
          offset: 0
        });

        await expect(timerDelayPromise).resolves.toBeLessThan(50);
        await expect(rowsPromise).resolves.toHaveLength(rowCount);
      } finally {
        await client.close();
      }
    } finally {
      database.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

function createMemoryEntry(overrides: {
  readonly object_id: string;
  readonly workspace_id: string;
  readonly content: string;
  readonly activation_score: number;
}) {
  return {
    object_id: overrides.object_id,
    object_kind: "memory_entry" as const,
    schema_version: 1,
    lifecycle_state: "active" as const,
    created_at: "2026-06-17T00:00:00.000Z",
    updated_at: "2026-06-17T00:00:00.000Z",
    created_by: "test",
    dimension: "procedure" as const,
    source_kind: "user" as const,
    formation_kind: "explicit" as const,
    scope_class: "project" as const,
    content: overrides.content,
    domain_tags: ["recall"],
    evidence_refs: [],
    workspace_id: overrides.workspace_id,
    run_id: "run-1",
    surface_id: null,
    storage_tier: "hot" as const,
    activation_score: overrides.activation_score,
    retention_score: null,
    manifestation_state: null,
    retention_state: null,
    decay_profile: null,
    confidence: null,
    last_used_at: null,
    last_hit_at: null,
    reinforcement_count: null,
    contradiction_count: null,
    superseded_by: null
  };
}
