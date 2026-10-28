import type { StorageDatabase } from "../../../sqlite/db.js";
import { SqliteFieldSourceRecordRepo } from "../../../repos/field/source-repo.js";
import { fieldSha256, hashedOriginalRecord, seedWorkspaces } from "../field/field-contract-fixture.js";

export function gardenTurnSourceId(workspaceId: string): string {
  return hashedOriginalRecord(workspaceId, "User: remember this", `garden-turn:${workspaceId}`).record_id;
}

export function retainGardenTurnSources(database: StorageDatabase): void {
  seedWorkspaces(database);
  const records = new SqliteFieldSourceRecordRepo(database, fieldSha256);
  for (const workspaceId of ["workspace-1", "workspace-2"]) {
    records.insert(hashedOriginalRecord(workspaceId, "User: remember this", `garden-turn:${workspaceId}`));
  }
}
