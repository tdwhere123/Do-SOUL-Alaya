import { createHash } from "node:crypto";
import {
  BoundSourceStatementSchema, HistoricalMemoryCaptureSchema, HistoricalMemoryCaptureCandidateSchema,
  canonicalJson, createHistoricalMemoryCapture, verifyHistoricalMemoryCapture, historicalCaptureTerminalMember,
  sourceStatementArtifact, sourceIndexStatementTarget, hashContentDigest,
  type HistoricalMemoryCapture, type HistoricalMemoryCaptureNomination, type HistoricalMemoryReadResult,
  type HistoricalMemoryCaptureCandidate, type MemoryEntry
} from "@do-soul/alaya-protocol";
import type { StorageDatabase } from "../../sqlite/db.js";
import { StorageError } from "../../shared/errors.js";
import { parseMemoryEntryRow, type MemoryEntryRow } from "../memory-entry/mappers/row-mapper.js";
import { parseSynthesisCapsuleRow, type SynthesisCapsuleRow } from "../capsules/mappers/synthesis-capsule-mapper.js";
import { parseEvidenceCapsuleRow } from "../capsules/mappers/evidence-capsule-mappers.js";
import { sharedSourceRecordRepo } from "../field/source-repo.js";
import { verifyPersistedSourceRecord, assertSubjectNotErased } from "../field/identity.js";
import { requirePrivacyObjectAvailable } from "../field/privacy-availability.js";
import { requireCurrentStatementMemory } from "../source-index/statement-dependencies.js";

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const ineligible = (reason: string): HistoricalMemoryCaptureNomination => ({ status: "ineligible", reason });

/** One native read snapshot, followed by Core validation and same-transaction adoption CAS. */
export function readHistoricalCaptureCandidate(database: StorageDatabase, workspaceId: string,
  memoryId: string, capsuleId: string): HistoricalMemoryCaptureNomination {
  const read = () => captureCandidate(database, workspaceId, memoryId, capsuleId);
  return database.connection.inTransaction ? read() : database.connection.transaction(read)();
}

function captureCandidate(database: StorageDatabase, workspaceId: string,
  memoryId: string, capsuleId: string): HistoricalMemoryCaptureNomination {
  const connection = database.connection;
  const memory = connection.prepare("SELECT * FROM memory_entries WHERE workspace_id=? AND object_id=?")
    .get(workspaceId, memoryId) as MemoryEntryRow | undefined;
  const capsuleRow = connection.prepare("SELECT * FROM synthesis_capsules WHERE workspace_id=? AND object_id=?")
    .get(workspaceId, capsuleId) as SynthesisCapsuleRow | undefined;
  const binding = connection.prepare("SELECT artifact_id FROM source_statement_memory_bindings WHERE workspace_id=? AND memory_id=?")
    .get(workspaceId, memoryId) as { artifact_id: string } | undefined;
  if (memory === undefined || capsuleRow === undefined || binding === undefined) return ineligible("missing_statement_binding_or_capsule");
  requirePrivacyObjectAvailable(database, workspaceId, "memory_entry", memoryId);
  requirePrivacyObjectAvailable(database, workspaceId, "synthesis_capsule", capsuleId);
  requireCurrentStatementMemory(database, workspaceId, memoryId);
  const member = parseMemoryEntryRow(memory), capsule = parseSynthesisCapsuleRow(capsuleRow);
  const evidenceRow = connection.prepare("SELECT * FROM evidence_capsules WHERE workspace_id=? AND object_id=?")
    .get(workspaceId, binding.artifact_id);
  const persistedArtifact = connection.prepare("SELECT target_json,key_text FROM source_statement_artifacts WHERE workspace_id=? AND artifact_id=?")
    .get(workspaceId, binding.artifact_id) as { target_json: string; key_text: string } | undefined;
  if (evidenceRow === undefined || persistedArtifact === undefined) return ineligible("statement_artifact_unavailable");
  const evidence = parseEvidenceCapsuleRow(evidenceRow);
  let rawBound: unknown;
  try { rawBound = JSON.parse(evidence.gist); } catch { return ineligible("invalid_statement_material"); }
  const parsed = BoundSourceStatementSchema.safeParse(rawBound);
  if (!parsed.success || canonicalJson(rawBound) !== canonicalJson(parsed.data)) return ineligible("incomplete_statement_material");
  const artifact = sourceStatementArtifact(parsed.data, evidence.object_id, sha256);
  if (persistedArtifact.target_json !== canonicalJson(sourceIndexStatementTarget(artifact, parsed.data.artifact_key)) ||
      persistedArtifact.key_text !== artifact.key_text) return ineligible("statement_artifact_mismatch");
  const dependencies = connection.prepare("SELECT record_id AS root_id,source_id FROM source_statement_dependencies WHERE workspace_id=? AND artifact_id=? ORDER BY record_id")
    .all(workspaceId, binding.artifact_id) as { root_id: string; source_id: string }[];
  if (dependencies.length === 0) return ineligible("missing_statement_dependencies");
  const sourceRecords = captureSources(database, workspaceId, dependencies, member.scope_class);
  if (sourceRecords === null) return ineligible("source_dependency_unavailable");
  const revision = connection.prepare("SELECT revision FROM preservation_capsule_revisions WHERE workspace_id=? AND capsule_id=?")
    .get(workspaceId, capsuleId) as { revision: number } | undefined;
  if (revision === undefined) return ineligible("capsule_revision_unavailable");
  return { status: "ready", candidate: HistoricalMemoryCaptureCandidateSchema.parse({ member, capsule,
    evidence, artifact, capsule_revision: revision.revision, binding_artifact_id: binding.artifact_id,
    dependencies, source_records: sourceRecords }) };
}

