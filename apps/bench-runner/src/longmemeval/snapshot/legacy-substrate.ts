import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  LongMemEvalQuestionSchema,
  type LongMemEvalQuestion,
  type LongMemEvalVariant
} from "../dataset.js";
import { requireLongMemEvalTimestamp } from "../ingestion/source-time.js";
import {
  RECALL_EVAL_SNAPSHOT_MANIFEST_VERSION,
  BENCH_DAEMON_DB_FILENAME,
  snapshotManifestPath,
  snapshotSidecarPath,
  type LongMemEvalSnapshotManifest,
  type LongMemEvalSnapshotSidecarFile
} from "../snapshot.js";
import {
  copyRegularFileNoFollow,
  readRegularFileNoFollow,
  sha256Buffer
} from "./bound-file.js";
import { validateSnapshotManifest } from "./manifest-validation.js";
import { parseSnapshotSidecar } from "./sidecar-validation.js";

const LEGACY_PIPELINE = "fusion-rrf-synthesis-v2";
const LEGACY_MODEL = "deepseek-v4-flash";
const LEGACY_PROMPT_SHA =
  "9d3ad32c33028cd175d0941780f0c45f8357439a8f750c24accfd6385d2226a3";
const LEGACY_KEY_ALGO = "sha256(model\\0systemPrompt\\0turnContent)";
const LEGACY_CACHE_MANIFEST_SHA =
  "4d62f1ce27e5195081c0968732f47f4fa86963f6d6732e5b3b087b41250a5011";
const LEGACY_PROVIDER =
  "sha256:12b8deaccc34b32757dbb1497e029da0c2e7b26ffa86b9c926c08cb4692f4508";

export async function readLegacySnapshotBundle(input: {
  readonly snapshotDbPath: string;
  readonly variant: LongMemEvalVariant;
  readonly dataDir?: string;
  readonly pinnedMetaRoot?: string;
  readonly legacyManifestSha256?: string;
  readonly legacyDatasetSha256?: string;
}) {
  const expectedManifestSha = requireSha(input.legacyManifestSha256, "legacy manifest");
  const expectedDatasetSha = requireSha(input.legacyDatasetSha256, "legacy dataset");
  if (input.dataDir === undefined) {
    throw new Error("legacy snapshot requires an explicit --data-dir");
  }
  const { raw, parsed } = readBoundManifest(input.snapshotDbPath, expectedManifestSha);
  assertLegacySnapshotManifest(parsed);
  const manifest = validateSnapshotManifest(parsed, snapshotManifestPath(input.snapshotDbPath), {
    allowLegacyV1: true
  });
  const sidecarRaw = readBoundFile(
    snapshotSidecarPath(input.snapshotDbPath),
    requireArtifactSha(manifest, "sidecar_sha256"),
    "legacy snapshot sidecar"
  );
  const dataset = loadBoundDataset(
    join(input.dataDir, `${input.variant}.json`),
    expectedDatasetSha
  );
  const sidecar = hydrateLegacySnapshotSidecar(
    JSON.parse(sidecarRaw.toString("utf8")) as unknown,
    dataset,
    manifest
  );
  return {
    manifest,
    sidecar,
    snapshotManifestSha256: sha256Text(raw),
    datasetSha256: expectedDatasetSha
  };
}

export function restoreLegacySnapshotToDataDir(input: {
  readonly snapshotDbPath: string;
  readonly dataDirRoot: string;
  readonly manifest: LongMemEvalSnapshotManifest;
}): void {
  copyRegularFileNoFollow({
    sourcePath: input.snapshotDbPath,
    targetPath: join(input.dataDirRoot, BENCH_DAEMON_DB_FILENAME),
    expectedSha256: requireArtifactSha(input.manifest, "db_sha256")
  });
}

export function assertLegacySnapshotManifest(value: unknown): void {
  const manifest = requireRecord(value, "legacy snapshot manifest");
  requireLegacyProducerIdentity(manifest);
  const attribution = requireRecord(manifest.attribution, "legacy snapshot attribution");
  if (attribution.status !== "legacy_unattributed" || attribution.gate_eligible !== false) {
    throw new Error("legacy snapshot must remain explicitly ineligible");
  }
  requireSha(manifest.question_id_digest, "legacy question digest");
  const integrity = requireRecord(manifest.artifact_integrity, "legacy artifact integrity");
  requireSha(integrity.db_sha256, "legacy DB");
  requireSha(integrity.sidecar_sha256, "legacy sidecar");
  assertLegacyExtractionSummary(requireRecord(
    manifest.extraction_provenance,
    "legacy extraction provenance"
  ));
  assertLegacyCacheIdentity(requireRecord(
    requireRecord(manifest.run_provenance, "legacy run provenance").extraction_cache,
    "legacy extraction cache"
  ));
  assertLegacyExecution(manifest);
}

