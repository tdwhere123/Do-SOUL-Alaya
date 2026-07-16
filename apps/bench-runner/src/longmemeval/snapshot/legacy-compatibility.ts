import {
  initDatabase,
  readSchemaMigrationLedger
} from "@do-soul/alaya-storage";
import { RECALL_PIPELINE_VERSION } from "../../shared/version.js";
import type { LongMemEvalSnapshotManifest } from "../snapshot.js";

const PRODUCER_PIPELINE = "fusion-rrf-synthesis-v2";
const CONSUMER_PIPELINE = "fusion-evidence-first-v3";
const PRODUCER_SCHEMA = 103;
const CONSUMER_SCHEMA = 107;
const HISTORICAL_GAPS = new Set([70, 75]);

export function assertLegacySnapshotSourceCompatibility(
  manifest: LongMemEvalSnapshotManifest,
  snapshotDbPath: string
): void {
  assertCompatibilityTuple(manifest);
  assertExactLedger(
    readSchemaMigrationLedger(snapshotDbPath),
    expectedLedger(PRODUCER_SCHEMA),
    "producer"
  );
}

export function prepareLegacySnapshotConsumer(
  manifest: LongMemEvalSnapshotManifest,
  restoredDbPath: string
): void {
  assertCompatibilityTuple(manifest);
  initDatabase({ filename: restoredDbPath });
  assertExactLedger(
    readSchemaMigrationLedger(restoredDbPath),
    expectedLedger(CONSUMER_SCHEMA),
    "consumer"
  );
}

function assertCompatibilityTuple(manifest: LongMemEvalSnapshotManifest): void {
  if (manifest.schema_version !== 1 ||
      manifest.recall_pipeline_version !== PRODUCER_PIPELINE ||
      manifest.schema_migration_version !== PRODUCER_SCHEMA ||
      RECALL_PIPELINE_VERSION !== CONSUMER_PIPELINE) {
    throw new Error("legacy snapshot producer-to-consumer compatibility mismatch");
  }
}

function expectedLedger(maxVersion: number): readonly number[] {
  return Array.from({ length: maxVersion }, (_, index) => index + 1)
    .filter((version) => !HISTORICAL_GAPS.has(version));
}

function assertExactLedger(
  actual: readonly number[],
  expected: readonly number[],
  role: string
): void {
  if (actual.length !== expected.length ||
      actual.some((version, index) => version !== expected[index])) {
    throw new Error(`legacy snapshot ${role} migration ledger mismatch`);
  }
}
