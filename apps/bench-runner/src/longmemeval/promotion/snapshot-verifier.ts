import { createHash } from "node:crypto";
import { mkdtemp, open, rm } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { tmpdir } from "node:os";
import path from "node:path";
import { isCacheOnlySeedExtractionPath } from "@do-soul/alaya-eval";
import { readSchemaMigrationLedger } from "@do-soul/alaya-storage";
import {
  openContainedArtifact,
  type ContainedArtifactFile
} from "../../cli/merge/contained-artifact-path.js";
import { createArtifactReadStream } from "../diagnostics/artifact-utf8.js";
import type { LongMemEvalQuestion } from "../dataset.js";
import {
  assertSnapshotConsumerBinding,
  type LongMemEvalSnapshotSidecarFile
} from "../snapshot.js";
import { validateSnapshotManifest } from "../snapshot/manifest-validation.js";
import { parseSnapshotSidecar } from "../snapshot/sidecar-validation.js";
import { assertSnapshotDatasetSubstrateIdentity } from
  "../snapshot/substrate-binding.js";
import { assertSnapshotSeedLedgerBinding } from
  "../snapshot/seed-ledger-binding.js";
import {
  buildSnapshotMeasurementOracle,
  type SnapshotMeasurementOracleAccessor
} from "../snapshot/measurement-oracle.js";
import type {
  LongMemEvalMatrixPromotionContract
} from "./contract.js";
import type { LongMemEvalSelectionContractIdentity } from
  "../selection/contract.js";
import { RECALL_PIPELINE_VERSION } from "../../shared/version.js";
import { assertPromotionSnapshotProducerPolicy } from
  "./snapshot-producer-policy-verifier.js";
import {
  MAX_SNAPSHOT_EXTRACTION_AUTHORITY_BYTES,
  assertSnapshotExtractionAuthorityBinding,
  parseSnapshotExtractionAuthorityBytes,
  type SnapshotExtractionAuthority
} from "../snapshot/extraction-authority.js";
import {
  bindSnapshotRunProvenanceAuthority
} from "../snapshot/run-provenance.js";
import {
  isLongMemEvalRunProvenanceGateEligible,
  type LongMemEvalRunProvenance
} from "../provenance/run.js";
import {
  MAX_SNAPSHOT_MANIFEST_BYTES,
  MAX_SNAPSHOT_SIDECAR_BYTES
} from "../snapshot/artifact-limits.js";

declare const verifiedSnapshotBrand: unique symbol;

export interface VerifiedPromotionSnapshot {
  readonly [verifiedSnapshotBrand]: true;
}

export interface VerifiedPromotionSnapshotData {
  readonly manifestSha256: string;
  readonly dbSha256: string;
  readonly sidecarSha256: string;
  readonly goldForQuestion: (questionId: string) => readonly string[] | undefined;
  readonly measurementForQuestion: SnapshotMeasurementOracleAccessor;
  readonly producerGateSha256: string;
  readonly producerExtractionCacheJson: string;
  readonly recallPipelineVersion: string;
  readonly schemaMigrationVersion: number;
}

const verifiedSnapshots = new WeakMap<object, VerifiedPromotionSnapshotData>();

type SnapshotInput = Parameters<typeof verifyPromotionSnapshot>[0];
type SnapshotReferences = ReturnType<typeof snapshotReferences>;
interface OpenSnapshotArtifacts {
  readonly db: ContainedArtifactFile;
  readonly manifest: ContainedArtifactFile;
  readonly sidecar: ContainedArtifactFile;
  readonly extractionAuthority: ContainedArtifactFile;
}

