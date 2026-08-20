import { createHash } from "node:crypto";
import {
  RelationAssertionEvidenceReceiptSchema,
  type RelationAssertionEvidenceReceipt
} from "@do-soul/alaya-protocol";
import type { StorageDatabase } from "../../sqlite/db.js";
import { StorageError } from "../../shared/errors.js";

export interface MemoryHqRecord {
  readonly object_id: string;
  readonly workspace_id: string;
  readonly hqs: readonly string[];
  readonly evidence_receipt: RelationAssertionEvidenceReceipt;
  readonly producer_id: string;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface MemoryHqEvidenceRecord extends Omit<MemoryHqRecord, "evidence_receipt"> {
  readonly evidence_id: string;
}

export interface MemoryHqObservationRecord extends MemoryHqRecord {
  readonly observation_id: string;
  readonly hq_content_sha256: string;
  readonly observation_sha256: string;
  readonly recorded_at: string;
}

export interface MemoryHqRepo {
  upsert(record: MemoryHqRecord): Promise<Readonly<MemoryHqObservationRecord>>;
  upsertFromEvidence(record: MemoryHqEvidenceRecord): Promise<Readonly<MemoryHqObservationRecord>>;
  getHqByObjectIds(
    objectIds: readonly string[]
  ): Promise<ReadonlyMap<string, readonly string[]>>;
  getObservationsByObjectIds(
    objectIds: readonly string[]
  ): Promise<ReadonlyMap<string, Readonly<MemoryHqObservationRecord>>>;
}

interface ObservationRow {
  readonly observation_id: string;
  readonly object_id: string;
  readonly workspace_id: string;
  readonly evidence_id: string;
  readonly source_event_type: string;
  readonly source_event_id: string;
  readonly source_occurred_at: string;
  readonly producer_id: string;
  readonly observation_hqs_json: string;
  readonly current_hqs_json: string;
  readonly hq_content_sha256: string;
  readonly observation_sha256: string;
  readonly recorded_at: string;
  readonly created_at: string;
  readonly updated_at: string;
}

const HQ_LOOKUP_CHUNK = 500;

export class SqliteMemoryHqRepo implements MemoryHqRepo {
  public constructor(private readonly db: StorageDatabase) {}

  public async upsert(record: MemoryHqRecord): Promise<Readonly<MemoryHqObservationRecord>> {
    const observation = buildObservation(record);
    try {
      this.assertEvidenceReceipt(record.workspace_id, record.evidence_receipt);
      this.db.connection.transaction(() => {
        this.insertOrVerifyObservation(observation);
        this.db.connection.prepare(UPSERT_MEMORY_HQ_SQL).run(
          record.object_id,
          record.workspace_id,
          JSON.stringify(record.hqs),
          observation.observation_id,
          record.created_at,
          record.updated_at
        );
      })();
      return observation;
    } catch (error) {
      if (error instanceof StorageError) throw error;
      throw new StorageError("QUERY_FAILED", `Failed to persist memory HQ for ${record.object_id}.`, error);
    }
  }

  public async upsertFromEvidence(
    record: MemoryHqEvidenceRecord
  ): Promise<Readonly<MemoryHqObservationRecord>> {
    const evidenceReceipt = this.readEvidenceReceipt(record.workspace_id, record.evidence_id);
    return await this.upsert({
      object_id: record.object_id,
      workspace_id: record.workspace_id,
      hqs: record.hqs,
      evidence_receipt: evidenceReceipt,
      producer_id: record.producer_id,
      created_at: record.created_at,
      updated_at: record.updated_at
    });
  }

  public async getHqByObjectIds(
    objectIds: readonly string[]
  ): Promise<ReadonlyMap<string, readonly string[]>> {
    const observations = await this.getObservationsByObjectIds(objectIds);
    return new Map([...observations].map(([objectId, observation]) => [
      objectId,
      observation.hqs
    ]));
  }

  public async getObservationsByObjectIds(
    objectIds: readonly string[]
  ): Promise<ReadonlyMap<string, Readonly<MemoryHqObservationRecord>>> {
    const unique = Array.from(new Set(objectIds));
    const result = new Map<string, Readonly<MemoryHqObservationRecord>>();
    try {
      for (let offset = 0; offset < unique.length; offset += HQ_LOOKUP_CHUNK) {
        const chunk = unique.slice(offset, offset + HQ_LOOKUP_CHUNK);
        if (chunk.length === 0) continue;
        const placeholders = chunk.map(() => "?").join(", ");
        const rows = this.db.connection.prepare(`${OBSERVATION_SELECT_SQL}
          WHERE current.object_id IN (${placeholders})`).all(...chunk) as ObservationRow[];
        for (const row of rows) result.set(row.object_id, parseObservationRow(row));
      }
      return result;
    } catch (error) {
      if (error instanceof StorageError) throw error;
      throw new StorageError("QUERY_FAILED", "Failed to load memory HQ observations.", error);
    }
  }