function captureSources(database: StorageDatabase, workspaceId: string,
  dependencies: readonly { root_id: string; source_id: string }[], scope: MemoryEntry["scope_class"]
): HistoricalMemoryCaptureCandidate["source_records"] | null {
  const repo = sharedSourceRecordRepo(database, sha256);
  const records = new Map<string, HistoricalMemoryCaptureCandidate["source_records"][number]>();
  const pending = [...dependencies];
  while (pending.length > 0) {
    const dependency = pending.pop()!;
    if (records.has(dependency.root_id)) continue;
    const source = repo.findCurrent(workspaceId, dependency.source_id);
    if (source === null || source.record_id !== dependency.root_id || source.source_body === null ||
        (source.scope_class ?? "project") !== scope) return null;
    assertSubjectNotErased(database, workspaceId, "source_record", source.record_id);
    verifyPersistedSourceRecord(source, sha256);
    const originIds = source.source_representation?.kind === "canonical_projection" ? source.source_representation.source_record_ids : [];
    records.set(source.record_id, { reference: { workspace_id: workspaceId, root_id: source.record_id,
      source_id: source.source_id, source_version: source.source_version, content_digest: source.content_digest },
      scope_class: source.scope_class, dependencies: originIds });
    for (const originId of originIds) {
      const origin = repo.findById(workspaceId, originId);
      if (origin === null) return null;
      pending.push({ root_id: originId, source_id: origin.source_id });
    }
  }
  return [...records.values()].sort((a, b) => a.reference.root_id.localeCompare(b.reference.root_id));
}

/** Called only inside the autonomous tombstone owner's transaction, before its guarded UPDATE. */
export function adoptHistoricalMemoryCapture(database: StorageDatabase, input: HistoricalMemoryCapture): void {
  if (!database.connection.inTransaction) throw new StorageError("CONFLICT", "historical capture requires the terminal transaction");
  const captured = HistoricalMemoryCaptureSchema.parse(input);
  const native = readHistoricalCaptureCandidate(database, captured.workspace_id, captured.member.object_id, captured.capsule_id);
  const expected = native.status === "ready" ? createHistoricalMemoryCapture(native.candidate, captured.terminal_updated_at, sha256) : null;
  if (expected === null || canonicalJson(expected) !== canonicalJson(captured)) {
    throw new StorageError("CONFLICT", "historical capture is incomplete, forged, or no longer current");
  }
  database.connection.prepare(`INSERT INTO historical_memory_captures
    (workspace_id,memory_id,capsule_id,capture_id,capsule_revision,evidence_id,terminal_updated_at,source_roots_json,material_json,state)
    VALUES(?,?,?,?,?,?,?,?,?,'active')`).run(captured.workspace_id, captured.member.object_id, captured.capsule_id,
    captured.capture_id, captured.capsule_revision, captured.evidence_id, captured.terminal_updated_at,
    canonicalJson(captured.source_roots), canonicalJson(captured));
}

export function sealHistoricalMemoryCapture(database: StorageDatabase, capture: HistoricalMemoryCapture, eventId: string): void {
  const result = database.connection.prepare(`UPDATE historical_memory_captures SET audit_event_id=?
    WHERE workspace_id=? AND capture_id=? AND state='active' AND audit_event_id IS NULL`)
    .run(eventId, capture.workspace_id, capture.capture_id);
  if (result.changes !== 1) throw new StorageError("CONFLICT", "historical capture could not bind its transition audit");
}

export function readHistoricalMember(database: StorageDatabase, workspaceId: string,
  capsuleId: string, memoryId: string): HistoricalMemoryReadResult {
  const read = () => readCapturedMember(database, workspaceId, capsuleId, memoryId);
  return database.connection.inTransaction ? read() : database.connection.transaction(read)();
}

function readCapturedMember(database: StorageDatabase, workspaceId: string,
  capsuleId: string, memoryId: string): HistoricalMemoryReadResult {
  const row = database.connection.prepare(`SELECT material_json,state,audit_event_id FROM historical_memory_captures
    WHERE workspace_id=? AND capsule_id=? AND memory_id=?`).get(workspaceId, capsuleId, memoryId) as
    { material_json: string | null; state: "active" | "invalidated" | "erased"; audit_event_id: string | null } | undefined;
  if (row === undefined) return { status: "missing" };
  if (row.state !== "active") return { status: row.state };
  if (row.material_json === null || row.audit_event_id === null) return { status: "unavailable" };
  let history: HistoricalMemoryCapture;
  try { history = HistoricalMemoryCaptureSchema.parse(JSON.parse(row.material_json)); }
  catch { return { status: "unavailable" }; }
  if (!verifyHistoricalMemoryCapture(history, sha256) || database.connection.prepare(`SELECT 1 FROM historical_preservation_available
    WHERE workspace_id=? AND capture_id=?`).get(workspaceId, history.capture_id) === undefined) return { status: "unavailable" };
  const evidenceRow = database.connection.prepare("SELECT * FROM evidence_capsules WHERE workspace_id=? AND object_id=?")
    .get(workspaceId, history.evidence_id);
  if (hashContentDigest(canonicalJson(parseEvidenceCapsuleRow(evidenceRow)), sha256) !== history.evidence_digest) {
    return { status: "unavailable" };
  }
  const memory = database.connection.prepare("SELECT * FROM memory_entries WHERE workspace_id=? AND object_id=?")
    .get(workspaceId, memoryId) as MemoryEntryRow | undefined;
  if (memory !== undefined && canonicalJson(parseMemoryEntryRow(memory)) !== canonicalJson(historicalCaptureTerminalMember(history))) {
    return { status: "unavailable" };
  }
  return { status: "ready", history };
}
