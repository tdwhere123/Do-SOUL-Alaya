import { DatabaseSync } from "node:sqlite";
import {
  pairSessionIntoRounds,
  type LongMemEvalQuestion
} from "../ingestion/dataset.js";
import { requireLongMemEvalTimestamp } from "../ingestion/source-time.js";
import {
  resolveLongMemEvalSeedRoundIdentity,
  resolveLongMemEvalSeedSessionIndex,
  type LongMemEvalSeedRoundIdentity
} from "../runner/question/runner-question-seeding.js";
import { buildLongMemEvalQuestionRuntimeIdentity } from
  "../selection/question-runtime-identity.js";
import {
  hasOrderedUniqueLongMemEvalSourceRounds,
  longMemEvalSourceRoundKey,
  type LongMemEvalSourceRound
} from "../provenance/source-rounds.js";
import type {
  LongMemEvalSnapshotQuestion,
  LongMemEvalSnapshotSidecarEntry,
  LongMemEvalSnapshotSidecarFile
} from "./materialize.js";

interface StoredObjectRow {
  readonly object_id: string;
  readonly object_kind: string;
  readonly workspace_id: string;
  readonly run_id: string;
  readonly surface_id: string | null;
  readonly topic_key: string | null;
  readonly evidence_refs: string;
}

interface StoredEvidenceRow {
  readonly object_id: string;
  readonly object_kind: string;
  readonly workspace_id: string;
  readonly run_id: string;
  readonly surface_id: string | null;
  readonly physical_anchor: string | null;
}

export function assertSnapshotDatasetSubstrateIdentity(input: {
  readonly dbPath: string;
  readonly sidecar: LongMemEvalSnapshotSidecarFile;
  readonly questions: readonly LongMemEvalQuestion[];
  readonly runtimeIdentity?: "canonical" | "sidecar_bound";
  readonly duplicateObjectLabel?: string;
}): void {
  if (input.sidecar.questions.length !== input.questions.length) {
    throw new Error("snapshot canonical question count mismatch");
  }
  const db = new DatabaseSync(input.dbPath, { readOnly: true });
  try {
    input.sidecar.questions.forEach((sidecar, index) => {
      const source = input.questions[index];
      if (source === undefined) throw new Error("snapshot canonical question order mismatch");
      assertCanonicalQuestion(sidecar, source, input.runtimeIdentity ?? "canonical");
      assertQuestionObjectIdentity(
        db,
        sidecar,
        source,
        input.duplicateObjectLabel ?? "snapshot sidecar object"
      );
    });
  } finally {
    db.close();
  }
}

function assertCanonicalQuestion(
  sidecar: LongMemEvalSnapshotQuestion,
  source: LongMemEvalQuestion,
  runtimeIdentity: "canonical" | "sidecar_bound"
): void {
  if (sidecar.questionId !== source.question_id || sidecar.question !== source.question ||
      sidecar.questionDate !== requireLongMemEvalTimestamp(source.question_date) ||
      !equalStrings(sidecar.answerSessionIds, source.answer_session_ids)) {
    throw new Error(`snapshot canonical question identity mismatch for ${source.question_id}`);
  }
  const runtime = buildLongMemEvalQuestionRuntimeIdentity(source.question_id);
  if (runtimeIdentity === "canonical" &&
      (sidecar.workspaceId !== runtime.workspaceId || sidecar.runId !== runtime.runId)) {
    throw new Error(`snapshot canonical runtime identity mismatch for ${source.question_id}`);
  }
  const sessions = new Set(source.haystack_session_ids);
  for (const entry of sidecar.sidecar) {
    if (!sessions.has(entry.sessionId) ||
        entry.sourceRounds?.some((round) => !sessions.has(round.sessionId)) === true) {
      throw new Error(`snapshot sidecar session is absent from dataset for ${source.question_id}`);
    }
  }
}

