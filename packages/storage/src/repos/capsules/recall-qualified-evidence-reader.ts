import { createHash } from "node:crypto";
import {
  CandidateMemorySignalSchema,
  SignalEventType,
  SoulSignalMaterializedPayloadSchema,
  formatGardenSourceTurnFallbackSourceHash,
  formatGardenSourceTurnFallbackV2SourceHash,
  isGardenSourceTurnFallbackV2Receipt,
  projectGardenSourceTurnFallbackV2UserContent,
  readGardenSourceTurnFallbackArtifactSignalId,
  verifyGardenSourceTurnFallbackReceipt,
  type CandidateMemorySignal,
  type EvidenceCapsule,
  type GardenSourceTurnFallbackVerifiedReceipt
} from "@do-soul/alaya-protocol";
import type BetterSqlite3 from "better-sqlite3";
import type { StorageDatabase } from "../../sqlite/db.js";
import { RefreshableStatementHolder } from "../../sqlite/refreshable-statement-holder.js";
import {
  parseEvidenceCapsuleRow,
  type EvidenceCapsuleRow
} from "./evidence-capsule-mappers.js";

const QUERY_CHUNK_SIZE = 500;

interface QualificationStatements {
  readonly findEvidenceRows: BetterSqlite3.Statement;
  readonly findSignalRows: BetterSqlite3.Statement;
  readonly findMaterializationRows: BetterSqlite3.Statement;
}

interface StoredSignalRow {
  readonly signal_id: string;
  readonly workspace_id: string;
  readonly run_id: string;
  readonly surface_id: string | null;
  readonly source: string;
  readonly signal_kind: string;
  readonly object_kind: string;
  readonly scope_hint: string | null;
  readonly domain_tags_json: string;
  readonly confidence: number;
  readonly evidence_refs_json: string;
  readonly source_memory_refs_json: string;
  readonly supersedes_refs_json: string;
  readonly exception_to_refs_json: string;
  readonly contradicts_refs_json: string;
  readonly incompatible_with_refs_json: string;
  readonly raw_payload_json: string;
  readonly source_delivery_ids_json: string | null;
  readonly source_observation_json: string | null;
  readonly signal_state: string;
  readonly created_at: string;
}

interface StoredMaterializationRow {
  readonly event_type: string;
  readonly entity_type: string;
  readonly entity_id: string;
  readonly workspace_id: string;
  readonly run_id: string | null;
  readonly caused_by: string | null;
  readonly payload_json: string;
}

interface EvidenceCandidate {
  readonly capsule: Readonly<EvidenceCapsule>;
  readonly signalId: string;
}

export class RecallQualifiedEvidenceReader {
  private readonly statementHolder: RefreshableStatementHolder<QualificationStatements>;

  public constructor(db: StorageDatabase) {
    this.statementHolder = new RefreshableStatementHolder(db, prepareStatements);
  }

  public find(
    workspaceId: string,
    evidenceObjectIds: readonly string[]
  ): readonly Readonly<EvidenceCapsule>[] {
    const ids = uniqueNonEmpty(evidenceObjectIds);
    if (ids.length === 0) return [];
    const qualified: Readonly<EvidenceCapsule>[] = [];
    for (let offset = 0; offset < ids.length; offset += QUERY_CHUNK_SIZE) {
      qualified.push(...this.findChunk(workspaceId, ids.slice(offset, offset + QUERY_CHUNK_SIZE)));
    }
    return qualified.sort((left, right) =>
      left.created_at.localeCompare(right.created_at) ||
      left.object_id.localeCompare(right.object_id)
    );
  }

  private findChunk(
    workspaceId: string,
    evidenceObjectIds: readonly string[]
  ): readonly Readonly<EvidenceCapsule>[] {
    const candidates = readEvidenceCandidates(
      this.statementHolder.active().findEvidenceRows.all(
        workspaceId,
        JSON.stringify(evidenceObjectIds)
      ) as EvidenceCapsuleRow[]
    );
    if (candidates.length === 0) return [];
    const signalIds = [...new Set(candidates.map((candidate) => candidate.signalId))];
    const signals = readSignals(this.statementHolder.active().findSignalRows.all(
      workspaceId,
      JSON.stringify(signalIds)
    ) as StoredSignalRow[]);
    const events = groupEvents(this.statementHolder.active().findMaterializationRows.all(
      workspaceId,
      JSON.stringify(signalIds),
      SignalEventType.SOUL_SIGNAL_MATERIALIZED
    ) as StoredMaterializationRow[]);
    return candidates
      .filter((candidate) => isQualified(candidate, signals.get(candidate.signalId), events))
      .map((candidate) => candidate.capsule);
  }
}

