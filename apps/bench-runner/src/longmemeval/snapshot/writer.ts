import { basename, resolve } from "node:path";
import { RECALL_PIPELINE_VERSION, resolveBenchRunnerVersion } from "../../shared/version.js";
import {
  readExtractionCacheManifestIdentity
} from "../extraction-cache-manifest.js";
import type { LongMemEvalVariant } from "../dataset.js";
import { redactProvenanceUrl, type LongMemEvalRunProvenance } from "../provenance/run.js";
import {
  BENCH_DAEMON_DB_FILENAME,
  RECALL_EVAL_SNAPSHOT_MANIFEST_VERSION,
  checkpointAndCopyBenchDb,
  readSchemaMigrationVersion,
  snapshotQuestionIdDigest,
  writeSnapshotManifest,
  writeSnapshotSidecar,
  type LongMemEvalSnapshotQuestion,
  type SnapshotExtractionProvenance
} from "../snapshot.js";
import { deriveSnapshotAttribution } from "./attribution.js";
import { buildSnapshotArtifactIntegrity } from "./integrity.js";

export interface WriteRecallEvalSnapshotInput {
  readonly snapshotOut: string;
  readonly seedDataDirRoot: string;
  readonly variant: LongMemEvalVariant;
  readonly commitSha7: string;
  readonly snapshotQuestions: readonly LongMemEvalSnapshotQuestion[];
  readonly extractionCacheRoot: string;
  readonly datasetSha256: string;
  readonly runProvenance: LongMemEvalRunProvenance;
}

export async function writeRecallEvalSnapshotArtifacts(
  input: WriteRecallEvalSnapshotInput
): Promise<void> {
  const liveDbPath = resolve(input.seedDataDirRoot, BENCH_DAEMON_DB_FILENAME);
  const schemaMigrationVersion = readSchemaMigrationVersion(liveDbPath);
  checkpointAndCopyBenchDb(liveDbPath, input.snapshotOut);
  const extraction = buildExtractionProvenance(input.extractionCacheRoot);
  writeSnapshotSidecar(input.snapshotOut, {
    schema_version: RECALL_EVAL_SNAPSHOT_MANIFEST_VERSION,
    variant: input.variant,
    questions: input.snapshotQuestions
  });
  const integrity = await buildSnapshotArtifactIntegrity(input.snapshotOut);
  const datasetSha = resolveSnapshotDatasetSha(input, extraction);
  const questionDigest = snapshotQuestionIdDigest(input.snapshotQuestions);
  writeSnapshotManifest(input.snapshotOut, buildManifest({
    input, schemaMigrationVersion, extraction, integrity, datasetSha, questionDigest
  }));
}

function buildExtractionProvenance(root: string): SnapshotExtractionProvenance | null {
  const identity = readExtractionCacheManifestIdentity(root);
  if (identity === undefined) return null;
  const { manifest } = identity;
  const common = {
    manifest_sha256: identity.manifestSha256,
    extraction_model: manifest.extraction_model,
    provider_url: redactProvenanceUrl(manifest.provider_url),
    system_prompt_sha256: manifest.system_prompt_sha256,
    cache_key_algo: manifest.cache_key_algo,
    dataset: manifest.dataset,
    dataset_revision: manifest.dataset_revision,
    ...(manifest.coverage === undefined ? {} : { coverage: manifest.coverage }),
    ...(manifest.cached_turns === undefined ? {} : { cached_turns: manifest.cached_turns }),
    ...(manifest.requested_turns === undefined ? {} : { requested_turns: manifest.requested_turns })
  };
  if (manifest.schema_version === 1) {
    return { ...common, schema_version: 1 };
  }
  if (manifest.schema_version === 2) {
    return { ...common, schema_version: 2, model_family: manifest.model_family };
  }
  return {
    ...common,
    schema_version: manifest.schema_version,
    model_family: manifest.model_family,
    request_profile: manifest.request_profile
  };
}

function buildManifest(context: {
  readonly input: WriteRecallEvalSnapshotInput;
  readonly schemaMigrationVersion: number;
  readonly extraction: SnapshotExtractionProvenance | null;
  readonly integrity: Awaited<ReturnType<typeof buildSnapshotArtifactIntegrity>>;
  readonly datasetSha: string;
  readonly questionDigest: string;
}) {
  const { input } = context;
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
    artifact_integrity: context.integrity,
    run_provenance: input.runProvenance,
    question_id_digest: context.questionDigest,
    dataset_sha256: context.datasetSha,
    attribution: deriveSnapshotAttribution({
      artifactIntegrity: context.integrity,
      runProvenance: input.runProvenance,
      questionIdDigest: context.questionDigest,
      datasetSha256: context.datasetSha,
      extractionProvenance: context.extraction
    })
  };
}

function resolveSnapshotDatasetSha(
  input: WriteRecallEvalSnapshotInput,
  extraction: SnapshotExtractionProvenance | null
): string {
  if (!/^[a-f0-9]{64}$/u.test(input.datasetSha256)) {
    throw new Error("recall-eval snapshot requires a valid dataset SHA-256");
  }
  const provenanceSha = input.runProvenance.question_manifest?.dataset_sha256 ??
    extraction?.dataset_revision;
  if (provenanceSha !== undefined && /^[a-f0-9]{64}$/u.test(provenanceSha) &&
      provenanceSha !== input.datasetSha256) {
    throw new Error("recall-eval snapshot dataset provenance mismatch");
  }
  return input.datasetSha256;
}
