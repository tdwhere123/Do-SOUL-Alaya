import {
  assertSnapshotVersionMatch,
  type LongMemEvalSnapshotManifest
} from "../materialize.js";
import { readSchemaMigrationLedger } from "@do-soul/alaya-storage";
import { RECALL_PIPELINE_VERSION } from "../../../shared/version.js";
import {
  assertLegacySnapshotSourceCompatibility,
  prepareLegacySnapshotConsumer
} from "../legacy/legacy-compatibility.js";
import type { WarmDerivedSnapshotReceipt } from
  "./warm-derived/warm-derived-snapshot-receipt.js";

export function prepareRecallEvalRestoredDb(input: {
  readonly manifest: LongMemEvalSnapshotManifest;
  readonly restoredDbPath: string;
  readonly legacySnapshot: boolean;
  readonly derivedEvidenceProjectionRebuild?: boolean;
  readonly warmDerivedSnapshot?: WarmDerivedSnapshotReceipt;
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
    assertLegacySnapshotSourceCompatibility(input.manifest, input.restoredDbPath);
    prepareLegacySnapshotConsumer(input.manifest, input.restoredDbPath);
    return;
  }
  assertSnapshotVersionMatch(input.manifest, input.restoredDbPath);
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
  if (input.manifest.recall_pipeline_version !== RECALL_PIPELINE_VERSION) {
    throw new Error("[recall-eval] warm derived snapshot recall pipeline version mismatch");
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
  if (input.manifest.recall_pipeline_version !== RECALL_PIPELINE_VERSION) {
    throw new Error(
      "[recall-eval] derived rebuild snapshot recall pipeline version mismatch"
    );
  }
  const sourceVersion = readSchemaMigrationLedger(input.restoredDbPath).at(-1);
  if (sourceVersion !== input.manifest.schema_migration_version) {
    throw new Error(
      "[recall-eval] derived rebuild snapshot schema binding mismatch"
    );
  }
  if (sourceVersion === undefined || sourceVersion < 108) {
    throw new Error(
      "[recall-eval] derived rebuild requires snapshot schema 108 or newer"
    );
  }
}
