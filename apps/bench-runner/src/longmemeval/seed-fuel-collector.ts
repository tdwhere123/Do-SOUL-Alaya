import { join } from "node:path";
import {
  deriveSeedFuelInventory,
  type SeedFuelInventory
} from "@do-soul/alaya-core";
import type { MemoryEntry, PathRelation } from "@do-soul/alaya-protocol";
import {
  initDatabase,
  SqliteMemoryEntryRepo,
  SqlitePathRelationRepo
} from "@do-soul/alaya-storage";
import { BENCH_DAEMON_DB_FILENAME } from "./snapshot.js";

export type { SeedFuelInventory } from "@do-soul/alaya-core";

export async function collectBenchSeedFuelInventory(
  dataDir: string
): Promise<SeedFuelInventory> {
  const db = initDatabase({ filename: join(dataDir, BENCH_DAEMON_DB_FILENAME) });
  const memoryRepo = new SqliteMemoryEntryRepo(db);
  const pathRepo = new SqlitePathRelationRepo(db);
  const workspaceIds = listMemoryWorkspaceIds(db);
  if (workspaceIds.length === 0) {
    return deriveSeedFuelInventory({ entries: [] });
  }
  const entries: MemoryEntry[] = [];
  const paths: PathRelation[] = [];
  for (const workspaceId of workspaceIds) {
    const workspaceEntries = await memoryRepo.findByWorkspaceIdAll(workspaceId);
    entries.push(
      ...workspaceEntries.filter((entry) => entry.object_kind === "memory_entry")
    );
    paths.push(...(await pathRepo.findByWorkspaceAll(workspaceId)));
  }
  return deriveSeedFuelInventory({ entries, paths });
}

function listMemoryWorkspaceIds(db: ReturnType<typeof initDatabase>): readonly string[] {
  const rows = db.connection
    .prepare(
      `SELECT DISTINCT workspace_id
       FROM memory_entries
       WHERE object_kind = 'memory_entry'
       ORDER BY workspace_id ASC`
    )
    .all() as Array<{ readonly workspace_id: string }>;
  return rows.map((row) => row.workspace_id);
}
