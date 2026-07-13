import type { LongMemEvalVariant } from "../dataset.js";
import {
  assertSnapshotConsumerBinding,
  readSnapshotManifest,
  readSnapshotSidecar,
  snapshotManifestPath
} from "../snapshot.js";
import { sha256File } from "./integrity.js";
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
    : await readAttributedSnapshotBundle(input.snapshotDbPath);
  assertSnapshotConsumerBinding({
    snapshotDbPath: input.snapshotDbPath,
    manifest: bundle.manifest,
    sidecar: bundle.sidecar,
    variant: input.variant
  });
  return bundle;
}

async function readAttributedSnapshotBundle(snapshotDbPath: string) {
  return {
    manifest: readSnapshotManifest(snapshotDbPath),
    sidecar: readSnapshotSidecar(snapshotDbPath),
    snapshotManifestSha256: await sha256File(snapshotManifestPath(snapshotDbPath)),
    datasetSha256: null
  };
}