export async function verifyPromotionSnapshot(input: {
  readonly contractRoot: string;
  readonly snapshot: LongMemEvalMatrixPromotionContract["snapshot"];
  readonly expectedSelection: LongMemEvalSelectionContractIdentity;
  readonly expectedQuestions: readonly LongMemEvalQuestion[];
  readonly variant: "longmemeval_s";
  readonly code: LongMemEvalMatrixPromotionContract["code"];
}): Promise<VerifiedPromotionSnapshot> {
  const references = snapshotReferences(input.snapshot.db_path);
  const [db, manifestFile, sidecarFile, extractionAuthority] = await Promise.all([
    requireContainedFile(input.contractRoot, references.db),
    requireContainedFile(input.contractRoot, references.manifest),
    requireContainedFile(input.contractRoot, references.sidecar),
    requireContainedFile(input.contractRoot, references.extractionAuthority)
  ]);
  try {
    return await verifyOpenSnapshot(input, references, {
      db,
      manifest: manifestFile,
      sidecar: sidecarFile,
      extractionAuthority
    });
  } finally {
    await Promise.all([
      db.close(), manifestFile.close(), sidecarFile.close(), extractionAuthority.close()
    ]);
  }
}

async function verifyOpenSnapshot(
  input: SnapshotInput,
  references: SnapshotReferences,
  files: OpenSnapshotArtifacts
): Promise<VerifiedPromotionSnapshot> {
  const evidence = await readOpenSnapshotEvidence(input, references, files);
  const database = await inspectImmutableDatabaseCopy({
    file: files.db,
    sidecar: evidence.sidecar,
    questions: input.expectedQuestions,
    extraction: evidence.manifest.extraction_provenance,
    extractionAuthority: evidence.extractionAuthority,
    seedExtractionPath: evidence.manifest.seed_extraction_path
  });
  assertSnapshotIdentity({
    ...input, dbPath: path.resolve(input.contractRoot, references.db),
    manifest: evidence.manifest, sidecar: evidence.sidecar,
    manifestSha256: evidence.manifestSha256, dbSha256: database.sha256,
    sidecarSha256: evidence.sidecarSha256,
    schemaMigrationVersion: database.schemaMigrationVersion,
    runProvenance: evidence.runProvenance
  });
  return sealVerifiedSnapshot(
    evidence.manifest, evidence.sidecar, input.expectedQuestions,
    evidence.manifestSha256, evidence.sidecarSha256, database,
    evidence.runProvenance
  );
}

async function readOpenSnapshotEvidence(
  input: SnapshotInput,
  references: SnapshotReferences,
  files: OpenSnapshotArtifacts
) {
  const manifestBytes = await files.manifest.readBytes(MAX_SNAPSHOT_MANIFEST_BYTES);
  const manifestSha256 = sha256(manifestBytes);
  if (manifestSha256 !== input.snapshot.manifest_sha256) {
    throw new Error("promotion snapshot manifest differs from frozen contract");
  }
  const manifest = validateSnapshotManifest(
    parseJson(manifestBytes, references.manifest), references.manifest
  );
  const authorityBytes = await files.extractionAuthority.readBytes(
    MAX_SNAPSHOT_EXTRACTION_AUTHORITY_BYTES
  );
  const extractionBinding = verifyExtractionAuthority(
    manifest,
    references.extractionAuthority,
    authorityBytes
  );
  const extractionAuthority = extractionBinding.authority;
  const sidecarBytes = await files.sidecar.readBytes(MAX_SNAPSHOT_SIDECAR_BYTES);
  const sidecarSha256 = sha256(sidecarBytes);
  const sidecar = parseSnapshotSidecar(
    parseJson(sidecarBytes, references.sidecar), references.sidecar, manifest.schema_version
  );
  return {
    manifest, manifestSha256, extractionAuthority, sidecar, sidecarSha256,
    runProvenance: extractionBinding.runProvenance
  };
}

