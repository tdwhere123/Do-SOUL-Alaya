import { DatabaseSync } from "node:sqlite";
import {
  SignalEventType,
  SoulSignalMaterializedPayloadSchema,
  SoulSignalTriagedPayloadSchema
} from "@do-soul/alaya-protocol";
import type { LongMemEvalQuestion } from "../../ingestion/dataset.js";
import { resolveLongMemEvalSeedRoundIdentity } from
  "../../runner/question/runner-question-seeding.js";
import type {
  LongMemEvalSnapshotQuestion,
  LongMemEvalSnapshotSeedBinding,
  LongMemEvalSnapshotSeedRound
} from "../materialize.js";

interface StoredMemoryRow {
  readonly object_id: string;
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

interface StoredSignalRow {
  readonly signal_id: string;
  readonly workspace_id: string;
  readonly run_id: string;
  readonly source: string;
  readonly evidence_refs_json: string;
  readonly raw_payload_json: string;
}

interface StoredEventRow {
  readonly event_type: string;
  readonly entity_type: string;
  readonly entity_id: string;
  readonly workspace_id: string;
  readonly run_id: string | null;
  readonly caused_by: string | null;
  readonly payload_json: string;
}

export function assertSeedLedgerMaterializationProof(input: {
  readonly db: DatabaseSync;
  readonly question: LongMemEvalSnapshotQuestion;
  readonly source: LongMemEvalQuestion;
  readonly ledger: readonly LongMemEvalSnapshotSeedRound[];
}): ReadonlyMap<string, ReadonlySet<string>> {
  const sourcesByMemory = new Map<string, Set<string>>();
  const evidenceByMemory = new Map<string, Set<string>>();
  const signalIds = new Set<string>();
  const evidenceIds = new Set<string>();
  const evidence = readStoredEvidence(input.db, input.question.workspaceId);

  for (const round of input.ledger) {
    const bindings = requireRoundBindings(round);
    bindings.forEach((binding) => {
      assertBindingOrder(binding, round, signalIds, evidenceIds);
      const signal = assertSignalSource(
        input.db, binding, round, input.question, input.source
      );
      assertSignalMaterializationEvent(input.db, binding, input.question);
      addMemorySource(sourcesByMemory, binding.objectId, round);
      if (binding.evidenceId === null) {
        assertReconciliationNoop(input.db, binding, input.question, signal);
      } else {
        assertEvidenceBinding(binding.evidenceId, round, input.question, input.source, evidence);
        addEvidenceBinding(evidenceByMemory, binding.objectId, binding.evidenceId);
      }
    });
  }

  assertStoredMemoryEvidence(
    input.db,
    input.question,
    sourcesByMemory,
    evidenceByMemory
  );
  return sourcesByMemory;
}

function requireRoundBindings(
  round: LongMemEvalSnapshotSeedRound
): readonly LongMemEvalSnapshotSeedBinding[] {
  const bindings = round.memoryBindings;
  if (round.memoryObjectIds.length === 0) {
    if (bindings !== undefined && bindings.length !== 0) {
      throw new Error("snapshot empty seed round has memory bindings");
    }
    return [];
  }
  if (bindings === undefined || bindings.length === 0) {
    throw new Error("snapshot seed round memory binding mismatch");
  }
  const boundObjects = [...new Set(bindings.map((binding) => binding.objectId))];
  if (boundObjects.length !== round.memoryObjectIds.length ||
      boundObjects.some((objectId, index) => objectId !== round.memoryObjectIds[index])) {
    throw new Error("snapshot seed round memory binding mismatch");
  }
  return bindings;
}

function assertBindingOrder(
  binding: LongMemEvalSnapshotSeedBinding,
  round: LongMemEvalSnapshotSeedRound,
  signalIds: Set<string>,
  evidenceIds: Set<string>
): void {
  if (!round.memoryObjectIds.includes(binding.objectId) ||
      signalIds.has(binding.signalId) ||
      (binding.evidenceId !== null && evidenceIds.has(binding.evidenceId))) {
    throw new Error("snapshot seed round materialization binding is ambiguous");
  }
  signalIds.add(binding.signalId);
  if (binding.evidenceId !== null) evidenceIds.add(binding.evidenceId);
}

function assertSignalSource(
  db: DatabaseSync,
  binding: LongMemEvalSnapshotSeedBinding,
  round: LongMemEvalSnapshotSeedRound,
  question: LongMemEvalSnapshotQuestion,
  source: LongMemEvalQuestion
): StoredSignalRow {
  const row = db.prepare(`
    SELECT signal_id, workspace_id, run_id, source, evidence_refs_json, raw_payload_json
      FROM signals WHERE signal_id = ?
  `).get(binding.signalId) as unknown as StoredSignalRow | undefined;
  const refs = parseStringArray(row?.evidence_refs_json, `signal ${binding.signalId} evidence refs`);
  if (row === undefined || row.signal_id !== binding.signalId ||
      row.workspace_id !== question.workspaceId ||
      row.run_id !== question.runId || row.source !== "garden_compile" ||
      refs.length === 0 ||
      refs.some((ref) => !matchesRound(ref, round, source))) {
    throw new Error(`snapshot seed signal source mismatch for ${binding.signalId}`);
  }
  return row;
}

function assertSignalMaterializationEvent(
  db: DatabaseSync,
  binding: LongMemEvalSnapshotSeedBinding,
  question: LongMemEvalSnapshotQuestion
): void {
  const rows = db.prepare(`
    SELECT event_type, entity_type, entity_id, workspace_id, run_id, caused_by, payload_json
      FROM event_log WHERE entity_id = ? AND event_type = ?
  `).all(binding.signalId, SignalEventType.SOUL_SIGNAL_MATERIALIZED) as unknown as
    readonly StoredEventRow[];
  const row = rows[0];
  const payload = parseMaterializedPayload(row?.payload_json, binding.signalId);
  if (rows.length !== 1 || row === undefined ||
      row.event_type !== SignalEventType.SOUL_SIGNAL_MATERIALIZED ||
      row.entity_type !== "candidate_memory_signal" || row.entity_id !== binding.signalId ||
      row.workspace_id !== question.workspaceId || row.run_id !== question.runId ||
      row.caused_by !== "materialization_router" || payload.signal_id !== binding.signalId ||
      payload.workspace_id !== question.workspaceId || payload.run_id !== question.runId ||
      payload.success !== true || !hasUniqueCreatedObjects(payload.created_objects) ||
      !hasExactCreatedObject(payload.created_objects, "memory_entry", binding.objectId) ||
      !hasExactCreatedObject(payload.created_objects, "evidence_capsule", binding.evidenceId)) {
    throw new Error(`snapshot signal materialization event mismatch for ${binding.signalId}`);
  }
}

function assertEvidenceBinding(
  evidenceId: string,
  round: LongMemEvalSnapshotSeedRound,
  question: LongMemEvalSnapshotQuestion,
  source: LongMemEvalQuestion,
  evidence: ReadonlyMap<string, StoredEvidenceRow>
): void {
  const row = evidence.get(evidenceId);
  const anchor = parseRecord(row?.physical_anchor, `physical anchor ${evidenceId}`);
  if (row === undefined || row.object_kind !== "evidence_capsule" ||
      row.workspace_id !== question.workspaceId || row.run_id !== question.runId ||
      !matchesRound(anchor.artifact_ref, round, source) || row.surface_id !== round.sessionId) {
    throw new Error(`snapshot seed evidence binding mismatch for ${evidenceId}`);
  }
}

function assertReconciliationNoop(
  db: DatabaseSync,
  binding: LongMemEvalSnapshotSeedBinding,
  question: LongMemEvalSnapshotQuestion,
  signal: StoredSignalRow
): void {
  const rows = db.prepare(`
    SELECT event_type, entity_type, entity_id, workspace_id, run_id, caused_by, payload_json
      FROM event_log WHERE entity_id = ?
  `).all(`${binding.signalId}:noop_audit`) as unknown as readonly StoredEventRow[];
  const row = rows[0];
  if (rows.length !== 1 || row === undefined) {
    throw new Error(`snapshot reconciliation NOOP proof mismatch for ${binding.signalId}`);
  }
  const payload = parseTriagePayload(row?.payload_json, binding.signalId);
  if (row.event_type !== SignalEventType.SOUL_SIGNAL_TRIAGED ||
      row.entity_type !== "candidate_memory_signal" ||
      row.entity_id !== `${binding.signalId}:noop_audit` ||
      row.workspace_id !== question.workspaceId || row.run_id !== question.runId ||
      row.caused_by !== "reconciliation_noop" ||
      payload.signal_id !== binding.signalId ||
      payload.workspace_id !== question.workspaceId || payload.run_id !== question.runId ||
      payload.triage_result !== "dropped" ||
      payload.dropped_content !== canonicalSignalFact(signal) ||
      payload.surviving_object_id !== binding.objectId ||
      payload.best_similarity === undefined) {
    throw new Error(`snapshot reconciliation NOOP proof mismatch for ${binding.signalId}`);
  }
}

function assertStoredMemoryEvidence(
  db: DatabaseSync,
  question: LongMemEvalSnapshotQuestion,
  sourcesByMemory: ReadonlyMap<string, ReadonlySet<string>>,
  evidenceByMemory: ReadonlyMap<string, ReadonlySet<string>>
): void {
  const rows = db.prepare(`
    SELECT object_id, evidence_refs FROM memory_entries WHERE workspace_id = ?
  `).all(question.workspaceId) as unknown as readonly StoredMemoryRow[];
  if (rows.length !== sourcesByMemory.size) {
    throw new Error(`snapshot seed ledger memory coverage mismatch for ${question.questionId}`);
  }
  const stored = new Map(rows.map((row) => [row.object_id, row]));
  for (const memoryId of sourcesByMemory.keys()) {
    const row = stored.get(memoryId);
    const actual = parseStringArray(row?.evidence_refs, `evidence refs ${memoryId}`);
    const expected = evidenceByMemory.get(memoryId) ?? new Set<string>();
    if (row === undefined || !equalSets(new Set(actual), expected)) {
      throw new Error(`snapshot seed ledger DB identity mismatch for ${memoryId}`);
    }
  }
}

function readStoredEvidence(
  db: DatabaseSync,
  workspaceId: string
): ReadonlyMap<string, StoredEvidenceRow> {
  const rows = db.prepare(`
    SELECT object_id, object_kind, workspace_id, run_id, surface_id, physical_anchor
      FROM evidence_capsules WHERE workspace_id = ?
  `).all(workspaceId) as unknown as readonly StoredEvidenceRow[];
  return new Map(rows.map((row) => [row.object_id, row]));
}

function addMemorySource(
  sources: Map<string, Set<string>>,
  objectId: string,
  round: LongMemEvalSnapshotSeedRound
): void {
  const key = `${round.sessionIndex}:${round.roundIndex}`;
  const prior = sources.get(objectId) ?? new Set<string>();
  prior.add(key);
  sources.set(objectId, prior);
}

function addEvidenceBinding(
  evidence: Map<string, Set<string>>,
  objectId: string,
  evidenceId: string
): void {
  const prior = evidence.get(objectId) ?? new Set<string>();
  prior.add(evidenceId);
  evidence.set(objectId, prior);
}

function matchesRound(
  artifactRef: unknown,
  expected: LongMemEvalSnapshotSeedRound,
  source: LongMemEvalQuestion
): boolean {
  const actual = resolveLongMemEvalSeedRoundIdentity(artifactRef, source);
  return actual.sessionIndex === expected.sessionIndex &&
    actual.roundIndex === expected.roundIndex && actual.sessionId === expected.sessionId &&
    actual.hasAnswer === expected.hasAnswer;
}

function parseTriagePayload(value: string | undefined, signalId: string) {
  const parsed = parseJson(value, `reconciliation NOOP payload ${signalId}`);
  const result = SoulSignalTriagedPayloadSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`snapshot reconciliation NOOP proof mismatch for ${signalId}`);
  }
  return result.data;
}

