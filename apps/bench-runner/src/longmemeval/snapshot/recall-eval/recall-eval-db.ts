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

export function prepareRecallEvalRestoredDb(input: {
  readonly manifest: LongMemEvalSnapshotManifest;
  readonly restoredDbPath: string;
  readonly legacySnapshot: boolean;
  readonly derivedEvidenceProjectionRebuild?: boolean;
}): void {
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
