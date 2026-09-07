import { buildDefaultPolicy } from "../../../../recall/runtime/orchestration.js";
import { prepareRecallRequest } from "../../../../recall/runtime/query/prepare-recall-request.js";
import { captureRecallRequestTime } from "../../../../recall/runtime/query/recall-request-time.js";
import {
  createSnapshotCoherenceReceiptV1,
  createSnapshotVectorV1,
  finalizePreparedSnapshotReadLease
} from "../../../../recall/runtime/snapshot-coherence/index.js";
import { createSeededTestOnlyInMemoryFieldQuerySession } from
  "../../../../recall/runtime/query/field-query-session.js";
import type { RecallServiceMemoryRepoPort } from "../../../../recall/runtime/recall-service-types.js";
import type { PreparedRecallRequest } from "../../../../recall/runtime/recall-service-runner-types.js";
import { fieldContractSha256 } from "../../../../shared/field-hash.js";
import { createDependencies, createTaskSurface } from "../../recall-service-test-fixtures.js";

const NOW = "2026-08-29T00:00:00.000Z";

export function stubMemoryRepo(
  searchByKeywordField?: RecallServiceMemoryRepoPort["searchByKeywordField"]
): RecallServiceMemoryRepoPort {
  return {
    findByWorkspaceId: async () => [],
    findByDimension: async () => [],
    findByScopeClass: async () => [],
    ...(searchByKeywordField === undefined ? {} : { searchByKeywordField })
  };
}

export async function preparedAuthority(): Promise<PreparedRecallRequest> {
  const { dependencies } = createDependencies([]);
  return prepareRecallRequest({
    dependencies,
    warn: () => undefined,
    now: () => NOW,
    buildDefaultPolicy: () => buildDefaultPolicy({
      strategy: "build",
      taskSurfaceRef: "task-surface-1",
      now: () => NOW,
      generateRuntimeId: () => "33333333-3333-4333-8333-333333333333"
    }),
    fieldQuerySession: createSeededTestOnlyInMemoryFieldQuerySession(
      fieldContractSha256, "workspace-1"
    ),
    sha256: fieldContractSha256
  }, {
    taskSurface: createTaskSurface(),
    workspaceId: "workspace-1",
    strategy: "analyze"
  }, captureRecallRequestTime({ now: () => NOW }));
}

export async function capturedLexicalPreparedAuthority(): Promise<PreparedRecallRequest> {
  const prepared = await preparedAuthority();
  const { schema_version: _schemaVersion, vector_digest: _vectorDigest, ...input } =
    prepared.snapshotVector;
  const snapshotVector = createSnapshotVectorV1({
    ...input,
    retrieval_channel_snapshots: prepared.snapshotVector.retrieval_channel_snapshots.map(
      (declaration) => declaration.source_owner === "lexical_relaxed"
        ? Object.freeze({
            ...declaration,
            source_frontier: "lexical-frontier:test-captured",
            generation: "lexical-generation:test-captured",
            lag_bound: Object.freeze({ kind: "exact" as const })
          })
        : declaration
    )
  });
  return Object.freeze({
    ...prepared,
    snapshotVector,
    snapshotCoherenceReceipt: createSnapshotCoherenceReceiptV1(snapshotVector),
    snapshotReadLease: finalizePreparedSnapshotReadLease(snapshotVector)
  });
}

export function cleanup(prepared: PreparedRecallRequest): void {
  prepared.releaseProjectionPin();
  prepared.projectionPinLease.stop();
}