function parseMaterializedPayload(value: string | undefined, signalId: string) {
  const parsed = parseJson(value, `materialization event payload ${signalId}`);
  const result = SoulSignalMaterializedPayloadSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`snapshot signal materialization event mismatch for ${signalId}`);
  }
  return result.data;
}

function hasExactCreatedObject(
  created: readonly { readonly object_kind: string; readonly object_id: string }[],
  objectKind: string,
  objectId: string | null
): boolean {
  const objects = created.filter((object) => object.object_kind === objectKind);
  return objectId === null
    ? objects.length === 0
    : objects.length === 1 && objects[0]?.object_id === objectId;
}

function hasUniqueCreatedObjects(
  created: readonly { readonly object_kind: string; readonly object_id: string }[]
): boolean {
  return new Set(created.map((object) =>
    `${object.object_kind}:${object.object_id}`)).size === created.length;
}

function canonicalSignalFact(signal: StoredSignalRow): string {
  const raw = parseRecord(signal.raw_payload_json, `signal ${signal.signal_id} raw payload`);
  const value = raw.distilled_fact;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`snapshot reconciliation NOOP proof mismatch for ${signal.signal_id}`);
  }
  return value.trim();
}

function parseStringArray(value: string | undefined, label: string): readonly string[] {
  const parsed = parseJson(value, label);
  if (!Array.isArray(parsed) || parsed.length === 0 ||
      parsed.some((entry) => typeof entry !== "string" || entry.length === 0) ||
      new Set(parsed).size !== parsed.length) {
    throw new Error(`${label} must be a non-empty unique string array`);
  }
  return parsed as string[];
}

function parseRecord(value: string | null | undefined, label: string) {
  const parsed = parseJson(value ?? undefined, label);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${label} must be an object`);
  }
  return parsed as Record<string, unknown>;
}

function parseJson(value: string | undefined, label: string): unknown {
  if (value === undefined) throw new Error(`${label} is required`);
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error(`${label} must be valid JSON`);
  }
}

function equalSets(actual: ReadonlySet<string>, expected: ReadonlySet<string>): boolean {
  return actual.size === expected.size && [...actual].every((value) => expected.has(value));
}