function prepareStatements(db: StorageDatabase): QualificationStatements {
  return {
    findEvidenceRows: db.connection.prepare(FIND_EVIDENCE_ROWS_SQL),
    findSignalRows: db.connection.prepare(FIND_SIGNAL_ROWS_SQL),
    findMaterializationRows: db.connection.prepare(FIND_MATERIALIZATION_ROWS_SQL)
  };
}

function readEvidenceCandidates(
  rows: readonly EvidenceCapsuleRow[]
): readonly EvidenceCandidate[] {
  const candidates: EvidenceCandidate[] = [];
  for (const row of rows) {
    const candidate = readEvidenceCandidate(row);
    if (candidate !== null) candidates.push(candidate);
  }
  return candidates;
}

function readEvidenceCandidate(row: EvidenceCapsuleRow): EvidenceCandidate | null {
  try {
    const capsule = parseEvidenceCapsuleRow(row);
    const signalId = readGardenSourceTurnFallbackArtifactSignalId(
      capsule.physical_anchor?.artifact_ref ?? null
    );
    return signalId !== null && matchesEvidenceEnvelope(capsule)
      ? { capsule, signalId }
      : null;
  } catch {
    return null;
  }
}

function matchesEvidenceEnvelope(capsule: Readonly<EvidenceCapsule>): boolean {
  return capsule.lifecycle_state === "active" &&
    capsule.created_by === "garden_compile" &&
    capsule.evidence_health_state === "verified" &&
    capsule.evidence_kind === "conversation_excerpt";
}

function readSignals(
  rows: readonly StoredSignalRow[]
): ReadonlyMap<string, Readonly<CandidateMemorySignal>> {
  const signals = new Map<string, Readonly<CandidateMemorySignal>>();
  for (const row of rows) {
    const signal = readSignal(row);
    if (signal !== null) signals.set(signal.signal_id, signal);
  }
  return signals;
}

function readSignal(row: StoredSignalRow): Readonly<CandidateMemorySignal> | null {
  const parsed = CandidateMemorySignalSchema.safeParse({
    signal_id: row.signal_id,
    workspace_id: row.workspace_id,
    run_id: row.run_id,
    surface_id: row.surface_id,
    source: row.source,
    signal_kind: row.signal_kind,
    object_kind: row.object_kind,
    scope_hint: row.scope_hint,
    domain_tags: parseJson(row.domain_tags_json),
    confidence: row.confidence,
    evidence_refs: parseJson(row.evidence_refs_json),
    source_memory_refs: parseJson(row.source_memory_refs_json),
    supersedes_refs: parseJson(row.supersedes_refs_json),
    exception_to_refs: parseJson(row.exception_to_refs_json),
    contradicts_refs: parseJson(row.contradicts_refs_json),
    incompatible_with_refs: parseJson(row.incompatible_with_refs_json),
    raw_payload: parseJson(row.raw_payload_json),
    source_observation: parseJson(row.source_observation_json),
    signal_state: row.signal_state,
    created_at: row.created_at,
    ...(row.source_delivery_ids_json === null
      ? {}
      : { source_delivery_ids: parseJson(row.source_delivery_ids_json) })
  });
  return parsed.success && parsed.data.signal_state === "materialized"
    ? parsed.data
    : null;
}

function groupEvents(
  rows: readonly StoredMaterializationRow[]
): ReadonlyMap<string, readonly StoredMaterializationRow[]> {
  const grouped = new Map<string, StoredMaterializationRow[]>();
  for (const row of rows) {
    const current = grouped.get(row.entity_id);
    if (current === undefined) grouped.set(row.entity_id, [row]);
    else current.push(row);
  }
  return grouped;
}

