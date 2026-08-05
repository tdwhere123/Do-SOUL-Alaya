import { createHash } from "node:crypto";
import type { StorageDatabase } from "@do-soul/alaya-storage";
import type {
  EvidenceFactFrameFormationSummary,
  EvidenceFactFrameFormationStatusCount,
  EvidenceFactFrameProducerCount
} from "./evidence-search-projection-rebuild-report.js";

export interface FormationBindingRow {
  readonly evidence_object_id: string;
  readonly status: string;
  readonly producer_operator_id: string | null;
  readonly source_hash: string | null;
  readonly capture_digest: string;
}

export function summarizeFactFrameFormations(
  db: StorageDatabase,
  evidenceObjectIds: readonly string[]
): EvidenceFactFrameFormationSummary {
  if (evidenceObjectIds.length === 0) return emptyFactFrameFormationSummary();
  const rows = db.connection.prepare(READ_FORMATION_BINDINGS_SQL).all(
    JSON.stringify(evidenceObjectIds)
  ) as FormationBindingRow[];
  return summarizeFactFrameFormationBindings(rows);
}

export function summarizeFactFrameFormationBindings(
  inputRows: readonly FormationBindingRow[]
): EvidenceFactFrameFormationSummary {
  const rows = inputRows.map((row): FormationBindingRow => ({
    evidence_object_id: row.evidence_object_id,
    status: row.status,
    producer_operator_id: row.producer_operator_id,
    source_hash: row.source_hash,
    capture_digest: row.capture_digest
  })).sort((left, right) =>
    left.evidence_object_id.localeCompare(right.evidence_object_id));
  const statuses = new Map<string, number>();
  const producers = new Map<string | null, number>();
  for (const row of rows) {
    statuses.set(row.status, (statuses.get(row.status) ?? 0) + 1);
    producers.set(
      row.producer_operator_id,
      (producers.get(row.producer_operator_id) ?? 0) + 1
    );
  }
  return Object.freeze({
    schema_version: 1,
    capture_count: rows.length,
    source_bound_count: rows.filter(({ source_hash: source }) => source !== null).length,
    status_counts: statusCounts(statuses),
    producer_operator_counts: producerCounts(producers),
    capture_binding_sha256: digest(rows)
  });
}

export function emptyFactFrameFormationSummary(): EvidenceFactFrameFormationSummary {
  return Object.freeze({
    schema_version: 1,
    capture_count: 0,
    source_bound_count: 0,
    status_counts: Object.freeze([]),
    producer_operator_counts: Object.freeze([]),
    capture_binding_sha256: digest([])
  });
}

function statusCounts(
  counts: ReadonlyMap<string, number>
): readonly EvidenceFactFrameFormationStatusCount[] {
  return Object.freeze([...counts].sort(([left], [right]) =>
    left.localeCompare(right)
  ).map(([status, captureCount]) => Object.freeze({
    status,
    capture_count: captureCount
  })));
}

function producerCounts(
  counts: ReadonlyMap<string | null, number>
): readonly EvidenceFactFrameProducerCount[] {
  return Object.freeze([...counts].sort(([left], [right]) =>
    (left ?? "").localeCompare(right ?? "")
  ).map(([producerOperatorId, captureCount]) => Object.freeze({
    producer_operator_id: producerOperatorId,
    capture_count: captureCount
  })));
}

function digest(rows: readonly FormationBindingRow[]): string {
  return createHash("sha256").update(JSON.stringify(rows), "utf8").digest("hex");
}

const READ_FORMATION_BINDINGS_SQL = `
  SELECT evidence_object_id, status, producer_operator_id, source_hash, capture_digest
  FROM evidence_fact_frame_formations
  WHERE evidence_object_id IN (SELECT value FROM json_each(?))
  ORDER BY evidence_object_id ASC
`;
