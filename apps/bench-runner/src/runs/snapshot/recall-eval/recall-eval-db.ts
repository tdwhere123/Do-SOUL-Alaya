import type { LongMemEvalSnapshotManifest } from "../materialize.js";
import { assertSnapshotConsumeIdentity } from "../snapshot-seed-identity.js";
import {
  readSchemaMigrationLedger,
  TEMPORAL_OFFLINE_MIGRATION_VERSION
} from "@do-soul/alaya-storage";
import { SNAPSHOT_SEED_IDENTITY } from "../../../shared/version.js";
import type { WarmDerivedSnapshotReceipt } from
  "./warm-derived/warm-derived-snapshot-receipt.js";

export function prepareRecallEvalRestoredDb(input: {
  readonly manifest: LongMemEvalSnapshotManifest;
  readonly restoredDbPath: string;
  readonly legacySnapshot: boolean;
  readonly derivedEvidenceProjectionRebuild?: boolean;
  readonly warmDerivedSnapshot?: WarmDerivedSnapshotReceipt;
  readonly snapshotBytePath?: string;
}): void {
  if (input.warmDerivedSnapshot !== undefined) {
    assertWarmDerivedSnapshot({
      ...input,
      warmDerivedSnapshot: input.warmDerivedSnapshot
    });
    return;
  }
  if (input.derivedEvidenceProjectionRebuild === true) {
    assertDerivedRebuildSource(input);
    return;
  }
  if (input.legacySnapshot) {
    throw new Error("legacy snapshots are not supported");
  }
  assertSnapshotConsumeIdentity({
    manifest: input.manifest,
    restoredDbPath: input.restoredDbPath,
    runningSeedIdentity: SNAPSHOT_SEED_IDENTITY,
    ...(input.snapshotBytePath === undefined ? {} : { snapshotBytePath: input.snapshotBytePath })
  });
}

function assertWarmDerivedSnapshot(input: {
  readonly manifest: LongMemEvalSnapshotManifest;
  readonly restoredDbPath: string;
  readonly legacySnapshot: boolean;
  readonly warmDerivedSnapshot: WarmDerivedSnapshotReceipt;
}): void {
  if (input.legacySnapshot) {
    throw new Error("warm derived snapshot cannot use a legacy source");
  }
  if (input.manifest.recall_pipeline_version !== SNAPSHOT_SEED_IDENTITY) {
    throw new Error("[recall-eval] warm derived snapshot seed identity mismatch");
  }
  const restoredVersion = readSchemaMigrationLedger(input.restoredDbPath).at(-1);
  if (restoredVersion !== input.warmDerivedSnapshot.databaseSchemaVersion) {
    throw new Error("[recall-eval] warm derived snapshot schema binding mismatch");
  }
}

function assertDerivedRebuildSource(input: {
  readonly manifest: LongMemEvalSnapshotManifest;
  readonly restoredDbPath: string;
  readonly legacySnapshot: boolean;
}): void {
  if (input.legacySnapshot) {
    throw new Error("derived evidence projection rebuild cannot use a legacy snapshot");
  }
  if (input.manifest.recall_pipeline_version !== SNAPSHOT_SEED_IDENTITY) {
    throw new Error(
      "[recall-eval] derived rebuild snapshot seed identity mismatch"
    );
  }
  const sourceVersion = readSchemaMigrationLedger(input.restoredDbPath).at(-1);
  if (sourceVersion !== input.manifest.schema_migration_version) {
    throw new Error(
      "[recall-eval] derived rebuild snapshot schema binding mismatch"
    );
  }
  if (sourceVersion === undefined || sourceVersion < TEMPORAL_OFFLINE_MIGRATION_VERSION) {
    throw new Error(
      `[recall-eval] derived rebuild requires snapshot schema ${TEMPORAL_OFFLINE_MIGRATION_VERSION} or newer`
    );
  }
}
