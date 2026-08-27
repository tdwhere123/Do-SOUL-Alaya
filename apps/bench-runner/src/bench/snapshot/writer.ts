import { basename, resolve } from "node:path";
import type { SeedExtractionPath } from "@do-soul/alaya-eval";
import { SNAPSHOT_SEED_IDENTITY, resolveBenchRunnerVersion } from "../../shared/version.js";
import type { LongMemEvalQuestion, LongMemEvalVariant } from "../../longmemeval/ingestion/dataset.js";
import type { LongMemEvalRunProvenance } from "../provenance/run.js";
import {
  BENCH_DAEMON_DB_FILENAME,
  RECALL_EVAL_SNAPSHOT_MANIFEST_VERSION,
  checkpointAndCopyBenchDb,
  snapshotQuestionIdDigest,
  snapshotExtractionAuthorityPath,
  writeSnapshotManifest,
  writeSnapshotSidecar,
  type LongMemEvalSnapshotQuestion,
  type LongMemEvalSnapshotSidecarFile,
  type SnapshotExtractionProvenanceV3
} from "./materialize.js";
import { readSchemaMigrationVersion } from "./snapshot-seed-identity.js";
import { deriveSnapshotAttribution } from "./attribution.js";
import {
  assertCurrentPostFillCacheAuthorityProofManifest,
  assertCurrentSnapshotWriteAuthority,
  type SnapshotWriteAuthority
} from "./current/current-substrate-authority.js";
import { assertSnapshotAnswersWithFormation } from
  "./current/snapshot-answers-with-formation.js";
import { buildSnapshotArtifactIntegrity } from "./integrity.js";
import {
  MAX_SNAPSHOT_EXTRACTION_AUTHORITY_BYTES,
  assertSnapshotExtractionAuthorityBinding,
  captureSnapshotExtractionAuthority,
  parseSnapshotExtractionAuthorityBytes
} from "./extraction-authority.js";
import { readRegularFileNoFollow, sha256Buffer } from "./bound-file.js";
import { compactSnapshotRunProvenance } from "./run-provenance.js";
import type { SourceAssertionSupplementBinding } from
  "../extraction/cache/semantic-supplement/source-assertion-supplement.js";
import { assertRelationProjectionCurrent, initDatabase } from
  "@do-soul/alaya-storage";
import { persistSnapshotExtractionAuthority } from
  "./freeze/extraction-authority-publisher.js";
import { withSnapshotPublishLock } from "./freeze/publish-lock.js";
import type { ExtractionCachePreflightProof } from
  "../compile-seed/compile-seed-types.js";
import { assertCurrentSnapshotVerifiedAssertionReceiptIntegrity } from
  "./current/assertion-receipt-integrity.js";

export interface WriteRecallEvalSnapshotInput {
  readonly snapshotOut: string;
  readonly seedDataDirRoot: string;
  readonly variant: LongMemEvalVariant;
  readonly commitSha7: string;
  readonly canonicalQuestions: readonly LongMemEvalQuestion[];
  readonly snapshotQuestions: readonly LongMemEvalSnapshotQuestion[];
  readonly extractionCacheRoot: string;
  readonly extractionCachePreflightProof: ExtractionCachePreflightProof;
  readonly datasetSha256: string;
  readonly seedExtractionPath: SeedExtractionPath;
  readonly runProvenance: LongMemEvalRunProvenance;
  readonly semanticSupplementBinding?: SourceAssertionSupplementBinding;
  readonly snapshotWriteAuthority?: SnapshotWriteAuthority;
}

interface SnapshotArtifactWritePreparation {
  readonly captured: ReturnType<typeof captureSnapshotExtractionAuthority>;
  readonly extraction: SnapshotExtractionProvenanceV3;
  readonly sidecar: LongMemEvalSnapshotSidecarFile;
  readonly questionDigest: string;
  readonly datasetSha: string;
  readonly graphPreflight: ReturnType<typeof assertSnapshotAnswersWithFormation>;
  readonly schemaMigrationVersion: number;
}

export async function writeRecallEvalSnapshotArtifacts(
  input: WriteRecallEvalSnapshotInput
): Promise<void> {
  await withSnapshotPublishLock(input.snapshotOut, async () => {
    await writeRecallEvalSnapshotArtifactsUnlocked(input);
  });
}

