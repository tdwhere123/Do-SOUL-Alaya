import { createHash } from "node:crypto";
import {
  CandidateMemorySignalSchema,
  SignalEventType,
  SoulSignalMaterializedPayloadSchema,
  buildVerifiedUserAssertionReceiptPreimage,
  formatGardenSourceTurnFallbackSourceHash,
  formatGardenSourceTurnFallbackV2SourceHash,
  isGardenSourceTurnFallbackV2Receipt,
  readGardenSourceTurnFallbackArtifactSignalId,
  readVerifiedUserAssertionSourceHashDigest,
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
import type {
  EvidenceSearchMatch,
  RecallQualifiedEvidence
} from "./evidence-recall-types.js";
import {
  compareQualifiedProjectionIdentity,
  EvidenceProjectionIntegrityError,
  normalizeEvidenceSearchMatches,
  qualifyEvidenceMatch,
  readQualifiedProjectionIndex,
  type StoredProjectionRow
} from "./qualification/qualified-evidence-projection.js";

const QUERY_CHUNK_SIZE = 500;

interface QualificationStatements {
  readonly findEvidenceRows: BetterSqlite3.Statement;
  readonly findSignalRows: BetterSqlite3.Statement;
  readonly findMaterializationRows: BetterSqlite3.Statement;
  readonly findProjectionRows: BetterSqlite3.Statement;
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

interface EvidenceQualificationRow extends EvidenceCapsuleRow {
  readonly source_signal_id: string | null;
}

interface EvidenceCandidate {
  readonly capsule: Readonly<EvidenceCapsule>;
  readonly signalId: string | null;
}

interface QualificationInputs {
  readonly candidates: readonly EvidenceCandidate[];
  readonly signals: ReadonlyMap<string, Readonly<CandidateMemorySignal>>;
  readonly events: ReadonlyMap<string, readonly StoredMaterializationRow[]>;
}

interface QualifiedEvidenceProof {
  readonly turnReceipt: Readonly<GardenSourceTurnFallbackVerifiedReceipt> | null;
}

export class RecallQualifiedEvidenceReader {
  private readonly statementHolder: RefreshableStatementHolder<QualificationStatements>;

  public constructor(db: StorageDatabase) {
    this.statementHolder = new RefreshableStatementHolder(db, prepareStatements);
  }

  public find(
    workspaceId: string,
    requestedMatches: readonly EvidenceSearchMatch[]
  ): readonly RecallQualifiedEvidence[] {
    const matches = normalizeEvidenceSearchMatches(requestedMatches);
    if (matches.length === 0) return Object.freeze([]);
    const qualified: RecallQualifiedEvidence[] = [];
    for (let offset = 0; offset < matches.length; offset += QUERY_CHUNK_SIZE) {
      qualified.push(...this.findChunk(
        workspaceId,
        matches.slice(offset, offset + QUERY_CHUNK_SIZE)
      ));
    }
    return qualified.sort((left, right) =>
      left.capsule.created_at.localeCompare(right.capsule.created_at) ||
      left.capsule.object_id.localeCompare(right.capsule.object_id) ||
      compareQualifiedProjectionIdentity(left.matched_projection, right.matched_projection)
    );
  }

  public findReceiptQualifiedOwnerIds(
    workspaceId: string,
    requestedObjectIds: readonly string[]
  ): readonly string[] {
    const objectIds = [...new Set(requestedObjectIds
      .map((objectId) => objectId.trim())
      .filter((objectId) => objectId.length > 0))];
    const qualified: string[] = [];
    for (let offset = 0; offset < objectIds.length; offset += QUERY_CHUNK_SIZE) {
      qualified.push(...this.findReceiptQualifiedOwnerIdsChunk(
        workspaceId,
        objectIds.slice(offset, offset + QUERY_CHUNK_SIZE)
      ));
    }
    return Object.freeze(qualified.sort((left, right) => left.localeCompare(right)));
  }

  private findChunk(
    workspaceId: string,
    matches: readonly EvidenceSearchMatch[]
  ): readonly RecallQualifiedEvidence[] {
    const evidenceObjectIds = [...new Set(matches.map((match) => match.object_id))];
    const { candidates, signals, events } = this.readQualificationInputs(
      workspaceId,
      evidenceObjectIds
    );
    if (candidates.length === 0) return [];
    const projections = readQualifiedProjectionIndex(
      this.statementHolder.active().findProjectionRows.all(
        workspaceId,
        JSON.stringify(evidenceObjectIds)
      ) as StoredProjectionRow[]
    );
    const candidateById = new Map(candidates.map((candidate) => [
      candidate.capsule.object_id,
      candidate
    ]));
    return matches.flatMap((match) => {
      const candidate = candidateById.get(match.object_id);
      if (candidate === undefined) return [];
      const proof = readQualifiedProof(
        candidate,
        candidate.signalId === null ? undefined : signals.get(candidate.signalId),
        events,
        match.matched_projection !== undefined
      );
      if (proof === null) return [];
      const qualified = qualifyEvidenceMatch(
        match,
        candidate.capsule,
        proof.turnReceipt,
        projections,
        candidate.signalId === null ? undefined : signals.get(candidate.signalId)
      );
      return qualified === null ? [] : [qualified];
    });
  }

  private findReceiptQualifiedOwnerIdsChunk(
    workspaceId: string,
    objectIds: readonly string[]
  ): readonly string[] {
    const { candidates, signals, events } = this.readQualificationInputs(
      workspaceId,
      objectIds
    );
    return candidates.flatMap((candidate) => {
      const proof = readQualifiedProof(
        candidate,
        candidate.signalId === null ? undefined : signals.get(candidate.signalId),
        events,
        false
      );
      return proof === null ? [] : [candidate.capsule.object_id];
    });
  }

  private readQualificationInputs(
    workspaceId: string,
    evidenceObjectIds: readonly string[]
  ): QualificationInputs {
    const candidates = readEvidenceCandidates(
      this.statementHolder.active().findEvidenceRows.all(
        workspaceId,
        JSON.stringify(evidenceObjectIds)
      ) as EvidenceQualificationRow[]
    );
    const signalIds = [...new Set(candidates.flatMap((candidate) =>
      candidate.signalId === null ? [] : [candidate.signalId]
    ))];
    const signals = readSignals(this.statementHolder.active().findSignalRows.all(
      workspaceId,
      JSON.stringify(signalIds)
    ) as StoredSignalRow[]);
    const events = groupEvents(this.statementHolder.active().findMaterializationRows.all(
      workspaceId,
      JSON.stringify(signalIds),
      SignalEventType.SOUL_SIGNAL_MATERIALIZED
    ) as StoredMaterializationRow[]);
    return { candidates, signals, events };
  }
}

function prepareStatements(db: StorageDatabase): QualificationStatements {
  return {
    findEvidenceRows: db.connection.prepare(FIND_EVIDENCE_ROWS_SQL),
    findSignalRows: db.connection.prepare(FIND_SIGNAL_ROWS_SQL),
    findMaterializationRows: db.connection.prepare(FIND_MATERIALIZATION_ROWS_SQL),
    findProjectionRows: db.connection.prepare(FIND_PROJECTION_ROWS_SQL)
  };
}

function readEvidenceCandidates(
  rows: readonly EvidenceQualificationRow[]
): readonly EvidenceCandidate[] {
  const candidates: EvidenceCandidate[] = [];
  for (const row of rows) {
    const candidate = readEvidenceCandidate(row);
    if (candidate !== null) candidates.push(candidate);
  }
  return candidates;
}

function readEvidenceCandidate(row: EvidenceQualificationRow): EvidenceCandidate | null {
  try {
    const capsule = parseEvidenceCapsuleRow(row);
    const signalId = row.source_signal_id ?? readGardenSourceTurnFallbackArtifactSignalId(
      capsule.physical_anchor?.artifact_ref ?? null
    );
    return matchesEvidenceEnvelope(capsule) ? { capsule, signalId } : null;
  } catch (error) {
    process.emitWarning("evidence candidate parse failed; skipping row", {
      code: "ALAYA_EVIDENCE_CANDIDATE_PARSE_FAILED",
      detail: JSON.stringify({
        layer: "storage",
        object_id: row.object_id,
        error: error instanceof Error ? error.message : "unknown"
      })
    });
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

function readQualifiedProof(
  candidate: EvidenceCandidate,
  signal: Readonly<CandidateMemorySignal> | undefined,
  events: ReadonlyMap<string, readonly StoredMaterializationRow[]>,
  strictProjection: boolean
): Readonly<QualifiedEvidenceProof> | null {
  if (readVerifiedUserAssertionSourceHashDigest(candidate.capsule.source_hash) !== null) {
    return matchesAssertionReceipt(candidate.capsule)
      ? Object.freeze({ turnReceipt: null })
      : rejectProof(candidate, strictProjection);
  }
  if (candidate.signalId === null) return null;
  if (signal === undefined) return null;
  const receipt = verifyGardenSourceTurnFallbackReceipt(signal, sha256);
  if (receipt === null) return null;
  if (!matchesReceipt(candidate, receipt)) {
    return rejectProof(candidate, strictProjection);
  }
  const materializations = events.get(candidate.signalId) ?? [];
  return materializations.length === 1 &&
    matchesMaterialization(materializations[0]!, candidate, receipt)
    ? Object.freeze({ turnReceipt: receipt })
    : null;
}

function rejectProof(
  candidate: EvidenceCandidate,
  strictProjection: boolean
): null {
  if (strictProjection) {
    throw new EvidenceProjectionIntegrityError(
      candidate.capsule.object_id,
      "requested projection owner does not match its verified receipt"
    );
  }
  return null;
}

function matchesAssertionReceipt(capsule: Readonly<EvidenceCapsule>): boolean {
  const observedDigest = readVerifiedUserAssertionSourceHashDigest(capsule.source_hash);
  const assertion = capsule.excerpt?.trim() ?? "";
  if (observedDigest === null || assertion.length === 0) return false;
  const expectedDigest = createHash("sha256")
    .update(buildVerifiedUserAssertionReceiptPreimage({
      workspace_id: capsule.workspace_id,
      run_id: capsule.run_id,
      surface_id: capsule.surface_id,
      source_assertion: assertion,
      source_corpus: capsule.gist
    }), "utf8")
    .digest("hex");
  return observedDigest === expectedDigest;
}

function matchesReceipt(
  candidate: EvidenceCandidate,
  receipt: Readonly<GardenSourceTurnFallbackVerifiedReceipt>
): boolean {
  const capsule = candidate.capsule;
  if (candidate.signalId === null) return false;
  return receipt.signal_id === candidate.signalId &&
    receipt.source_observation?.authority === "trusted_host_event" &&
    capsule.workspace_id === receipt.workspace_id &&
    capsule.run_id === receipt.run_id &&
    capsule.surface_id === receipt.surface_id &&
    capsule.gist === receipt.source_corpus &&
    matchesReceiptSourceHash(capsule, receipt);
}

function matchesReceiptSourceHash(
  capsule: Readonly<EvidenceCapsule>,
  receipt: Readonly<GardenSourceTurnFallbackVerifiedReceipt>
): boolean {
  const expected = isGardenSourceTurnFallbackV2Receipt(receipt)
    ? formatGardenSourceTurnFallbackV2SourceHash(receipt.digest)
    : formatGardenSourceTurnFallbackSourceHash(receipt.digest);
  return capsule.source_hash === expected;
}

function matchesMaterialization(
  row: StoredMaterializationRow,
  candidate: EvidenceCandidate,
  receipt: Readonly<GardenSourceTurnFallbackVerifiedReceipt>
): boolean {
  if (candidate.signalId === null) return false;
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
         run_id, workspace_id, surface_id,
         (
           SELECT CASE WHEN COUNT(*) = 1 THEN MIN(owner.signal_id) ELSE NULL END
           FROM recall_routing_key_owners AS owner
           WHERE owner.workspace_id = evidence_capsules.workspace_id
             AND owner.owner_kind = 'evidence_capsule'
             AND owner.owner_id = evidence_capsules.object_id
         ) AS source_signal_id
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

const FIND_PROJECTION_ROWS_SQL = `
  SELECT projection.evidence_object_id, projection.projection_id,
         projection.projection_kind, projection.workspace_id, projection.source_hash,
         projection.content, formation.workspace_id AS formation_workspace_id,
         formation.schema_version AS formation_schema_version,
         formation.operator_id AS formation_operator_id, formation.status AS formation_status,
         formation.producer_operator_id AS formation_producer_operator_id,
         formation.source_hash AS formation_source_hash,
         formation.fact_frame_json AS formation_fact_frame_json,
         formation.capture_digest AS formation_capture_digest
  FROM evidence_search_projections AS projection
  LEFT JOIN evidence_fact_frame_formations AS formation
    ON formation.evidence_object_id = projection.evidence_object_id
  WHERE projection.workspace_id = ?
    AND projection.evidence_object_id IN (SELECT value FROM json_each(?))
`;
