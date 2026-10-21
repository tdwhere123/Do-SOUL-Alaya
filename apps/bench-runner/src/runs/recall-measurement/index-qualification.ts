import BetterSqlite3 from "better-sqlite3";
import { AlayaError, canonicalJson } from "@do-soul/alaya-protocol";
import { fieldContractSha256 } from "@do-soul/alaya-core";
import { SqliteFieldSourceRecordRepo, SqliteSourceIndexRepository, StorageDatabase } from "@do-soul/alaya-storage";
import type { SourceIndexRootQualification, SourceIndexSnapshotFact }
  from "../../../../core-daemon/src/runtime/recall-read-worker/source-index-measurement.js";
import type { BenchDaemonHandle } from "../../harness/daemon.js";
import { readSemanticChainDaemonRestoration } from "./contract.js";
type Constructor = typeof SqliteSourceIndexRepository;
type Measurement = Constructor[Extract<keyof Constructor, symbol>];

/** Resolve the single installed/source constructor authority, not a workspace-relative runtime import. */
export function sourceIndexMeasurementCapability(): Measurement {
  const measurement = Reflect.get(SqliteSourceIndexRepository,
    Symbol.for("@do-soul/alaya-storage/private/source-index-measurement")) as Measurement | undefined;
  if (measurement === undefined) throw new AlayaError("CONFLICT", "private source-index measurement capability unavailable");
  return measurement;
}

export type FrozenSourceIndexQualificationPage = Readonly<{
  snapshot_identity: string; index_identity: string; qualification: Omit<SourceIndexRootQualification, "snapshot">;
}>;
export type FrozenSourceIndexQualifications = Readonly<{
  snapshot_identity: string; workspace_id: string; index_identity: string; index: SourceIndexSnapshotFact;
  roots: number; pages: number; source_census: "complete" | "partial"; reason: string | null;
  native_sql_work: "unknown";
}>;

/** Private, label-free capture from the actual restored session, after canonical startup.
 * The restore owner binds the original sealed input; index facts include the live DB's WAL
 * in one read transaction. Capture neither migrates nor selects/builds an index, and no
 * disposable path or source body enters the archived qualification content. */
export function captureFrozenSourceIndexQualifications(input: Readonly<{
  daemon: BenchDaemonHandle; onPage: (page: FrozenSourceIndexQualificationPage) => void;
}>): FrozenSourceIndexQualifications {
  const owned = readSemanticChainDaemonRestoration(input.daemon);
  const connection = new BetterSqlite3(owned.databasePath, { readonly: true, fileMustExist: true });
  try {
    connection.pragma("query_only = ON");
    return captureQualificationRows({ database: new StorageDatabase(owned.databasePath, connection), workspaceId: owned.workspaceId,
      snapshotIdentity: `sha256:${owned.snapshotSha256}`, onPage: input.onPage });
  } finally { connection.close(); }
}

function captureQualificationRows(input: Readonly<{ database: StorageDatabase; workspaceId: string; snapshotIdentity: string;
  onPage: (page: FrozenSourceIndexQualificationPage) => void }>): FrozenSourceIndexQualifications {
  if (input.database.connection.inTransaction) throw new AlayaError("CONFLICT", "qualification capture owns its read transaction");
  const measurement = sourceIndexMeasurementCapability();
  return input.database.connection.transaction(() => {
    const index = measurement.readSnapshot(input.database, input.workspaceId), indexMaterial = canonicalJson(index);
    const indexIdentity = `sha256:${fieldContractSha256(indexMaterial)}`;
    const records = new SqliteFieldSourceRecordRepo(input.database, fieldContractSha256);
    let after: string | null = null, roots = 0, pages = 0;
    while (true) {
      const source = records.findNextCurrentBounded(input.workspaceId, after, 4,
        { workLimit: 1000, nativeByteLimit: 131072 });
      if (source === null) return finish("complete", null);
      if (source.resourceLimited || source.record === null) return finish("partial", "native_source_census_unavailable");
      const sourceId = source.record.source_id;
      let ordinal = -1;
      while (true) {
        const qualification = measurement.readRoot(input.database, fieldContractSha256, input.workspaceId, sourceId, ordinal);
        if (canonicalJson(qualification.snapshot) !== indexMaterial) throw new AlayaError("CONFLICT", "qualification snapshot binding changed");
        const { snapshot: _snapshot, ...root } = qualification;
        input.onPage({ snapshot_identity: input.snapshotIdentity, index_identity: indexIdentity, qualification: root }); pages++;
        if (qualification.vector.next_ordinal === null) break;
        if (qualification.vector.next_ordinal <= ordinal) throw new AlayaError("CONFLICT", "qualification window cursor did not advance");
        ordinal = qualification.vector.next_ordinal;
      }
      roots++; after = sourceId;
    }
    function finish(source_census: "complete" | "partial", reason: string | null): FrozenSourceIndexQualifications {
      return { snapshot_identity: input.snapshotIdentity, workspace_id: input.workspaceId, index_identity: indexIdentity, index,
        roots, pages, source_census, reason, native_sql_work: "unknown" };
    }
  })();
}

/** Index metadata compatibility only; capture uses the restore owner's session association.
 * Equal generation/profile/epoch alone do not prove the original sealed input identity.
 * Preparation disabled/unwired and unbound/ready index state remain separate native facts. */
export function frozenIndexMetadataMatchesNativeBinding(frozen: FrozenSourceIndexQualifications,
  native: SourceIndexSnapshotFact | null): boolean {
  if (native === null || native.workspace_id !== frozen.workspace_id || native.source_epoch !== frozen.index.source_epoch) return false;
  return canonicalJson(native.query_state) === canonicalJson(frozen.index.query_state)
    && canonicalJson(native.selection) === canonicalJson(frozen.index.selection)
    && canonicalJson(native.generation) === canonicalJson(frozen.index.generation);
}