function assertQuestionObjectIdentity(
  db: DatabaseSync,
  sidecar: LongMemEvalSnapshotQuestion,
  source: LongMemEvalQuestion,
  duplicateObjectLabel: string
): void {
  const expected = indexSidecarObjects(sidecar.sidecar, duplicateObjectLabel);
  const stored = readStoredObjects(db, sidecar.workspaceId);
  if (stored.size !== expected.size) {
    throw new Error(`snapshot sidecar DB object count mismatch for ${sidecar.questionId}`);
  }
  const evidence = readStoredEvidence(db, sidecar.workspaceId);
  for (const entry of expected.values()) {
    const row = stored.get(objectIdentity(entry.objectKind, entry.objectId));
    if (row === undefined) throw new Error(`snapshot sidecar DB object missing ${entry.objectId}`);
    assertStoredObjectIdentity(row, entry, sidecar, source, evidence);
  }
}

function indexSidecarObjects(
  entries: readonly LongMemEvalSnapshotSidecarEntry[],
  duplicateObjectLabel: string
): Map<string, LongMemEvalSnapshotSidecarEntry> {
  const indexed = new Map<string, LongMemEvalSnapshotSidecarEntry>();
  for (const entry of entries) {
    const key = objectIdentity(entry.objectKind, entry.objectId);
    if (indexed.has(key)) throw new Error(`duplicate ${duplicateObjectLabel} ${key}`);
    indexed.set(key, entry);
  }
  return indexed;
}

function readStoredObjects(db: DatabaseSync, workspaceId: string) {
  const rows = db.prepare(`
    SELECT object_id, object_kind, workspace_id, run_id, surface_id,
           NULL AS topic_key, evidence_refs
      FROM memory_entries WHERE workspace_id = ?
    UNION ALL
    SELECT object_id, object_kind, workspace_id, run_id, NULL AS surface_id,
           topic_key, evidence_refs
      FROM synthesis_capsules WHERE workspace_id = ?
  `).all(workspaceId, workspaceId) as unknown as readonly StoredObjectRow[];
  const indexed = new Map<string, StoredObjectRow>();
  for (const row of rows) {
    const key = objectIdentity(row.object_kind, row.object_id);
    if (indexed.has(key)) throw new Error(`ambiguous snapshot DB object ${key}`);
    indexed.set(key, row);
  }
  return indexed;
}

function readStoredEvidence(db: DatabaseSync, workspaceId: string) {
  const rows = db.prepare(`
    SELECT object_id, object_kind, workspace_id, run_id, surface_id, physical_anchor
      FROM evidence_capsules WHERE workspace_id = ?
  `).all(workspaceId) as unknown as readonly StoredEvidenceRow[];
  return new Map(rows.map((row) => [row.object_id, row]));
}

function assertStoredObjectIdentity(
  row: StoredObjectRow,
  entry: LongMemEvalSnapshotSidecarEntry,
  question: LongMemEvalSnapshotQuestion,
  source: LongMemEvalQuestion,
  evidence: ReadonlyMap<string, StoredEvidenceRow>
): void {
  if (row.object_kind !== entry.objectKind || row.workspace_id !== question.workspaceId ||
      row.run_id !== question.runId) {
    throw new Error(`snapshot sidecar DB identity mismatch for ${entry.objectId}`);
  }
  if (entry.objectKind === "memory_entry") {
    assertMemoryAnswerIdentity(row, entry, question, source, evidence);
  } else {
    assertSynthesisAnswerIdentity(row, entry, question, source, evidence);
  }
}

function assertMemoryAnswerIdentity(
  row: StoredObjectRow,
  entry: LongMemEvalSnapshotSidecarEntry,
  question: LongMemEvalSnapshotQuestion,
  source: LongMemEvalQuestion,
  evidence: ReadonlyMap<string, StoredEvidenceRow>
): void {
  const rounds = parseEvidenceRefs(row.evidence_refs, entry.objectId)
    .map((ref) => resolveEvidenceRound(ref, question, source, evidence));
  if (entry.sourceRounds !== undefined) {
    assertReconciledMemoryShape(row, entry, source, rounds);
    return;
  }
  const identities = new Set(rounds.map((round) =>
    `${round.sessionIndex}:${round.roundIndex}`));
  const round = rounds[0];
  if (identities.size !== 1 || round === undefined) {
    throw new Error(`ambiguous round evidence for ${entry.objectId}`);
  }
  if (row.surface_id !== entry.sessionId || round.sessionId !== entry.sessionId ||
      entry.hasAnswer !== round.hasAnswer) {
    throw new Error(`memory_entry answer marker mismatch for ${entry.objectId}`);
  }
}