function isQualified(
  candidate: EvidenceCandidate,
  signal: Readonly<CandidateMemorySignal> | undefined,
  events: ReadonlyMap<string, readonly StoredMaterializationRow[]>
): boolean {
  if (signal === undefined) return false;
  const receipt = verifyGardenSourceTurnFallbackReceipt(signal, sha256);
  if (receipt === null || !matchesReceipt(candidate, receipt)) return false;
  const materializations = events.get(candidate.signalId) ?? [];
  return materializations.length === 1 &&
    matchesMaterialization(materializations[0]!, candidate, receipt);
}

function matchesReceipt(
  candidate: EvidenceCandidate,
  receipt: Readonly<GardenSourceTurnFallbackVerifiedReceipt>
): boolean {
  const capsule = candidate.capsule;
  return receipt.signal_id === candidate.signalId &&
    receipt.source_observation?.authority === "trusted_host_event" &&
    capsule.workspace_id === receipt.workspace_id &&
    capsule.run_id === receipt.run_id &&
    capsule.surface_id === receipt.surface_id &&
    capsule.gist === receipt.source_corpus &&
    matchesReceiptProjection(capsule, receipt);
}

function matchesReceiptProjection(
  capsule: Readonly<EvidenceCapsule>,
  receipt: Readonly<GardenSourceTurnFallbackVerifiedReceipt>
): boolean {
  if (isGardenSourceTurnFallbackV2Receipt(receipt)) {
    return capsule.excerpt === projectGardenSourceTurnFallbackV2UserContent(receipt) &&
      capsule.source_hash === formatGardenSourceTurnFallbackV2SourceHash(receipt.digest);
  }
  return capsule.excerpt === receipt.source_corpus &&
    capsule.source_hash === formatGardenSourceTurnFallbackSourceHash(receipt.digest);
}

function matchesMaterialization(
  row: StoredMaterializationRow,
  candidate: EvidenceCandidate,
  receipt: Readonly<GardenSourceTurnFallbackVerifiedReceipt>
): boolean {
  const payload = SoulSignalMaterializedPayloadSchema.safeParse(parseJson(row.payload_json));
  if (!payload.success) return false;
  const created = payload.data.created_objects;
  return row.event_type === SignalEventType.SOUL_SIGNAL_MATERIALIZED &&
    row.entity_type === "candidate_memory_signal" &&
    row.entity_id === candidate.signalId &&
    row.workspace_id === receipt.workspace_id &&
    row.run_id === receipt.run_id &&
    row.caused_by === "materialization_router" &&
    payload.data.signal_id === candidate.signalId &&
    payload.data.workspace_id === receipt.workspace_id &&
    payload.data.run_id === receipt.run_id &&
    payload.data.success === true &&
    created.length === 1 &&
    created[0]?.object_kind === "evidence_capsule" &&
    created[0].object_id === candidate.capsule.object_id;
}

function uniqueNonEmpty(values: readonly string[]): readonly string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))];
}

function parseJson(value: string | null): unknown {
  if (value === null) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

const FIND_EVIDENCE_ROWS_SQL = `
  SELECT object_id, object_kind, schema_version, lifecycle_state, created_at,
         updated_at, created_by, evidence_kind, semantic_anchor, event_anchor,
         physical_anchor, evidence_health_state, gist, excerpt, source_hash,
         run_id, workspace_id, surface_id
  FROM evidence_capsules
  WHERE workspace_id = ?
    AND object_id IN (SELECT value FROM json_each(?))
`;

const FIND_SIGNAL_ROWS_SQL = `
  SELECT signal_id, workspace_id, run_id, surface_id, source, signal_kind,
         object_kind, scope_hint, domain_tags_json, confidence, evidence_refs_json,
         source_memory_refs_json, supersedes_refs_json, exception_to_refs_json,
         contradicts_refs_json, incompatible_with_refs_json, raw_payload_json,
         source_delivery_ids_json, source_observation_json, signal_state, created_at
  FROM signals
  WHERE workspace_id = ?
    AND signal_id IN (SELECT value FROM json_each(?))
`;

const FIND_MATERIALIZATION_ROWS_SQL = `
  SELECT event_type, entity_type, entity_id, workspace_id, run_id, caused_by,
         payload_json
  FROM event_log INDEXED BY idx_event_log_entity
  WHERE workspace_id = ?
    AND entity_type = 'candidate_memory_signal'
    AND entity_id IN (SELECT value FROM json_each(?))
    AND event_type = ?
`;
