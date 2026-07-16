import { basename, dirname, resolve } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import type { SeedExtractionPath } from "@do-soul/alaya-eval";
import { RECALL_PIPELINE_VERSION, resolveBenchRunnerVersion } from "../../shared/version.js";
import type { LongMemEvalQuestion, LongMemEvalVariant } from "../dataset.js";
import type { LongMemEvalRunProvenance } from "../provenance/run.js";
import {
  BENCH_DAEMON_DB_FILENAME,
  RECALL_EVAL_SNAPSHOT_MANIFEST_VERSION,
  checkpointAndCopyBenchDb,
  readSchemaMigrationVersion,
  snapshotQuestionIdDigest,
  snapshotExtractionAuthorityPath,
  writeSnapshotManifest,
  writeSnapshotSidecar,
  type LongMemEvalSnapshotQuestion,
  type LongMemEvalSnapshotSidecarFile,
  type SnapshotExtractionProvenanceV3
} from "../snapshot.js";
import { deriveSnapshotAttribution } from "./attribution.js";
import {
  assertCurrentSnapshotWriteAuthority
} from "./current-substrate-authority.js";
import { buildSnapshotArtifactIntegrity } from "./integrity.js";
import {
  MAX_SNAPSHOT_EXTRACTION_AUTHORITY_BYTES,
  assertSnapshotExtractionAuthorityBinding,
  captureSnapshotExtractionAuthority,
  parseSnapshotExtractionAuthorityBytes
} from "./extraction-authority.js";
import { readRegularFileNoFollow, sha256Buffer } from "./bound-file.js";
import { compactSnapshotRunProvenance } from "./run-provenance.js";

export interface WriteRecallEvalSnapshotInput {
  readonly snapshotOut: string;
  readonly seedDataDirRoot: string;
  readonly variant: LongMemEvalVariant;
  readonly commitSha7: string;
  readonly canonicalQuestions: readonly LongMemEvalQuestion[];
  readonly snapshotQuestions: readonly LongMemEvalSnapshotQuestion[];
  readonly extractionCacheRoot: string;
  readonly datasetSha256: string;
  readonly seedExtractionPath: SeedExtractionPath;
  readonly runProvenance: LongMemEvalRunProvenance;
}

export async function writeRecallEvalSnapshotArtifacts(
  input: WriteRecallEvalSnapshotInput
): Promise<void> {
  const liveDbPath = resolve(input.seedDataDirRoot, BENCH_DAEMON_DB_FILENAME);
  const captured = captureSnapshotExtractionAuthority(input.extractionCacheRoot);
  const extraction = captured.compact;
  const sidecar = buildSidecar(input);
  const questionDigest = snapshotQuestionIdDigest(input.snapshotQuestions);
  const datasetSha = resolveSnapshotDatasetSha(input, extraction, questionDigest);
  assertCurrentSnapshotWriteAuthority({
    dbPath: liveDbPath,
    sidecar,
    canonicalQuestions: input.canonicalQuestions,
    extraction,
    extractionAuthority: captured.authority,
    seedExtractionPath: input.seedExtractionPath,
    runProvenance: input.runProvenance,
    datasetSha256: datasetSha
  });
  const schemaMigrationVersion = readSchemaMigrationVersion(liveDbPath);
  const authorityPath = snapshotExtractionAuthorityPath(input.snapshotOut);
  mkdirSync(dirname(authorityPath), { recursive: true });
  writeFileSync(authorityPath, captured.bytes, {
    flag: "wx",
    mode: 0o400
  });
  const persistedAuthority = readPersistedAuthority(
    authorityPath,
    captured.bytes,
    extraction
  );
  checkpointAndCopyBenchDb(liveDbPath, input.snapshotOut);
  writeSnapshotSidecar(input.snapshotOut, sidecar);
  assertCurrentSnapshotWriteAuthority({
    dbPath: input.snapshotOut,
    sidecar,
    canonicalQuestions: input.canonicalQuestions,
    extraction,
    extractionAuthority: persistedAuthority,
    seedExtractionPath: input.seedExtractionPath,
    runProvenance: input.runProvenance,
    datasetSha256: datasetSha
  });
  const integrity = await buildSnapshotArtifactIntegrity(input.snapshotOut);
  assertCapturedAuthorityIntegrity(integrity, authorityPath, captured.bytes);
  writeSnapshotManifest(input.snapshotOut, buildManifest({
    input, schemaMigrationVersion, extraction, integrity, datasetSha, questionDigest
  }));
}