  private readEvidenceReceipt(
    workspaceId: string,
    evidenceId: string
  ): RelationAssertionEvidenceReceipt {
    const row = this.db.connection.prepare(`
      SELECT workspace_id, event_anchor
      FROM evidence_capsules
      WHERE object_id = ?
      LIMIT 1
    `).get(evidenceId) as {
      readonly workspace_id: string;
      readonly event_anchor: string | null;
    } | undefined;
    if (row === undefined) {
      throw new StorageError("NOT_FOUND", `Evidence ${evidenceId} is unavailable for HQ observation.`);
    }
    if (row.workspace_id !== workspaceId) {
      throw new StorageError("CONFLICT", `Evidence ${evidenceId} belongs to another HQ workspace.`);
    }
    if (row.event_anchor === null) {
      throw new StorageError("NOT_FOUND", `Evidence ${evidenceId} has no source observation anchor.`);
    }
    try {
      return RelationAssertionEvidenceReceiptSchema.parse({
        evidence_id: evidenceId,
        source_event_anchor: JSON.parse(row.event_anchor) as unknown
      });
    } catch (error) {
      throw new StorageError("VALIDATION_FAILED", `Evidence ${evidenceId} has an invalid EventLog anchor.`, error);
    }
  }

  private assertEvidenceReceipt(
    workspaceId: string,
    receipt: RelationAssertionEvidenceReceipt
  ): void {
    const expected = receipt.source_event_anchor;
    const row = this.db.connection.prepare(`
      SELECT evidence.workspace_id, evidence.event_anchor,
             source.event_id AS source_event_id
      FROM evidence_capsules AS evidence
      LEFT JOIN event_log AS source
        ON source.event_id = ?
       AND source.event_type = ?
       AND source.workspace_id = ?
      WHERE evidence.object_id = ?
    `).get(
      expected.event_id,
      expected.event_type,
      workspaceId,
      receipt.evidence_id
    ) as {
      readonly workspace_id: string;
      readonly event_anchor: string | null;
      readonly source_event_id: string | null;
    } | undefined;
    if (row === undefined || row.workspace_id !== workspaceId || row.event_anchor === null) {
      throw new StorageError("NOT_FOUND", `Evidence ${receipt.evidence_id} cannot ground this HQ observation.`);
    }
    if (row.source_event_id === null) {
      throw new StorageError("NOT_FOUND", `Evidence ${receipt.evidence_id} source EventLog entry is unavailable.`);
    }
    let anchor: unknown;
    try {
      anchor = JSON.parse(row.event_anchor);
    } catch {
      throw new StorageError("VALIDATION_FAILED", `Evidence ${receipt.evidence_id} has an invalid EventLog anchor.`);
    }
    const actual = anchor as Partial<typeof expected>;
    if (
      actual.event_type !== expected.event_type ||
      actual.event_id !== expected.event_id ||
      actual.occurred_at !== expected.occurred_at
    ) {
      throw new StorageError("CONFLICT", `Evidence ${receipt.evidence_id} EventLog anchor does not match the HQ receipt.`);
    }
  }

