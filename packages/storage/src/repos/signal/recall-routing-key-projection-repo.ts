import type { StorageDatabase } from "../../sqlite/db.js";
import { StorageError } from "../../shared/errors.js";
import { parseJsonColumn } from "../shared/parse-json-column.js";

export interface StoredRecallRoutingKeyProjection {
  readonly owner_id: string;
  readonly owner_kind: string;
  readonly source_signal_id: string;
  readonly independence_group: string;
  readonly signal_kind: string;
  readonly object_type: string;
  readonly reliability: number;
  readonly proposed_entities: readonly string[];
  readonly proposed_preference: Readonly<{
    readonly subject: string | null;
    readonly predicate: string | null;
    readonly object: string | null;
    readonly category: string | null;
    readonly polarity: string | null;
  }>;
  readonly temporal: Readonly<{
    readonly start: string | null;
    readonly end: string | null;
    readonly precision: string | null;
  }>;
  readonly proposed_fact: string | null;
  readonly source_version: string;
}

interface ProjectionRow {
  readonly owner_id: string;
  readonly owner_kind: string;
  readonly signal_id: string;
  readonly signal_kind: string;
  readonly object_kind: string;
  readonly confidence: number;
  readonly raw_payload_json: string;
  readonly source_observation_json: string | null;
  readonly evidence_refs_json: string;
  readonly run_id: string;
  readonly created_at: string;
}

export class SqliteRecallRoutingKeyProjectionRepo {
  public constructor(private readonly database: StorageDatabase) {}

  public async findByOwnerIds(
    workspaceId: string,
    ownerIds: readonly string[]
  ): Promise<readonly Readonly<StoredRecallRoutingKeyProjection>[]> {
    const uniqueIds = [...new Set(ownerIds.filter(hasText))];
    if (!hasText(workspaceId) || uniqueIds.length === 0) return Object.freeze([]);
    try {
      const rows = this.database.connection.prepare(FIND_PROJECTIONS_SQL).all(
        workspaceId,
        JSON.stringify(uniqueIds)
      ) as ProjectionRow[];
      return Object.freeze(rows.map(projectRow));
    } catch (error) {
      if (error instanceof StorageError) throw error;
      throw new StorageError(
        "QUERY_FAILED",
        "Failed to rebuild recall routing key projections.",
        error
      );
    }
  }
}

function projectRow(row: ProjectionRow): Readonly<StoredRecallRoutingKeyProjection> {
  const payload = readRecord(row.raw_payload_json, "raw_payload_json");
  const grounding = readNestedRecord(payload, "source_grounding");
  const preference = readNestedRecord(grounding, "proposed_preference_profile");
  const temporal = readNestedRecord(payload, "temporal_projection");
  const observation = readRecord(row.source_observation_json, "source_observation_json");
  return Object.freeze({
    owner_id: row.owner_id,
    owner_kind: row.owner_kind,
    source_signal_id: row.signal_id,
    independence_group: resolveIndependenceGroup(row, payload, observation),
    signal_kind: row.signal_kind,
    object_type: row.object_kind,
    reliability: clampUnit(row.confidence),
    proposed_entities: readTextArray(grounding.proposed_canonical_entities),
    proposed_preference: Object.freeze({
      subject: readText(preference.preference_subject),
      predicate: readText(preference.preference_predicate),
      object: readText(preference.preference_object),
      category: readText(preference.preference_category),
      polarity: readText(preference.preference_polarity)
    }),
    temporal: Object.freeze({
      start: readText(temporal.event_time_start),
      end: readText(temporal.event_time_end),
      precision: readText(temporal.time_precision)
    }),
    proposed_fact: readText(grounding.proposed_distilled_fact),
    source_version: `signal:${row.signal_id}:${row.created_at}`
  });
}

function readRecord(value: string | null, fieldName: string): Readonly<Record<string, unknown>> {
  if (!hasText(value)) return Object.freeze({});
  const parsed = parseJsonColumn(value, fieldName);
  if (!isRecord(parsed)) {
    throw new StorageError("VALIDATION_FAILED", `Failed to validate ${fieldName} JSON.`);
  }
  return parsed;
}

function readNestedRecord(
  record: Readonly<Record<string, unknown>>,
  key: string
): Readonly<Record<string, unknown>> {
  const value = record[key];
  return isRecord(value) ? value : Object.freeze({});
}

function readText(value: unknown): string | null {
  return hasText(value) ? value.trim() : null;
}

function readTextArray(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return Object.freeze([]);
  return Object.freeze([...new Set(value.filter(hasText).map((item) => item.trim()))]);
}

function resolveIndependenceGroup(
  row: ProjectionRow,
  payload: Readonly<Record<string, unknown>>,
  observation: Readonly<Record<string, unknown>>
): string {
  const sourceEventId = readText(observation.source_event_id);
  if (sourceEventId !== null) return `source-event:${sourceEventId}`;
  const evidenceRef = readTextArray(parseJsonColumn(row.evidence_refs_json, "evidence_refs_json"))[0];
  if (evidenceRef !== undefined) return `evidence:${evidenceRef}`;
  const locator = payload.source_locator;
  if (isRecord(locator)) {
    return `source-locator:${row.run_id}:${stableJson(locator)}`;
  }
  return `signal:${row.signal_id}`;
}

function stableJson(value: Readonly<Record<string, unknown>>): string {
  return JSON.stringify(Object.fromEntries(
    Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
  ));
}

function clampUnit(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

const FIND_PROJECTIONS_SQL = `
  SELECT owner.owner_id, owner.owner_kind, signal.signal_id,
         signal.signal_kind, signal.object_kind, signal.confidence,
         signal.raw_payload_json, signal.source_observation_json,
         signal.evidence_refs_json, signal.run_id, signal.created_at
  FROM recall_routing_key_owners AS owner
  JOIN signals AS signal ON signal.signal_id = owner.signal_id
  WHERE owner.workspace_id = ?
    AND owner.owner_id IN (SELECT value FROM json_each(?))
    AND signal.workspace_id = owner.workspace_id
    AND signal.signal_state = 'materialized'
  ORDER BY owner.owner_id ASC, owner.owner_kind ASC, signal.signal_id ASC
`;