function assertCapturedAuthorityIntegrity(
  integrity: Awaited<ReturnType<typeof buildSnapshotArtifactIntegrity>>,
  filePath: string,
  expectedBytes: Buffer
): void {
  if (integrity.extraction_authority_filename !== basename(filePath) ||
      integrity.extraction_authority_sha256 !== sha256Buffer(expectedBytes) ||
      integrity.extraction_authority_bytes !== expectedBytes.byteLength) {
    throw new Error("snapshot extraction authority changed before manifest binding");
  }
}

function buildSidecar(input: WriteRecallEvalSnapshotInput): LongMemEvalSnapshotSidecarFile {
  return {
    schema_version: RECALL_EVAL_SNAPSHOT_MANIFEST_VERSION,
    variant: input.variant,
    questions: input.snapshotQuestions
  };
}

function buildManifest(context: {
  readonly input: WriteRecallEvalSnapshotInput;
  readonly schemaMigrationVersion: number;
  readonly extraction: SnapshotExtractionProvenanceV3;
  readonly integrity: Awaited<ReturnType<typeof buildSnapshotArtifactIntegrity>>;
  readonly datasetSha: string;
  readonly questionDigest: string;
}) {
  const { input } = context;
  const runProvenance = compactSnapshotRunProvenance(input.runProvenance);
  return {
    schema_version: RECALL_EVAL_SNAPSHOT_MANIFEST_VERSION,
    variant: input.variant,
    question_count: input.snapshotQuestions.length,
    recall_pipeline_version: RECALL_PIPELINE_VERSION,
    schema_migration_version: context.schemaMigrationVersion,
    bench_runner_version: resolveBenchRunnerVersion(),
    alaya_commit: input.commitSha7,
    db_filename: basename(input.snapshotOut),
    sidecar_filename: `${basename(input.snapshotOut)}.sidecar.json`,
    built_at: new Date().toISOString(),
    extraction_provenance: context.extraction,
    seed_extraction_path: input.seedExtractionPath,
    artifact_integrity: context.integrity,
    run_provenance: runProvenance,
    question_id_digest: context.questionDigest,
    dataset_sha256: context.datasetSha,
    attribution: deriveSnapshotAttribution({
      artifactIntegrity: context.integrity,
      runProvenance,
      questionIdDigest: context.questionDigest,
      datasetSha256: context.datasetSha,
      seedExtractionPath: input.seedExtractionPath,
      extractionProvenance: context.extraction
    })
  };
}

function readPersistedAuthority(
  filePath: string,
  expectedBytes: Buffer,
  extraction: SnapshotExtractionProvenanceV3
) {
  const bytes = readRegularFileNoFollow(
    filePath,
    MAX_SNAPSHOT_EXTRACTION_AUTHORITY_BYTES
  );
  if (!bytes.equals(expectedBytes)) {
    throw new Error("persisted snapshot extraction authority differs from capture");
  }
  const authority = parseSnapshotExtractionAuthorityBytes(bytes, filePath);
  assertSnapshotExtractionAuthorityBinding(authority, extraction);
  return authority;
}

function resolveSnapshotDatasetSha(
  input: WriteRecallEvalSnapshotInput,
  extraction: SnapshotExtractionProvenanceV3,
  questionDigest: string
): string {
  if (!/^[a-f0-9]{64}$/u.test(input.datasetSha256)) {
    throw new Error("recall-eval snapshot requires a valid dataset SHA-256");
  }
  const provenanceSha = input.runProvenance.dataset_sha256 ??
    input.runProvenance.question_manifest?.dataset_sha256 ??
    extraction?.dataset_revision;
  if (provenanceSha !== undefined && /^[a-f0-9]{64}$/u.test(provenanceSha) &&
      provenanceSha !== input.datasetSha256) {
    throw new Error("recall-eval snapshot dataset provenance mismatch");
  }
  const selection = input.runProvenance.selection;
  if (selection !== undefined && (
    selection.dataset_sha256 !== input.datasetSha256 ||
    selection.selected_id_digest !== questionDigest ||
    selection.selected_count !== input.snapshotQuestions.length
  )) {
    throw new Error("recall-eval snapshot selection provenance mismatch");
  }
  return input.datasetSha256;
}
