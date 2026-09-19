import {
  canonicalProductIdentityOfEntry,
  sourceRecallTarget,
  type InformationIndex
} from "@do-soul/alaya-protocol";
import {
  SqliteEvidenceCapsuleRepo,
  SqliteFieldSourceRecordRepo,
  SqliteSourceRootRecallReader,
  type StorageDatabase
} from "@do-soul/alaya-storage";
import {
  applyUtf8HydrateToSourceRootPage,
  runConditionalFieldRecall,
  toSourceRootObserverRow,
  type ObserverReaders
} from "../../../recall/recall-service.js";
import {
  FAR_FUTURE_EXPIRY,
  INTERPRETATION_CLOCK,
  SNAPSHOT_ID,
  defaultBudget
} from "../conditional-field/reference/deployment.fixture.js";
import {
  fieldSha256,
  hashedRecord,
  openFieldDatabase
} from "../../../../../storage/src/__tests__/repos/field/field-contract-fixture.js";

export function plantSource(
  register: (database: StorageDatabase) => void,
  rows: readonly { readonly body: string; readonly sourceId?: string }[]
) {
  const database = openFieldDatabase();
  register(database);
  const records = new SqliteFieldSourceRecordRepo(database, fieldSha256);
  const planted = rows.map((row) =>
    records.insert(hashedRecord("workspace-1", row.body, row.sourceId ?? "src-1")));
  const reader = new SqliteSourceRootRecallReader(records, new SqliteEvidenceCapsuleRepo(database));
  return { database, records: planted, reader };
}

export function recallPlantedSource(
  reader: SqliteSourceRootRecallReader,
  query: string,
  nativeByteLimit = 65_536,
  previewBytes = 65_536
): InformationIndex {
  return runConditionalFieldRecall({
    workspace_id: "workspace-1",
    query_text: query,
    budget: defaultBudget(),
    snapshot_id: SNAPSHOT_ID,
    interpretation_clock: INTERPRETATION_CLOCK,
    as_of: INTERPRETATION_CLOCK,
    expires_at: FAR_FUTURE_EXPIRY,
    result_kind_view: "source_only",
    authorized_scopes: null,
    readers: plantedSourceReaders(reader, nativeByteLimit, previewBytes)
  });
}

export function plantedSourceReaders(
  reader: SqliteSourceRootRecallReader,
  nativeByteLimit: number,
  previewBytes: number
): ObserverReaders {
  return {
    sourceRoots: (input) => {
      const page = reader.page({ ...input, nativeByteLimit });
      return { ...page, rows: page.rows.map(toSourceRootObserverRow) };
    },
    sourceRoot: (input) => {
      if (input.revision === undefined || input.digest === undefined) {
        return { row: null, rowsRead: 0, bytesRead: 0, unavailable: true };
      }
      const loaded = reader.hydrate(
        input.workspaceId,
        sourceRecallTarget({
          workspace_id: input.workspaceId,
          root_kind: input.rootKind,
          root_id: input.rootId,
          source_version: input.revision,
          content_digest: input.digest,
          evidence_object_id: input.evidenceObjectId ?? (
            input.rootKind === "evidence_capsule" ? input.rootId : null
          )
        }),
        previewBytes,
        input.offset ?? 0,
        nativeByteLimit
      );
      return applyUtf8HydrateToSourceRootPage({
        row: loaded.row === null ? null : toSourceRootObserverRow(loaded.row),
        rowsRead: loaded.rowsRead,
        bytesRead: loaded.bytesRead,
        unavailable: loaded.unavailable,
        ...(loaded.resourceLimited === undefined ? {} : { resourceLimited: loaded.resourceLimited }),
        ...(loaded.metadataBytes === undefined ? {} : { metadataBytes: loaded.metadataBytes }),
        ...(loaded.nativeWork === undefined ? {} : { nativeWork: loaded.nativeWork })
      }, input.offset ?? 0, previewBytes);
    }
  };
}

export function identitySet(index: InformationIndex): string[] {
  return index.entries.map((entry) => canonicalProductIdentityOfEntry(entry)).sort();
}
