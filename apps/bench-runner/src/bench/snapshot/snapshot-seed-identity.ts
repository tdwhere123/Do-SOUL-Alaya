import {
  getCurrentSchemaSummary,
  initDatabase
} from "@do-soul/alaya-storage";
import { hashRegularFileNoFollow } from "./bound-file.js";
import type { LongMemEvalSnapshotManifest } from "./materialize.js";

export function readSchemaMigrationVersion(dbPath: string): number {
  const db = initDatabase({ filename: dbPath });
  const summary = getCurrentSchemaSummary(db);
  return summary.persistedMaxVersion ?? summary.knownMaxVersion;
}

export function assertSnapshotConsumeIdentity(input: {
  readonly manifest: LongMemEvalSnapshotManifest;
  readonly restoredDbPath: string;
  readonly runningSeedIdentity: string;
}): void {
  assertMatchingSeedIdentity(input.manifest, input.runningSeedIdentity);
  assertMatchingSchemaIdentity(input.manifest, input.restoredDbPath);
  assertMatchingSnapshotBytes(input.manifest, input.restoredDbPath);
  assertMatchingQuestionIdentity(input.manifest);
}

function assertMatchingSeedIdentity(
  manifest: LongMemEvalSnapshotManifest,
  runningSeedIdentity: string
): void {
  if (manifest.recall_pipeline_version !== runningSeedIdentity) {
    throw new Error(
      "[recall-eval] snapshot seed identity (recall_pipeline_version) " +
        `"${manifest.recall_pipeline_version}" != running binary ` +
        `"${runningSeedIdentity}". Seed/schema/FTS/temporal identity ` +
        "changed since the snapshot was seeded; rebuild the snapshot " +
        "(seed with --snapshot-out) before recall-eval."
    );
  }
}

function assertMatchingSchemaIdentity(
  manifest: LongMemEvalSnapshotManifest,
  restoredDbPath: string
): void {
  const restoredSchemaVersion = readSchemaMigrationVersion(restoredDbPath);
  if (restoredSchemaVersion !== manifest.schema_migration_version) {
    throw new Error(
      "[recall-eval] snapshot schema_migration_version " +
        `${manifest.schema_migration_version} != restored DB migration ` +
        `version ${restoredSchemaVersion}. The schema migrated since the ` +
        "snapshot was seeded; rebuild the snapshot before recall-eval."
    );
  }
}

function assertMatchingSnapshotBytes(
  manifest: LongMemEvalSnapshotManifest,
  restoredDbPath: string
): void {
  const expected = manifest.artifact_integrity?.db_sha256;
  if (expected === undefined) return;
  const actual = hashRegularFileNoFollow(restoredDbPath);
  if (actual !== expected) {
    throw new Error("recall-eval snapshot DB SHA-256 mismatch");
  }
}

function assertMatchingQuestionIdentity(manifest: LongMemEvalSnapshotManifest): void {
  const digest = manifest.question_id_digest;
  if (digest === undefined) return;
  if (!/^[a-f0-9]{64}$/u.test(digest)) {
    throw new Error("[recall-eval] snapshot question identity is invalid");
  }
}
