import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LongMemEvalVariant } from "../../ingestion/dataset.js";
import {
  assertSnapshotConsumerBinding,
  type LongMemEvalSnapshotManifest,
  type LongMemEvalSnapshotSidecarFile
} from "../materialize.js";
import type { SnapshotMeasurementOracleAccessor } from
  "../measurement-oracle.js";
import { verifyCurrentRecallSnapshotAuthority } from
  "../current/current-substrate-authority.js";
import {
  readLegacySnapshotBundle
} from "../legacy/legacy-substrate.js";
import { bindCurrentSnapshotArtifacts } from "../current/current-bound-artifacts.js";
import type { SnapshotExtractionAuthority } from "../extraction-authority.js";

export interface RecallEvalSnapshotBundle {
  readonly snapshotDbPath: string;
  readonly manifest: LongMemEvalSnapshotManifest;
  readonly sidecar: LongMemEvalSnapshotSidecarFile;
  readonly extractionAuthority: SnapshotExtractionAuthority | null;
  readonly snapshotManifestSha256: string | null;
  readonly datasetSha256: string | null;
  readonly measurementForQuestion: SnapshotMeasurementOracleAccessor | null;
}

export async function loadRecallEvalSnapshot(input: {
  readonly snapshotDbPath: string;
  readonly variant: LongMemEvalVariant;
  readonly legacySnapshot?: boolean;
  readonly dataDir?: string;
  readonly pinnedMetaRoot?: string;
  readonly legacyManifestSha256?: string;
  readonly legacyDatasetSha256?: string;
}, currentSnapshotRoot?: string): Promise<RecallEvalSnapshotBundle> {
  const bundle = input.legacySnapshot === true
    ? {
        ...await readLegacySnapshotBundle(input),
        snapshotDbPath: input.snapshotDbPath,
        extractionAuthority: null,
        measurementForQuestion: null
      }
    : await readAttributedSnapshotBundle(input, requireCurrentRoot(currentSnapshotRoot));
  assertSnapshotConsumerBinding({
    snapshotDbPath: input.snapshotDbPath,
    manifest: bundle.manifest,
    sidecar: bundle.sidecar,
    variant: input.variant
  });
  return bundle;
}

export async function withRecallEvalSnapshot<T>(
  input: Parameters<typeof loadRecallEvalSnapshot>[0],
  consume: (bundle: RecallEvalSnapshotBundle) => Promise<T>
): Promise<T> {
  if (input.legacySnapshot === true) return consume(await loadRecallEvalSnapshot(input));
  const root = await mkdtemp(join(tmpdir(), "alaya-current-snapshot-"));
  let failed = false;
  let primaryError: unknown;
  try {
    return await consume(await loadRecallEvalSnapshot(input, root));
  } catch (error) {
    failed = true;
    primaryError = error;
    throw error;
  } finally {
    try {
      await rm(root, { recursive: true, force: true });
    } catch (cleanupError) {
      if (failed) throw new AggregateError([primaryError, cleanupError], "snapshot cleanup failed");
      throw cleanupError;
    }
  }
}

async function readAttributedSnapshotBundle(
  input: Parameters<typeof loadRecallEvalSnapshot>[0],
  currentSnapshotRoot: string
): Promise<RecallEvalSnapshotBundle> {
  const bound = bindCurrentSnapshotArtifacts({
    sourceDbPath: input.snapshotDbPath,
    targetRoot: currentSnapshotRoot
  });
  const { manifest, sidecar, snapshotDbPath, extractionAuthority } = bound;
  assertSnapshotConsumerBinding({
    snapshotDbPath,
    manifest,
    sidecar,
    variant: input.variant
  });
  const authority = await verifyCurrentRecallSnapshotAuthority({
    snapshotDbPath,
    variant: input.variant,
    manifest,
    sidecar,
    extractionAuthority,
    dataDir: input.dataDir,
    pinnedMetaRoot: input.pinnedMetaRoot
  });
  return {
    snapshotDbPath,
    manifest,
    sidecar,
    extractionAuthority,
    snapshotManifestSha256: bound.manifestSha256,
    ...authority
  };
}

function requireCurrentRoot(value: string | undefined): string {
  if (value === undefined) {
    throw new Error("current snapshot loading requires an owned immutable root");
  }
  return value;
}