export function hydrateLegacySnapshotSidecar(
  value: unknown,
  dataset: readonly LongMemEvalQuestion[],
  manifest?: LegacyQuestionWindow
): LongMemEvalSnapshotSidecarFile {
  const sidecar = requireRecord(value, "legacy snapshot sidecar");
  if (sidecar.schema_version !== 1 || !Array.isArray(sidecar.questions)) {
    throw new Error("legacy snapshot sidecar must use schema_version 1");
  }
  const expectedQuestions = selectExpectedQuestions(dataset, manifest);
  const questions = sidecar.questions.map((value, index) =>
    hydrateQuestion(value, expectedQuestions[index], index)
  );
  return parseSnapshotSidecar({
    ...sidecar,
    schema_version: RECALL_EVAL_SNAPSHOT_MANIFEST_VERSION,
    questions
  }, "legacy snapshot sidecar", RECALL_EVAL_SNAPSHOT_MANIFEST_VERSION);
}

function readBoundManifest(snapshotDbPath: string, expectedSha: string): {
  readonly raw: string;
  readonly parsed: unknown;
} {
  const raw = readBoundFile(
    snapshotManifestPath(snapshotDbPath), expectedSha, "legacy snapshot manifest"
  ).toString("utf8");
  return { raw, parsed: JSON.parse(raw) as unknown };
}

function loadBoundDataset(
  datasetPath: string,
  expectedSha: string
): readonly LongMemEvalQuestion[] {
  const raw = readBoundFile(datasetPath, expectedSha, "legacy dataset");
  const parsed = JSON.parse(raw.toString("utf8")) as unknown;
  if (!Array.isArray(parsed)) throw new Error("legacy dataset must be an array");
  return parsed.map((value, index) => {
    const result = LongMemEvalQuestionSchema.safeParse(value);
    if (!result.success) throw new Error(`legacy dataset item ${index} is invalid`);
    return result.data;
  });
}

function hydrateQuestion(
  value: unknown,
  source: LongMemEvalQuestion | undefined,
  index: number
): Record<string, unknown> {
  const legacy = requireRecord(value, `legacy snapshot question ${index}`);
  const questionId = requireString(legacy.questionId, `question ${index} id`);
  if (source === undefined || source.question_id !== questionId) {
    throw new Error(`legacy snapshot question order mismatch at ${questionId}`);
  }
  if (legacy.question !== source.question) {
    throw new Error(`legacy snapshot question text mismatch for ${questionId}`);
  }
  if (!equalStringArrays(legacy.answerSessionIds, source.answer_session_ids)) {
    throw new Error(`legacy snapshot answer sessions mismatch for ${questionId}`);
  }
  assertSidecarSessions(legacy.sidecar, source, questionId);
  return { ...legacy, questionDate: requireLongMemEvalTimestamp(source.question_date) };
}

function selectExpectedQuestions(
  dataset: readonly LongMemEvalQuestion[],
  manifest?: LegacyQuestionWindow
): readonly LongMemEvalQuestion[] {
  if (manifest === undefined) return dataset;
  const execution = manifest.run_provenance?.execution;
  const offset = execution?.offset ?? 0;
  const count = execution?.evaluated_count ?? manifest.question_count;
  if (count !== manifest.question_count) {
    throw new Error("legacy snapshot execution count mismatch");
  }
  return dataset.slice(offset, offset + count);
}

interface LegacyQuestionWindow {
  readonly question_count: number;
  readonly run_provenance?: Readonly<{
    readonly execution: Readonly<{
      readonly offset: number;
      readonly evaluated_count: number;
    }>;
  }>;
}

