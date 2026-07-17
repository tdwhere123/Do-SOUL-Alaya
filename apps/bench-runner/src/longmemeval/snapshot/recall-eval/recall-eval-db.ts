import {
  assertSnapshotVersionMatch,
  type LongMemEvalSnapshotManifest
} from "../materialize.js";
import {
  assertLegacySnapshotSourceCompatibility,
  prepareLegacySnapshotConsumer
} from "../legacy/legacy-compatibility.js";

export function prepareRecallEvalRestoredDb(input: {
  readonly manifest: LongMemEvalSnapshotManifest;
  readonly restoredDbPath: string;
  readonly legacySnapshot: boolean;
}): void {
  if (input.legacySnapshot) {
    assertLegacySnapshotSourceCompatibility(input.manifest, input.restoredDbPath);
    prepareLegacySnapshotConsumer(input.manifest, input.restoredDbPath);
    return;
  }
  assertSnapshotVersionMatch(input.manifest, input.restoredDbPath);
}
