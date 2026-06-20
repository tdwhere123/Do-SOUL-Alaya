import { join } from "node:path";
import { initDatabase, SqliteMemoryEmbeddingRepo } from "@do-soul/alaya-storage";
import type { BenchEmbeddingWarmupSummary } from "./daemon-types.js";

export async function readEmbeddingWarmupSummary(input: {
  readonly dataDir: string;
  readonly workspaceId: string;
  readonly objectIds: readonly string[];
  readonly providerKind: string;
  readonly modelId: string;
  readonly schemaVersion: number;
  readonly passCount: number;
}): Promise<BenchEmbeddingWarmupSummary> {
  const expectedIds = [...new Set(input.objectIds)];
  if (expectedIds.length === 0) {
    return Object.freeze({
      status: "ready",
      expected_count: 0,
      ready_count: 0,
      ready_rate: 0,
      pass_count: input.passCount,
      missing_object_ids: Object.freeze([]),
      provider_kind: input.providerKind,
      model_id: input.modelId
    });
  }

  const db = initDatabase({ filename: join(input.dataDir, "alaya.db") });
  const embeddingRepo = new SqliteMemoryEmbeddingRepo(db);
  const records = await embeddingRepo.findMetadataByObjectIds(expectedIds);
  const readyIds = new Set(
    records
      .filter(
        (record) =>
          record.workspace_id === input.workspaceId &&
          record.provider_kind === input.providerKind &&
          record.model_id === input.modelId &&
          record.schema_version === input.schemaVersion
      )
      .map((record) => record.object_id)
  );
  const missingObjectIds = expectedIds.filter((objectId) => !readyIds.has(objectId));

  return Object.freeze({
    status: "ready",
    expected_count: expectedIds.length,
    ready_count: readyIds.size,
    ready_rate: ratio(readyIds.size, expectedIds.length),
    pass_count: input.passCount,
    missing_object_ids: Object.freeze(missingObjectIds),
    provider_kind: input.providerKind,
    model_id: input.modelId
  });
}

function ratio(count: number, total: number): number {
  return total === 0 ? 0 : count / total;
}