  private insertOrVerifyObservation(observation: Readonly<MemoryHqObservationRecord>): void {
    const existing = this.findObservationById(observation.observation_id);
    if (existing !== null) {
      if (observationDigest(existing) !== observationDigest(observation)) {
        throw new StorageError("CONFLICT", `HQ observation ${observation.observation_id} has conflicting content.`);
      }
      return;
    }
    this.db.connection.prepare(`
      INSERT INTO memory_hq_observations (
        observation_id, object_id, workspace_id, evidence_id, source_event_type,
        source_event_id, source_occurred_at, producer_id, hqs_json,
        hq_content_sha256, observation_sha256, recorded_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      observation.observation_id,
      observation.object_id,
      observation.workspace_id,
      observation.evidence_receipt.evidence_id,
      observation.evidence_receipt.source_event_anchor.event_type,
      observation.evidence_receipt.source_event_anchor.event_id,
      observation.evidence_receipt.source_event_anchor.occurred_at,
      observation.producer_id,
      JSON.stringify(observation.hqs),
      observation.hq_content_sha256,
      observation.observation_sha256,
      observation.recorded_at
    );
  }

  private findObservationById(observationId: string): Readonly<MemoryHqObservationRecord> | null {
    const row = this.db.connection.prepare(`${OBSERVATION_SELECT_SQL}
      WHERE observation.observation_id = ?`).get(observationId) as ObservationRow | undefined;
    return row === undefined ? null : parseObservationRow(row);
  }
}

function buildObservation(record: MemoryHqRecord): Readonly<MemoryHqObservationRecord> {
  const hqContentSha256 = sha256(JSON.stringify(record.hqs));
  const recordedAt = record.evidence_receipt.source_event_anchor.occurred_at;
  const observationSha256 = sha256(JSON.stringify(observationPayload(
    record,
    hqContentSha256,
    recordedAt
  )));
  return Object.freeze({
    ...record,
    observation_id: `hq_observation_${observationSha256}`,
    hq_content_sha256: hqContentSha256,
    observation_sha256: observationSha256,
    recorded_at: recordedAt
  });
}

function parseObservationRow(row: ObservationRow): Readonly<MemoryHqObservationRecord> {
  if (row.current_hqs_json !== row.observation_hqs_json) {
    throw new StorageError("CONFLICT", `Memory HQ projection for ${row.object_id} does not match its observation.`);
  }
  const observation: MemoryHqObservationRecord = {
    observation_id: row.observation_id,
    object_id: row.object_id,
    workspace_id: row.workspace_id,
    hqs: parseHqs(row.observation_hqs_json),
    evidence_receipt: {
      evidence_id: row.evidence_id,
      source_event_anchor: {
        event_type: row.source_event_type,
        event_id: row.source_event_id,
        occurred_at: row.source_occurred_at
      }
    },
    producer_id: row.producer_id,
    hq_content_sha256: row.hq_content_sha256,
    observation_sha256: row.observation_sha256,
    recorded_at: row.recorded_at,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
  assertObservationDigest(observation);
  return Object.freeze(observation);
}

function parseHqs(raw: string): readonly string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every((value) => typeof value === "string")) return parsed;
  } catch {
    // Invalid persisted observations fail closed below.
  }
  throw new StorageError("VALIDATION_FAILED", "Invalid memory HQ observation content.");
}

function observationPayload(
  observation: MemoryHqRecord,
  hqContentSha256: string,
  recordedAt: string
): Readonly<Record<string, unknown>> {
  return {
    object_id: observation.object_id,
    workspace_id: observation.workspace_id,
    hqs: observation.hqs,
    evidence_receipt: observation.evidence_receipt,
    producer_id: observation.producer_id,
    hq_content_sha256: hqContentSha256,
    recorded_at: recordedAt
  };
}

function assertObservationDigest(observation: MemoryHqObservationRecord): void {
  const hqContentSha256 = sha256(JSON.stringify(observation.hqs));
  const observationSha256 = sha256(JSON.stringify(observationPayload(
    observation,
    hqContentSha256,
    observation.recorded_at
  )));
  if (
    observation.hq_content_sha256 !== hqContentSha256 ||
    observation.observation_sha256 !== observationSha256 ||
    observation.observation_id !== `hq_observation_${observationSha256}`
  ) {
    throw new StorageError("CONFLICT", `HQ observation ${observation.observation_id} has an invalid digest.`);
  }
}

function observationDigest(observation: Readonly<MemoryHqObservationRecord>): string {
  return observation.observation_sha256;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

const OBSERVATION_SELECT_SQL = `
  SELECT observation.observation_id, observation.object_id, observation.workspace_id,
         observation.evidence_id, observation.source_event_type, observation.source_event_id,
         observation.source_occurred_at, observation.producer_id,
         observation.hqs_json AS observation_hqs_json,
         current.hqs_json AS current_hqs_json, observation.hq_content_sha256,
         observation.observation_sha256, observation.recorded_at,
         current.created_at, current.updated_at
  FROM memory_hq AS current
  JOIN memory_hq_observations AS observation
    ON observation.observation_id = current.observation_id
`;

const UPSERT_MEMORY_HQ_SQL = `
  INSERT INTO memory_hq (
    object_id, workspace_id, hqs_json, observation_id, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(object_id) DO UPDATE SET
    workspace_id = excluded.workspace_id,
    hqs_json = excluded.hqs_json,
    observation_id = excluded.observation_id,
    updated_at = excluded.updated_at
`;