function sealVerifiedSnapshot(
  manifest: Parameters<typeof assertSnapshotConsumerBinding>[0]["manifest"],
  sidecar: LongMemEvalSnapshotSidecarFile,
  questions: readonly LongMemEvalQuestion[],
  manifestSha256: string,
  sidecarSha256: string,
  database: { readonly sha256: string; readonly schemaMigrationVersion: number },
  provenance: LongMemEvalRunProvenance
): VerifiedPromotionSnapshot {
  const measurementForQuestion = buildSnapshotMeasurementOracle(questions, sidecar);
  const snapshot = Object.freeze({}) as VerifiedPromotionSnapshot;
  verifiedSnapshots.set(snapshot, Object.freeze({
    manifestSha256, dbSha256: database.sha256, sidecarSha256,
    goldForQuestion: Object.freeze((questionId: string) =>
      measurementForQuestion(questionId)?.goldMemoryIds),
    measurementForQuestion,
    producerGateSha256: provenance.code.gate_sha256!,
    producerExtractionCacheJson: JSON.stringify(provenance.extraction_cache),
    recallPipelineVersion: manifest.recall_pipeline_version,
    schemaMigrationVersion: database.schemaMigrationVersion
  }));
  return snapshot;
}

export function verifiedPromotionSnapshotData(
  snapshot: VerifiedPromotionSnapshot
): VerifiedPromotionSnapshotData {
  const data = verifiedSnapshots.get(snapshot);
  if (data === undefined) throw new Error("promotion snapshot is not verified");
  return data;
}

function assertSnapshotIdentity(input: {
  readonly dbPath: string;
  readonly manifest: Parameters<typeof assertSnapshotConsumerBinding>[0]["manifest"];
  readonly sidecar: LongMemEvalSnapshotSidecarFile;
  readonly manifestSha256: string;
  readonly dbSha256: string;
  readonly sidecarSha256: string;
  readonly schemaMigrationVersion: number;
  readonly expectedSelection: LongMemEvalSelectionContractIdentity;
  readonly variant: "longmemeval_s";
  readonly code: LongMemEvalMatrixPromotionContract["code"];
  readonly runProvenance: LongMemEvalRunProvenance;
}): void {
  const { manifest, expectedSelection } = input;
  const provenance = input.runProvenance;
  assertSnapshotConsumerBinding({
    snapshotDbPath: input.dbPath,
    manifest,
    sidecar: input.sidecar,
    variant: input.variant
  });
  assertPromotionSnapshotProducerPolicy(provenance);
  if (manifest.attribution?.status !== "attributed" ||
      manifest.attribution.gate_eligible !== true ||
      manifest.artifact_integrity === undefined ||
      manifest.artifact_integrity.db_sha256 !== input.dbSha256 ||
      manifest.artifact_integrity.sidecar_sha256 !== input.sidecarSha256 ||
      manifest.dataset_sha256 !== expectedSelection.dataset_sha256 ||
      manifest.question_count !== expectedSelection.selected_count ||
      manifest.question_id_digest !== expectedSelection.selected_id_digest ||
      !isCacheOnlySeedExtractionPath(manifest.seed_extraction_path) ||
      !isDeepStrictEqual(provenance.selection, expectedSelection) ||
      manifest.recall_pipeline_version !== RECALL_PIPELINE_VERSION ||
      manifest.schema_migration_version !== input.schemaMigrationVersion ||
      provenance.code.commit_sha !== input.code.commit_sha ||
      provenance.code.commit_sha7 !== input.code.commit_sha7 ||
      provenance.code.worktree_state_sha256 !==
        input.code.worktree_state_sha256 ||
      !isDeepStrictEqual(
        provenance.code.executed_dist,
        input.code.executed_dist
      )) {
    throw new Error("promotion snapshot identity is incomplete or drifted");
  }
}

function snapshotReferences(dbPath: string) {
  return {
    db: dbPath,
    manifest: `${dbPath}.manifest.json`,
    sidecar: `${dbPath}.sidecar.json`,
    extractionAuthority: `${dbPath}.extraction-authority.json`
  };
}

async function requireContainedFile(
  root: string,
  reference: string
): Promise<ContainedArtifactFile> {
  const file = await openContainedArtifact(root, reference);
  if (file === null) throw new Error(`missing promotion snapshot artifact: ${reference}`);
  return file;
}