function assertSidecarSessions(
  value: unknown,
  source: LongMemEvalQuestion,
  questionId: string
): void {
  if (!Array.isArray(value)) throw new Error(`legacy snapshot sidecar missing for ${questionId}`);
  const sessions = new Map(source.haystack_session_ids.map((id, index) => [
    id,
    source.haystack_sessions[index]
  ]));
  for (const rawEntry of value) {
    const entry = requireRecord(rawEntry, `legacy sidecar entry for ${questionId}`);
    const sessionId = requireString(entry.sessionId, "legacy sidecar session id");
    const turns = sessions.get(sessionId);
    if (turns === undefined) throw new Error(`legacy sidecar session ${sessionId} is absent from dataset`);
    if (entry.hasAnswer === true && !turns.some((turn) => turn.has_answer === true)) {
      throw new Error(`legacy sidecar answer marker mismatch for ${sessionId}`);
    }
  }
}

function requireLegacyProducerIdentity(manifest: Record<string, unknown>): void {
  if (manifest.schema_version !== 1 || manifest.recall_pipeline_version !== LEGACY_PIPELINE ||
      manifest.schema_migration_version !== 103 || manifest.alaya_commit !== "d7266aa" ||
      manifest.bench_runner_version !== "0.3.11" || manifest.variant !== "longmemeval_s") {
    throw new Error("legacy snapshot uses an unsupported producer contract");
  }
  const code = requireRecord(
    requireRecord(manifest.run_provenance, "legacy run provenance").code,
    "legacy code provenance"
  );
  if (code.commit_sha7 !== "d7266aa" || code.gate_sha256 !== null ||
      code.worktree_state_sha256 !== null) {
    throw new Error("legacy snapshot code provenance mismatch");
  }
}

function assertLegacyExtractionSummary(summary: Record<string, unknown>): void {
  const expected: Readonly<Record<string, unknown>> = {
    extraction_model: LEGACY_MODEL, provider_url: LEGACY_PROVIDER,
    system_prompt_sha256: LEGACY_PROMPT_SHA, dataset: "longmemeval-s",
    dataset_revision: "unpinned", requested_turns: 1284,
    cached_turns: 96084, coverage: 1
  };
  for (const [field, expectedValue] of Object.entries(expected)) {
    if (summary[field] !== expectedValue) {
      throw new Error(`legacy extraction provenance ${field} mismatch`);
    }
  }
}

function assertLegacyCacheIdentity(cache: Record<string, unknown>): void {
  const expected: Readonly<Record<string, unknown>> = {
    manifest_sha256: LEGACY_CACHE_MANIFEST_SHA, schema_version: 1,
    extraction_model: LEGACY_MODEL, provider_url: LEGACY_PROVIDER,
    system_prompt_sha256: LEGACY_PROMPT_SHA, cache_key_algo: LEGACY_KEY_ALGO,
    dataset: "longmemeval-s", dataset_revision: "unpinned",
    requested_turns: 1284, cached_turns: 96084, coverage: 1,
    storage: "git-tracked", builder: "extraction-fill",
    built_at: "2026-07-01T10:38:36.468Z"
  };
  for (const [field, expectedValue] of Object.entries(expected)) {
    if (cache[field] !== expectedValue) throw new Error(`legacy extraction cache ${field} mismatch`);
  }
}

function assertLegacyExecution(manifest: Record<string, unknown>): void {
  const provenance = requireRecord(manifest.run_provenance, "legacy run provenance");
  const execution = requireRecord(provenance.execution, "legacy execution");
  if (!Number.isSafeInteger(manifest.question_count) || (manifest.question_count as number) <= 0 ||
      execution.protocol !== "sequential" || execution.concurrency !== 1 ||
      !Number.isSafeInteger(execution.offset) || (execution.offset as number) < 0 ||
      execution.evaluated_count !== manifest.question_count ||
      (execution.limit !== null && execution.limit !== manifest.question_count)) {
    throw new Error("legacy snapshot execution contract mismatch");
  }
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function readBoundFile(filePath: string, expectedSha: string, label: string): Buffer {
  const bytes = readRegularFileNoFollow(filePath);
  if (sha256Buffer(bytes) !== expectedSha) throw new Error(`${label} SHA-256 mismatch`);
  return bytes;
}

function requireArtifactSha(
  manifest: LongMemEvalSnapshotManifest,
  field: "db_sha256" | "sidecar_sha256"
): string {
  const value = manifest.artifact_integrity?.[field];
  if (value === undefined) throw new Error("legacy snapshot requires artifact integrity");
  return value;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function requireSha(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new Error(`${label} SHA-256 is required`);
  }
  return value;
}

function equalStringArrays(value: unknown, expected: readonly string[]): boolean {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string") &&
    value.length === expected.length && value.every((entry, index) => entry === expected[index]);
}
