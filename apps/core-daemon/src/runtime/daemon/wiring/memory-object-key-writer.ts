import { createMemoryObjectKeyWriter } from "@do-soul/alaya-core";
import { SqliteMemoryObjectKeyRepo, readObjectKeyEvidenceSources, type StorageDatabase } from "@do-soul/alaya-storage";

export function createDaemonMemoryObjectKeyWriter(database: StorageDatabase) {
  const repo = new SqliteMemoryObjectKeyRepo(database);
  return createMemoryObjectKeyWriter({
    readEvidenceSources: (workspaceId, evidenceIds) => readObjectKeyEvidenceSources(database, workspaceId, evidenceIds),
    replaceOwnerKeys: (workspaceId, ownerId, keys, expectedOwner) =>
      repo.replaceOwnerKeys(workspaceId, ownerId, keys, expectedOwner)
  });
}
