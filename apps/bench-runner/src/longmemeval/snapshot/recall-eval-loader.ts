import type { LongMemEvalVariant } from "../dataset.js";
import {
  assertSnapshotConsumerBinding,
  readSnapshotManifest,
  readSnapshotSidecar
} from "../snapshot.js";
import {
  readLegacySnapshotBundle
} from "./legacy-substrate.js";

export interface RecallEvalSnapshotBundle {
  readonly manifest: import("../snapshot.js").LongMemEvalSnapshotManifest;
  readonly sidecar: import("../snapshot.js").LongMemEvalSnapshotSidecarFile;
  readonly snapshotManifestSha256: string | null;
  readonly datasetSha256: string | null;
}

export async function loadRecallEvalSnapshot(input: {
  readonly snapshotDbPath: string;
  readonly variant: LongMemEvalVariant;
  readonly legacySnapshot?: boolean;
  readonly dataDir?: string;
  readonly pinnedMetaRoot?: string;
  readonly legacyManifestSha256?: string;
  readonly legacyDatasetSha256?: string;
}): Promise<RecallEvalSnapshotBundle> {
  const bundle = input.legacySnapshot === true
    ? await readLegacySnapshotBundle(input)
    : {
        manifest: readSnapshotManifest(input.snapshotDbPath),
        sidecar: readSnapshotSidecar(input.snapshotDbPath),
        snapshotManifestSha256: null,
        datasetSha256: null
      };
  assertSnapshotConsumerBinding({
    snapshotDbPath: input.snapshotDbPath,
    manifest: bundle.manifest,
    sidecar: bundle.sidecar,
    variant: input.variant
  });
  return bundle;
}
