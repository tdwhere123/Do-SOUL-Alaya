import { sourceRecallTarget } from "@do-soul/alaya-protocol";
import { fieldContractSha256, toSourceRootObserverRow, type ObserverReaders } from "@do-soul/alaya-core";
import {
  SqliteEvidenceCapsuleRepo,
  SqliteFieldSourceRecordRepo,
  SqliteSourceRootRecallReader,
  type StorageDatabase
} from "@do-soul/alaya-storage";

export function sourceRootReaders(database: StorageDatabase): Pick<ObserverReaders, "sourceRootMetadataByteLimit"
  | "sourceRootChunkByteLimit" | "sourceRoots" | "sourceRoot"> {
  const sourceRoots = new SqliteSourceRootRecallReader(
    new SqliteFieldSourceRecordRepo(database, fieldContractSha256),
    new SqliteEvidenceCapsuleRepo(database)
  );
  return {
    sourceRootMetadataByteLimit: 8192,
    sourceRootChunkByteLimit: 4096,
    sourceRoots: (input) => {
      const page = sourceRoots.page({
        workspaceId: input.workspaceId,
        query: input.query,
        limit: input.limit,
        nativeLimit: input.nativeLimit,
        workLimit: input.workLimit,
        afterCursor: input.afterCursor,
        byteLimit: input.byteLimit,
        nativeByteLimit: input.nativeByteLimit
      });
      return {
        rows: page.rows.map(toSourceRootObserverRow),
        nativeVisits: page.nativeVisits,
        nativeBytes: page.nativeBytes,
        rowsRead: page.rowsRead,
        bytesRead: page.bytesRead,
        metadataBytes: page.metadataBytes,
        nativeWork: page.nativeWork,
        truncated: page.truncated,
        committedThrough: page.committedThrough,
        unavailable: page.unavailable
      };
    },
    sourceRoot: (input) => {
      if (input.revision === undefined || input.digest === undefined) {
        return { row: null, rowsRead: 0, bytesRead: 0, unavailable: true };
      }
      const page = sourceRoots.hydrate(
        input.workspaceId,
        sourceRecallTarget({
          workspace_id: input.workspaceId,
          root_kind: input.rootKind,
          root_id: input.rootId,
          source_version: input.revision,
          content_digest: input.digest,
          evidence_object_id: input.evidenceObjectId ?? (input.rootKind === "evidence_capsule" ? input.rootId : null)
        }),
        input.byteLimit ?? 65536,
        input.offset ?? 0,
        // 12288 is the retained chunk+metadata reservation; logical clip is separate.
        input.nativeByteLimit ?? Math.max(input.byteLimit ?? 65536, 12_288),
        input.workLimit,
        input.purpose === "payload",
        input.firstDeliveryUnit === true
      );
      return {
        row: page.row === null ? null : toSourceRootObserverRow(page.row),
        rowsRead: page.rowsRead,
        bytesRead: page.bytesRead,
        metadataBytes: page.metadataBytes,
        nativeWork: page.nativeWork,
        unavailable: page.unavailable,
        resourceLimited: page.resourceLimited
      };
    }
  };
}
