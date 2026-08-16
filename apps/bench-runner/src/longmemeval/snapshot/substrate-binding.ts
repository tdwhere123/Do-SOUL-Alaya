import { DatabaseSync } from "node:sqlite";
import {
  pairSessionIntoRounds,
  type LongMemEvalQuestion
} from "../ingestion/dataset.js";
import { requireLongMemEvalTimestamp } from "../ingestion/source-time.js";
import {
  resolveLongMemEvalSeedRoundIdentity,
  resolveLongMemEvalSeedSessionIndex,
  buildLongMemEvalRoundEvidenceRef,
  type LongMemEvalSeedRoundIdentity
} from "../runner/question/runner-question-seeding.js";
import {
  hasGardenSourceTurnFallbackAnyReceiptFormat,
  readGardenSourceTurnFallbackArtifactSignalId
} from "@do-soul/alaya-protocol";
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
import { assertDirectSourceEvidenceClosure } from
  "./seed-ledger/direct-source-evidence-proof.js";

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
  readonly source_hash?: string | null;
}

interface StoredSubstrateIndex {
  readonly objectsByWorkspace: ReadonlyMap<string, ReadonlyMap<string, StoredObjectRow>>;
  readonly evidenceByWorkspace: ReadonlyMap<string, ReadonlyMap<string, StoredEvidenceRow>>;
}