function assertReconciledMemoryShape(
  row: StoredObjectRow,
  entry: LongMemEvalSnapshotSidecarEntry,
  question: LongMemEvalQuestion,
  evidenceRounds: readonly LongMemEvalSeedRoundIdentity[]
): void {
  const sources = entry.sourceRounds!;
  const representative = sources[0];
  const indexed = new Map(sources.map((source) => [longMemEvalSourceRoundKey(source), source]));
  if (representative === undefined || !hasOrderedUniqueLongMemEvalSourceRounds(sources) ||
      indexed.size !== sources.length ||
      entry.sessionId !== representative.sessionId ||
      entry.hasAnswer !== representative.hasAnswer ||
      row.surface_id !== representative.sessionId ||
      sources.some((source) => !matchesCanonicalSource(source, question)) ||
      evidenceRounds.length === 0 ||
      evidenceRounds.some((round) => !indexed.has(longMemEvalSourceRoundKey(round))) ||
      !evidenceRounds.some((round) => round.sessionId === row.surface_id)) {
    throw new Error(`memory_entry answer marker mismatch for ${entry.objectId}`);
  }
}

function matchesCanonicalSource(
  source: LongMemEvalSourceRound,
  question: LongMemEvalQuestion
): boolean {
  const session = question.haystack_sessions[source.sessionIndex];
  const round = session === undefined
    ? undefined
    : pairSessionIntoRounds(session)[source.roundIndex];
  return question.haystack_session_ids[source.sessionIndex] === source.sessionId &&
    round?.hasAnswer === source.hasAnswer;
}

function assertSynthesisAnswerIdentity(
  row: StoredObjectRow,
  entry: LongMemEvalSnapshotSidecarEntry,
  question: LongMemEvalSnapshotQuestion,
  source: LongMemEvalQuestion,
  evidence: ReadonlyMap<string, StoredEvidenceRow>
): void {
  const sessionIndex = resolveLongMemEvalSeedSessionIndex(row.topic_key, source);
  const session = source.haystack_sessions[sessionIndex]!;
  const aggregate = pairSessionIntoRounds(session).some((round) => round.hasAnswer);
  const rounds = parseEvidenceRefs(row.evidence_refs, entry.objectId)
    .map((ref) => resolveEvidenceRound(ref, question, source, evidence));
  if (source.haystack_session_ids[sessionIndex] !== entry.sessionId ||
      entry.hasAnswer !== aggregate || rounds.length < 2 ||
      rounds.some((round) => round.sessionIndex !== sessionIndex)) {
    throw new Error(`synthesis_capsule answer marker mismatch for ${entry.objectId}`);
  }
}

function resolveEvidenceRound(
  evidenceId: string,
  question: LongMemEvalSnapshotQuestion,
  source: LongMemEvalQuestion,
  evidence: ReadonlyMap<string, StoredEvidenceRow>
): LongMemEvalSeedRoundIdentity {
  const row = evidence.get(evidenceId);
  if (row === undefined || row.object_kind !== "evidence_capsule" ||
      row.workspace_id !== question.workspaceId || row.run_id !== question.runId) {
    throw new Error(`snapshot sidecar evidence identity mismatch for ${evidenceId}`);
  }
  const anchor = parseRecord(row.physical_anchor, `physical anchor ${evidenceId}`);
  const round = resolveLongMemEvalSeedRoundIdentity(anchor.artifact_ref, source);
  if (row.surface_id !== round.sessionId) {
    throw new Error(`snapshot sidecar evidence session mismatch for ${evidenceId}`);
  }
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

function parseRecord(value: string | null, label: string): Record<string, unknown> {
  const parsed = parseJson(value, label);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${label} must be an object`);
  }
  return parsed as Record<string, unknown>;
}

function parseJson(value: string | null, label: string): unknown {
  if (value === null) throw new Error(`${label} is required`);
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error(`${label} must be valid JSON`);
  }
}

function objectIdentity(kind: string, objectId: string): string {
  return `${kind}:${objectId}`;
}

function equalStrings(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length &&
    actual.every((value, index) => value === expected[index]);
}
