import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import BetterSqlite3 from "better-sqlite3";
import { withRecallReadSnapshot } from "@do-soul/alaya-core";
import {
  initDatabase,
  SqliteMemoryEntryRepo,
  type StorageDatabase
} from "@do-soul/alaya-storage";
import { createSqliteConnectionReadSnapshot } from "../../../runtime/recall/sqlite-read-snapshot.js";
import { createRecallReadWorkerClient } from "../../../runtime/recall/recall-read-worker-client.js";

const builtWorkerUrl = new URL("../../../../dist/runtime/recall/recall-read-worker.js", import.meta.url);
const databases: StorageDatabase[] = [];
const tempDirs: string[] = [];

afterEach(() => {
  for (const database of databases.splice(0, databases.length)) {
    if (!database.isClosed()) database.close();
  }
  for (const directory of tempDirs.splice(0, tempDirs.length)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("recall read snapshot wiring", () => {
  it("hides mid-recall writes on the same sqlite connection after BEGIN DEFERRED", async () => {
    const filename = tempDbPath();
    const database = initDatabase({ filename });
    databases.push(database);
    database.connection.exec("CREATE TABLE snapshot_probe (id TEXT PRIMARY KEY, v TEXT NOT NULL)");
    database.connection.prepare("INSERT INTO snapshot_probe VALUES (?, ?)").run("row", "old");

    const snapshot = createSqliteConnectionReadSnapshot(database.connection);
    await withRecallReadSnapshot(snapshot, async () => {
      expect(readProbe(database, "row")).toBe("old");
      plantProbeWrite(filename, "row", "new");
      expect(readProbe(database, "row")).toBe("old");
    });

    expect(readProbe(database, "row")).toBe("new");
  });

  it("holds a worker snapshot across messages so a planted write is invisible", async () => {
    if (!existsSync(fileURLToPath(builtWorkerUrl))) {
      throw new Error("Built recall-read-worker dist missing. Run `pnpm build` before this test.");
    }
    const filename = tempDbPath();
    const database = initDatabase({ filename });
    const repo = new SqliteMemoryEntryRepo(database);
    const visible = await repo.create(createMemory({
      object_id: "11111111-1111-4111-8111-111111111111",
      content: "visible before snapshot"
    }));
    const plantedId = "22222222-2222-4222-8222-222222222222";
    database.close();

    const client = createRecallReadWorkerClient({
      databaseFilename: filename,
      workerUrl: builtWorkerUrl,
      workerCount: 1
    });
    expect(client).not.toBeNull();
    if (client === null) return;
    try {
      await client.ready();
      await withRecallReadSnapshot(client.readSnapshot, async () => {
        const first = await client.memoryRepo.findByWorkspaceId("workspace-1");
        expect(first.map((entry) => entry.object_id)).toContain(visible.object_id);
        await plantMemory(filename, plantedId);
        const second = await client.memoryRepo.findByWorkspaceId("workspace-1");
        expect(second.map((entry) => entry.object_id)).not.toContain(plantedId);
      });
      const after = await client.memoryRepo.findByWorkspaceId("workspace-1");
      expect(after.map((entry) => entry.object_id)).toContain(plantedId);
    } finally {
      await client.close();
    }
  }, 30_000);
});

function tempDbPath(): string {
  const directory = mkdtempSync(join(tmpdir(), "alaya-recall-snapshot-"));
  tempDirs.push(directory);
  return join(directory, "alaya.db");
}

function readProbe(database: StorageDatabase, id: string): string | undefined {
  const row = database.connection.prepare("SELECT v FROM snapshot_probe WHERE id = ?").get(id) as
    | { readonly v: string }
    | undefined;
  return row?.v;
}

function plantProbeWrite(filename: string, id: string, value: string): void {
  const writer = new BetterSqlite3(filename);
  writer.pragma("journal_mode = WAL");
  writer.prepare("UPDATE snapshot_probe SET v = ? WHERE id = ?").run(value, id);
  writer.close();
}

async function plantMemory(filename: string, objectId: string): Promise<void> {
  const database = initDatabase({ filename });
  databases.push(database);
  const repo = new SqliteMemoryEntryRepo(database);
  await repo.create(createMemory({ object_id: objectId, content: "planted mid snapshot" }));
  database.close();
}

function createMemory(overrides: {
  readonly object_id: string;
  readonly content: string;
}) {
  return {
    object_id: overrides.object_id,
    object_kind: "memory_entry" as const,
    schema_version: 1,
    lifecycle_state: "active" as const,
    created_at: "2026-05-01T00:00:00.000Z",
    updated_at: "2026-05-01T00:00:00.000Z",
    created_by: "test",
    dimension: "procedure" as const,
    source_kind: "user" as const,
    formation_kind: "explicit" as const,
    scope_class: "project" as const,
    content: overrides.content,
    domain_tags: ["recall"],
    evidence_refs: [],
    workspace_id: "workspace-1",
    run_id: "run-1",
    surface_id: null,
    storage_tier: "hot" as const,
    activation_score: 0.5,
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