const EMPTY_STORED_OBJECTS: ReadonlyMap<string, StoredObjectRow> = new Map();
const EMPTY_STORED_EVIDENCE: ReadonlyMap<string, StoredEvidenceRow> = new Map();

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
    const substrate = readStoredSubstrateIndex(
      db,
      new Set(input.sidecar.questions.map((question) => question.workspaceId))
    );
    input.sidecar.questions.forEach((sidecar, index) => {
      const source = input.questions[index];
      if (source === undefined) throw new Error("snapshot canonical question order mismatch");
      assertCanonicalQuestion(sidecar, source, input.runtimeIdentity ?? "canonical");
      assertQuestionObjectIdentity(
        sidecar,
        source,
        input.duplicateObjectLabel ?? "snapshot sidecar object",
        substrate.objectsByWorkspace.get(sidecar.workspaceId) ?? EMPTY_STORED_OBJECTS,
        substrate.evidenceByWorkspace.get(sidecar.workspaceId) ?? EMPTY_STORED_EVIDENCE
      );
      assertDirectSourceEvidenceClosure({
        db,
        question: sidecar,
        source,
        ledger: sidecar.seedRounds ?? []
      });
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
  sidecar: LongMemEvalSnapshotQuestion,
  source: LongMemEvalQuestion,
  duplicateObjectLabel: string,
  stored: ReadonlyMap<string, StoredObjectRow>,
  evidence: ReadonlyMap<string, StoredEvidenceRow>
): void {
  const expected = indexSidecarObjects(sidecar.sidecar, duplicateObjectLabel);
  const expectedStoredCount = [...expected.values()]
    .filter((entry) => entry.objectKind !== "evidence_capsule").length;
  if (stored.size !== expectedStoredCount) {
    throw new Error(`snapshot sidecar DB object count mismatch for ${sidecar.questionId}`);
  }
  assertNoMemoryEvidenceIdCollision(stored, evidence, sidecar.questionId);
  for (const entry of expected.values()) {
    if (entry.objectKind === "evidence_capsule") {
      assertEvidenceAnswerIdentity(evidence.get(entry.objectId), entry, sidecar, source);
      continue;
    }
    const row = stored.get(objectIdentity(entry.objectKind, entry.objectId));
    if (row === undefined) throw new Error(`snapshot sidecar DB object missing ${entry.objectId}`);
    assertStoredObjectIdentity(row, entry, sidecar, source, evidence);
  }
}

function assertNoMemoryEvidenceIdCollision(
  stored: ReadonlyMap<string, StoredObjectRow>,
  evidence: ReadonlyMap<string, StoredEvidenceRow>,
  questionId: string
): void {
  for (const row of stored.values()) {
    if (row.object_kind === "memory_entry" && evidence.has(row.object_id)) {
      throw new Error(
        `snapshot DB cross-kind object id collision for ${questionId}: ${row.object_id}`
      );
    }
  }
}

function assertEvidenceAnswerIdentity(
  row: StoredEvidenceRow | undefined,
  entry: LongMemEvalSnapshotSidecarEntry,
  question: LongMemEvalSnapshotQuestion,
  source: LongMemEvalQuestion
): void {
  const rounds = entry.sourceRounds;
  const round = rounds?.[0];
  if (row === undefined || row.object_kind !== "evidence_capsule" ||
      row.workspace_id !== question.workspaceId || row.run_id !== question.runId ||
      rounds === undefined || rounds.length !== 1 || round === undefined ||
      !matchesCanonicalSource(round, source) ||
      entry.sessionId !== round.sessionId || entry.hasAnswer !== round.hasAnswer ||
      (row.surface_id !== null && row.surface_id !== round.sessionId)) {
    throw new Error(`evidence_capsule answer marker mismatch for ${entry.objectId}`);
  }
  const anchor = parseRecord(row.physical_anchor, `physical anchor ${entry.objectId}`);
  const evidenceRef = buildLongMemEvalRoundEvidenceRef(
    source.question_id,
    round.sessionIndex,
    round.roundIndex
  );
  if (readGardenSourceTurnFallbackArtifactSignalId(
    typeof anchor.artifact_ref === "string" ? anchor.artifact_ref : null
  ) !== evidenceRef) {
    throw new Error(`evidence_capsule source round mismatch for ${entry.objectId}`);
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

function readStoredSubstrateIndex(
  db: DatabaseSync,
  expectedWorkspaces: ReadonlySet<string>
): StoredSubstrateIndex {
  return {
    objectsByWorkspace: readStoredObjectsByWorkspace(db, expectedWorkspaces),
    evidenceByWorkspace: readStoredEvidenceByWorkspace(db, expectedWorkspaces)
  };
}

function readStoredObjectsByWorkspace(
  db: DatabaseSync,
  expectedWorkspaces: ReadonlySet<string>
) {
  const rows = db.prepare(`
    SELECT object_id, object_kind, workspace_id, run_id, surface_id,
           NULL AS topic_key, evidence_refs
      FROM memory_entries
    UNION ALL
    SELECT object_id, object_kind, workspace_id, run_id, NULL AS surface_id,
           topic_key, evidence_refs
      FROM synthesis_capsules
  `).all() as unknown as readonly StoredObjectRow[];
  const indexed = new Map<string, Map<string, StoredObjectRow>>();
  for (const row of rows) {
    if (!expectedWorkspaces.has(row.workspace_id)) continue;
    const workspace = indexed.get(row.workspace_id) ?? new Map<string, StoredObjectRow>();
    const key = objectIdentity(row.object_kind, row.object_id);
    if (workspace.has(key)) throw new Error(`ambiguous snapshot DB object ${key}`);
    workspace.set(key, row);
    indexed.set(row.workspace_id, workspace);
  }
  return indexed;
}

function readStoredEvidenceByWorkspace(
  db: DatabaseSync,
  expectedWorkspaces: ReadonlySet<string>
) {
  const sourceHash = db.prepare(`
    SELECT name FROM pragma_table_info('evidence_capsules')
     WHERE name = 'source_hash'
  `).get() === undefined
    ? "NULL AS source_hash"
    : "source_hash";
  const rows = db.prepare(`
    SELECT object_id, object_kind, workspace_id, run_id, surface_id,
           physical_anchor, ${sourceHash}
      FROM evidence_capsules
  `).all() as unknown as readonly StoredEvidenceRow[];
  const indexed = new Map<string, Map<string, StoredEvidenceRow>>();
  for (const row of rows) {
    if (!expectedWorkspaces.has(row.workspace_id)) continue;
    const workspace = indexed.get(row.workspace_id) ?? new Map<string, StoredEvidenceRow>();
    if (workspace.has(row.object_id)) {
      throw new Error(`ambiguous snapshot DB evidence ${row.object_id}`);
    }
    workspace.set(row.object_id, row);
    indexed.set(row.workspace_id, workspace);
  }
  return indexed;
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
  const artifactRef = typeof anchor.artifact_ref === "string"
    ? anchor.artifact_ref
    : null;
  const receiptFormat = {
    artifact_ref: artifactRef,
    source_hash: row.source_hash ?? null
  };
  const sourceRef = hasGardenSourceTurnFallbackAnyReceiptFormat(receiptFormat)
    ? readGardenSourceTurnFallbackArtifactSignalId(artifactRef)
    : artifactRef;
  const round = resolveLongMemEvalSeedRoundIdentity(sourceRef, source);
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
