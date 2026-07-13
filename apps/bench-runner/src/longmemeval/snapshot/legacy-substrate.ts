import { createHash } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  LongMemEvalQuestionSchema,
  pairSessionIntoRounds,
  type LongMemEvalQuestion,
  type LongMemEvalVariant
} from "../dataset.js";
import { requireLongMemEvalTimestamp } from "../ingestion/source-time.js";
import {
  resolveLongMemEvalSeedRoundIdentity,
  resolveLongMemEvalSeedSessionIndex,
  type LongMemEvalSeedRoundIdentity
} from "../runner-question-seeding.js";
import {
  RECALL_EVAL_SNAPSHOT_MANIFEST_VERSION,
  BENCH_DAEMON_DB_FILENAME,
  snapshotManifestPath,
  snapshotSidecarPath,
  type LongMemEvalSnapshotManifest,
  type LongMemEvalSnapshotQuestion,
  type LongMemEvalSnapshotSidecarEntry,
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
  assertLegacySnapshotSidecarIdentity(
    input.snapshotDbPath,
    sidecar,
    selectExpectedQuestions(dataset, manifest)
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
export function assertLegacySnapshotSidecarIdentity(
  snapshotDbPath: string,
  sidecar: LongMemEvalSnapshotSidecarFile,
  questions: readonly LongMemEvalQuestion[]
): void {
  if (sidecar.questions.length !== questions.length) {
    throw new Error("legacy sidecar question identity count mismatch");
  }
  const db = new DatabaseSync(snapshotDbPath, { readOnly: true });
  try {
    for (const [index, questionSidecar] of sidecar.questions.entries()) {
      const source = questions[index];
      if (source === undefined || source.question_id !== questionSidecar.questionId) {
        throw new Error("legacy sidecar question identity mismatch");
      }
      assertQuestionObjectIdentity(db, questionSidecar, source);
    }
  } finally {
    db.close();
  }
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

interface LegacyDbScopedRow {
  readonly object_id: string; readonly object_kind: string;
  readonly workspace_id: string; readonly run_id: string;
}
interface LegacyDbObjectRow extends LegacyDbScopedRow {
  readonly surface_id: string | null; readonly topic_key: string | null;
  readonly evidence_refs: string;
}
interface LegacyEvidenceRow extends LegacyDbScopedRow {
  readonly surface_id: string | null; readonly physical_anchor: string | null;
}
function assertQuestionObjectIdentity(
  db: DatabaseSync, sidecar: LongMemEvalSnapshotQuestion,
  source: LongMemEvalQuestion
): void {
  const expected = indexSidecarObjects(sidecar.sidecar);
  const stored = readStoredObjects(db, sidecar.workspaceId);
  if (stored.size !== expected.size) {
    throw new Error(`legacy sidecar DB object count mismatch for ${sidecar.questionId}`);
  }
  const evidence = readStoredEvidence(db, sidecar.workspaceId);
  for (const entry of expected.values()) {
    const row = stored.get(objectIdentity(entry.objectKind, entry.objectId));
    if (row === undefined) {
      throw new Error(`legacy sidecar DB object missing for ${entry.objectId}`);
    }
    assertStoredObjectIdentity(row, entry, sidecar, source, evidence);
  }
}
function indexSidecarObjects(
  entries: readonly LongMemEvalSnapshotSidecarEntry[]
): Map<string, LongMemEvalSnapshotSidecarEntry> {
  const indexed = new Map<string, LongMemEvalSnapshotSidecarEntry>();
  for (const entry of entries) {
    const key = objectIdentity(entry.objectKind, entry.objectId);
    if (indexed.has(key)) throw new Error(`duplicate legacy sidecar object identity ${key}`);
    indexed.set(key, entry);
  }
  return indexed;
}
function readStoredObjects(db: DatabaseSync, workspaceId: string): Map<string, LegacyDbObjectRow> {
  const rows = db.prepare(`
    SELECT object_id, object_kind, workspace_id, run_id, surface_id,
           NULL AS topic_key, evidence_refs
      FROM memory_entries WHERE workspace_id = ?
    UNION ALL
    SELECT object_id, object_kind, workspace_id, run_id, NULL AS surface_id,
           topic_key, evidence_refs
      FROM synthesis_capsules WHERE workspace_id = ?
  `).all(workspaceId, workspaceId) as unknown as readonly LegacyDbObjectRow[];
  const indexed = new Map<string, LegacyDbObjectRow>();
  for (const row of rows) {
    const expectedKind = row.topic_key === null ? "memory_entry" : "synthesis_capsule";
    const key = objectIdentity(row.object_kind, row.object_id);
    if (row.object_kind !== expectedKind || indexed.has(key))
      throw new Error(`ambiguous legacy DB object identity ${key}`);
    indexed.set(key, row);
  }
  return indexed;
}
function readStoredEvidence(db: DatabaseSync, workspaceId: string): Map<string, LegacyEvidenceRow> {
  const rows = db.prepare(`
    SELECT object_id, object_kind, workspace_id, run_id, surface_id, physical_anchor
      FROM evidence_capsules WHERE workspace_id = ?
  `).all(workspaceId) as unknown as readonly LegacyEvidenceRow[];
  return new Map(rows.map((row) => [row.object_id, row]));
}
function assertStoredObjectIdentity(
  row: LegacyDbObjectRow, entry: LongMemEvalSnapshotSidecarEntry,
  question: LongMemEvalSnapshotQuestion,
  source: LongMemEvalQuestion,
  evidence: ReadonlyMap<string, LegacyEvidenceRow>
): void {
  if (row.object_kind !== entry.objectKind || row.workspace_id !== question.workspaceId ||
      row.run_id !== question.runId) {
    throw new Error(`legacy sidecar DB identity mismatch for ${entry.objectId}`);
  }
  if (entry.objectKind === "memory_entry") {
    assertMemoryAnswerIdentity(row, entry, question, source, evidence);
    return;
  }
  assertSynthesisAnswerIdentity(row, entry, question, source, evidence);
}
function assertMemoryAnswerIdentity(
  row: LegacyDbObjectRow, entry: LongMemEvalSnapshotSidecarEntry,
  question: LongMemEvalSnapshotQuestion,
  source: LongMemEvalQuestion,
  evidence: ReadonlyMap<string, LegacyEvidenceRow>
): void {
  const refs = parseEvidenceRefs(row.evidence_refs, entry.objectId);
  const rounds = refs.map((ref) => resolveEvidenceRound(ref, question, source, evidence));
  const identities = new Set(rounds.map((round) => `${round.sessionIndex}:${round.roundIndex}`));
  if (identities.size !== 1) throw new Error(`ambiguous round evidence for ${entry.objectId}`);
  const round = rounds[0];
  if (round === undefined || row.surface_id !== entry.sessionId ||
      round.sessionId !== entry.sessionId || entry.hasAnswer !== round.hasAnswer) {
    throw new Error(`memory_entry answer marker mismatch for ${entry.objectId}`);
  }
}
function assertSynthesisAnswerIdentity(
  row: LegacyDbObjectRow, entry: LongMemEvalSnapshotSidecarEntry,
  question: LongMemEvalSnapshotQuestion,
  source: LongMemEvalQuestion,
  evidence: ReadonlyMap<string, LegacyEvidenceRow>
): void {
  const sessionIndex = resolveLongMemEvalSeedSessionIndex(row.topic_key, source);
  const session = source.haystack_sessions[sessionIndex]!;
  const aggregate = pairSessionIntoRounds(session).some((round) => round.hasAnswer);
  if (source.haystack_session_ids[sessionIndex] !== entry.sessionId ||
      entry.hasAnswer !== aggregate) {
    throw new Error(`synthesis_capsule answer marker mismatch for ${entry.objectId}`);
  }
  const rounds = parseEvidenceRefs(row.evidence_refs, entry.objectId)
    .map((ref) => resolveEvidenceRound(ref, question, source, evidence));
  if (rounds.length < 2 || rounds.some((round) => round.sessionIndex !== sessionIndex)) {
    throw new Error(`synthesis_capsule session evidence mismatch for ${entry.objectId}`);
  }
}
function resolveEvidenceRound(
  evidenceId: string, question: LongMemEvalSnapshotQuestion,
  source: LongMemEvalQuestion,
  evidence: ReadonlyMap<string, LegacyEvidenceRow>
): LongMemEvalSeedRoundIdentity {
  const row = evidence.get(evidenceId);
  if (row === undefined || row.object_kind !== "evidence_capsule" ||
      row.workspace_id !== question.workspaceId || row.run_id !== question.runId) {
    throw new Error(`legacy sidecar evidence identity mismatch for ${evidenceId}`);
  }
  const anchor = parseJsonRecord(row.physical_anchor, `physical anchor ${evidenceId}`);
  const round = resolveLongMemEvalSeedRoundIdentity(anchor.artifact_ref, source);
  if (row.surface_id !== round.sessionId)
    throw new Error(`legacy sidecar evidence session mismatch for ${evidenceId}`);
  return round;
}
function parseEvidenceRefs(value: string, objectId: string): readonly string[] {
  const parsed = parseJson(value, `evidence refs ${objectId}`);
  if (!Array.isArray(parsed) || parsed.length === 0 ||
      parsed.some((entry) => typeof entry !== "string" || entry.length === 0) ||
      new Set(parsed).size !== parsed.length) {
    throw new Error(`ambiguous round evidence for ${objectId}`);
  }
  return parsed as string[];
}
function parseJsonRecord(value: string | null, label: string): Record<string, unknown> {
  return requireRecord(parseJson(value, label), label); }
function parseJson(value: string | null, label: string): unknown {
  if (value === null) throw new Error(`${label} is required`);
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error(`${label} must be valid JSON`);
  }
}
function objectIdentity(kind: string, objectId: string): string { return `${kind}:${objectId}`; }
function assertSidecarSessions(
  value: unknown,
  source: LongMemEvalQuestion,
  questionId: string
): void {
  if (!Array.isArray(value)) throw new Error(`legacy snapshot sidecar missing for ${questionId}`);
  const sessions = new Set(source.haystack_session_ids);
  const objects = new Set<string>();
  for (const rawEntry of value) {
    const entry = requireRecord(rawEntry, `legacy sidecar entry for ${questionId}`);
    const sessionId = requireString(entry.sessionId, "legacy sidecar session id");
    if (!sessions.has(sessionId))
      throw new Error(`legacy sidecar session ${sessionId} is absent from dataset`);
    const objectId = requireString(entry.objectId, "legacy sidecar object id");
    const kind = entry.objectKind;
    if (kind !== "memory_entry" && kind !== "synthesis_capsule") continue;
    const key = objectIdentity(kind, objectId);
    if (objects.has(key)) throw new Error(`duplicate legacy sidecar object identity ${key}`);
    objects.add(key);
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