async function inspectImmutableDatabaseCopy(input: {
  readonly file: ContainedArtifactFile;
  readonly sidecar: LongMemEvalSnapshotSidecarFile;
  readonly questions: readonly LongMemEvalQuestion[];
  readonly extraction: Parameters<typeof assertSnapshotSeedLedgerBinding>[0]["extraction"];
  readonly extractionAuthority: SnapshotExtractionAuthority;
  readonly seedExtractionPath: Parameters<typeof assertSnapshotSeedLedgerBinding>[0]["seedExtractionPath"];
}): Promise<{
  readonly sha256: string;
  readonly schemaMigrationVersion: number;
}> {
  const directory = await mkdtemp(path.join(tmpdir(), "alaya-promotion-snapshot-"));
  const copyPath = path.join(directory, "snapshot.sqlite");
  const copy = await open(copyPath, "wx", 0o600);
  try {
    const sha256 = await copyImmutableDatabase(input.file, copy);
    const schemaMigrationVersion = readSchemaMigrationLedger(copyPath).at(-1);
    if (schemaMigrationVersion === undefined) {
      throw new Error("promotion snapshot migration ledger is empty");
    }
    assertSnapshotDatasetSubstrateIdentity({
      dbPath: copyPath,
      sidecar: input.sidecar,
      questions: input.questions
    });
    assertSnapshotSeedLedgerBinding({
      dbPath: copyPath,
      sidecar: input.sidecar,
      questions: input.questions,
      extraction: input.extraction,
      extractionAuthority: input.extractionAuthority,
      seedExtractionPath: input.seedExtractionPath,
      closureAuthority: {
        kind: "exact",
        questionWindow: { offset: 0, limit: input.questions.length }
      }
    });
    return { sha256, schemaMigrationVersion };
  } finally {
    await copy.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
}

async function copyImmutableDatabase(
  source: ContainedArtifactFile,
  target: Awaited<ReturnType<typeof open>>
): Promise<string> {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createArtifactReadStream(source.handle)) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    await writeAll(target, value, bytes);
    bytes += value.byteLength;
    hash.update(value);
  }
  if (bytes !== source.bytes) {
    throw new Error("promotion snapshot DB changed while copying");
  }
  await target.sync();
  await target.close();
  return hash.digest("hex");
}

function verifyExtractionAuthority(
  manifest: Parameters<typeof assertSnapshotConsumerBinding>[0]["manifest"],
  reference: string,
  bytes: Uint8Array
): {
  readonly authority: SnapshotExtractionAuthority;
  readonly runProvenance: LongMemEvalRunProvenance;
} {
  const integrity = manifest.artifact_integrity;
  const extraction = manifest.extraction_provenance;
  if (integrity?.extraction_authority_filename !== path.basename(reference) ||
      integrity.extraction_authority_sha256 !== sha256(bytes) ||
      integrity.extraction_authority_bytes !== bytes.byteLength ||
      extraction?.schema_version !== 3) {
    throw new Error("promotion snapshot extraction authority differs from manifest");
  }
  const authority = parseSnapshotExtractionAuthorityBytes(bytes, reference);
  assertSnapshotExtractionAuthorityBinding(authority, extraction);
  const compactRunProvenance = manifest.run_provenance;
  if (compactRunProvenance === undefined) {
    throw new Error("promotion snapshot has no producer run provenance");
  }
  const runProvenance = bindSnapshotRunProvenanceAuthority(
    compactRunProvenance,
    authority
  );
  if (!isLongMemEvalRunProvenanceGateEligible(runProvenance)) {
    throw new Error("promotion snapshot run authority is incomplete");
  }
  return { authority, runProvenance };
}

async function writeAll(
  file: Awaited<ReturnType<typeof open>>,
  value: Buffer,
  position: number
): Promise<void> {
  let offset = 0;
  while (offset < value.byteLength) {
    const result = await file.write(value, offset, value.byteLength - offset, position + offset);
    if (result.bytesWritten === 0) throw new Error("promotion snapshot copy stalled");
    offset += result.bytesWritten;
  }
}

function parseJson(bytes: Uint8Array, label: string): unknown {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} is not valid UTF-8: ${detail}`);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} is not valid JSON: ${detail}`);
  }
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