async function writeRecallEvalSnapshotArtifactsUnlocked(
  input: WriteRecallEvalSnapshotInput
): Promise<void> {
  const liveDbPath = resolve(input.seedDataDirRoot, BENCH_DAEMON_DB_FILENAME);
  const prepared = prepareSnapshotArtifactWrite(input, liveDbPath);
  const authorityPath = snapshotExtractionAuthorityPath(input.snapshotOut);
  persistSnapshotExtractionAuthority(authorityPath, prepared.captured.bytes);
  const persistedAuthority = readPersistedAuthority(
    authorityPath,
    prepared.captured.bytes,
    prepared.extraction
  );
  checkpointAndCopyBenchDb(liveDbPath, input.snapshotOut);
  assertCurrentSnapshotVerifiedAssertionReceiptIntegrity(input.snapshotOut);
  writeSnapshotSidecar(input.snapshotOut, prepared.sidecar);
  assertPreparedWriteAuthority(input, prepared, input.snapshotOut, persistedAuthority);
  const integrity = await buildSnapshotArtifactIntegrity(input.snapshotOut);
  assertCapturedAuthorityIntegrity(integrity, authorityPath, prepared.captured.bytes);
  writeSnapshotManifest(input.snapshotOut, buildManifest({
    input, integrity,
    schemaMigrationVersion: prepared.schemaMigrationVersion,
    extraction: prepared.extraction,
    datasetSha: prepared.datasetSha,
    questionDigest: prepared.questionDigest,
    graphPreflight: prepared.graphPreflight
  }));
}

function prepareSnapshotArtifactWrite(
  input: WriteRecallEvalSnapshotInput,
  liveDbPath: string
): SnapshotArtifactWritePreparation {
  assertRelationProjectionCurrent(initDatabase({ filename: liveDbPath }));
  assertCurrentSnapshotVerifiedAssertionReceiptIntegrity(liveDbPath);
  const captured = captureSnapshotExtractionAuthority(input.extractionCacheRoot);
  assertCurrentPostFillCacheAuthorityProofManifest({
    proof: input.extractionCachePreflightProof,
    cacheRoot: input.extractionCacheRoot,
    manifestSha256: captured.compact.manifest_sha256
  });
  const extraction = captured.compact;
  const sidecar = buildSidecar(input);
  const questionDigest = snapshotQuestionIdDigest(input.snapshotQuestions);
  const datasetSha = resolveSnapshotDatasetSha(input, extraction, questionDigest);
  const prepared = {
    captured,
    extraction,
    sidecar,
    questionDigest,
    datasetSha,
    graphPreflight: assertSnapshotAnswersWithFormation(liveDbPath, input.snapshotQuestions),
    schemaMigrationVersion: readSchemaMigrationVersion(liveDbPath)
  };
  assertPreparedWriteAuthority(input, prepared, liveDbPath, captured.authority);
  return prepared;
}

function assertPreparedWriteAuthority(
  input: WriteRecallEvalSnapshotInput,
  prepared: SnapshotArtifactWritePreparation,
  dbPath: string,
  extractionAuthority: ReturnType<typeof captureSnapshotExtractionAuthority>["authority"]
): void {
  assertCurrentSnapshotWriteAuthority({
    dbPath,
    sidecar: prepared.sidecar,
    canonicalQuestions: input.canonicalQuestions,
    extraction: prepared.extraction,
    extractionAuthority,
    seedExtractionPath: input.seedExtractionPath,
    runProvenance: input.runProvenance,
    datasetSha256: prepared.datasetSha,
    ...(input.semanticSupplementBinding === undefined ? {} : {
      semanticSupplementBinding: input.semanticSupplementBinding
    }),
    ...(input.snapshotWriteAuthority === undefined ? {} : {
      snapshotWriteAuthority: input.snapshotWriteAuthority
    })
  });
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
  readonly graphPreflight: ReturnType<typeof assertSnapshotAnswersWithFormation>;
}) {
  const { input } = context;
  const runProvenance = compactSnapshotRunProvenance(input.runProvenance);
  return {
    schema_version: RECALL_EVAL_SNAPSHOT_MANIFEST_VERSION,
    variant: input.variant,
    question_count: input.snapshotQuestions.length,
    recall_pipeline_version: SNAPSHOT_SEED_IDENTITY,
    schema_migration_version: context.schemaMigrationVersion,
    bench_runner_version: resolveBenchRunnerVersion(),
    alaya_commit: input.commitSha7,
    db_filename: basename(input.snapshotOut),
    sidecar_filename: `${basename(input.snapshotOut)}.sidecar.json`,
    built_at: new Date().toISOString(),
    extraction_provenance: context.extraction,
    ...(input.semanticSupplementBinding === undefined ? {} : {
      semantic_supplement_receipt: input.semanticSupplementBinding
    }),
    seed_extraction_path: input.seedExtractionPath,
    artifact_integrity: context.integrity,
    run_provenance: runProvenance,
    question_id_digest: context.questionDigest,
    dataset_sha256: context.datasetSha,
    graph_preflight: context.graphPreflight,
    attribution: deriveSnapshotAttribution({
      artifactIntegrity: context.integrity,
      runProvenance,
      questionIdDigest: context.questionDigest,
      datasetSha256: context.datasetSha,
      seedExtractionPath: input.seedExtractionPath,
      extractionProvenance: context.extraction,
      ...(input.snapshotWriteAuthority === undefined ? {} : {
        snapshotWriteAuthority: input.snapshotWriteAuthority
      })
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
