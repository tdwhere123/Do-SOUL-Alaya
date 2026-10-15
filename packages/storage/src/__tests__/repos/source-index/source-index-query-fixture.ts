import { expect } from "vitest";
import {
  sourceIndexTarget,
  type SourceIndexQueryResources,
  type SourceIndexTarget
} from "@do-soul/alaya-protocol";
import type { FieldSourceRecordRow } from "../../../repos/field/ports.js";
import { buildFtsMatchExpression } from "../../../repos/shared/fts-lane-routing.js";
import type { StorageDatabase } from "../../../sqlite/db.js";
import {
  BUDGET, WORKSPACE, fixture, publishSource, type Fixture
} from "./source-index-fixture.js";

export { BUDGET, WORKSPACE, fixture, publishSource, type Fixture };
export const QUERY_BUDGET = { work_units: 100_000, memory_bytes: 16 * 1024 * 1024 } as const;
export const LEXICAL_LIMITATIONS = Object.freeze([
  "database_wide_bm25_statistics",
  "short_or_unadmitted_tokens_are_not_absence",
  "lexical_corpus_coverage_untracked"
]);

export function targetFor(row: FieldSourceRecordRow): SourceIndexTarget {
  if (row.source_body === null) throw new Error("expected retained native source body");
  return sourceIndexTarget({
    kind: "source_evidence", workspace_id: row.workspace_id, root_kind: "source_record",
    root_id: row.record_id, source_version: row.source_version, content_digest: row.content_digest,
    evidence_object_id: row.evidence_object_id
  }, row.source_id, Buffer.byteLength(row.source_body, "utf8"));
}

export function publishIndexed(
  environment: Fixture, body: string, sourceId: string, changes: Partial<FieldSourceRecordRow> = {}
) {
  const record = publishSource(environment, body, sourceId, changes);
  const source = targetFor(record);
  const write = environment.index.writeLexical(source, body, BUDGET);
  if (write.status !== "accepted") throw new Error(`expected lexical publication: ${write.reason}`);
  return { record, source };
}

export function expectQueryResources(
  resources: SourceIndexQueryResources, budget: { work_units: number; memory_bytes: number } = QUERY_BUDGET
) {
  expect(resources.sql_internal_work).toBe("unknown");
  expect(resources.work).toBeGreaterThanOrEqual(0);
  expect(resources.native_bytes).toBeGreaterThanOrEqual(0);
  expect(resources.memory_bytes).toBeGreaterThanOrEqual(0);
  expect(resources.work).toBeLessThanOrEqual(budget.work_units);
  expect(resources.memory_bytes).toBeLessThanOrEqual(budget.memory_bytes);
}

export function laneMatch(tokens: readonly string[]): string {
  return buildFtsMatchExpression(tokens);
}

export function rankedLane(
  database: StorageDatabase, table: "source_index_fts" | "source_index_fts_trigram",
  workspaceId: string, match: string
): ReadonlyArray<{ root_key: string; score: number }> {
  return database.connection.prepare(`SELECT x.root_key, bm25(${table}) AS score FROM ${table}
    JOIN source_index_text x ON x.id=${table}.rowid AND x.workspace_id=?
    JOIN source_index_roots r ON r.workspace_id=x.workspace_id AND r.root_key=x.root_key
    WHERE ${table} MATCH ? AND x.content_digest=json_extract(r.target_json,'$.target.content_digest')
      AND x.body_bytes=json_extract(r.target_json,'$.body_bytes')
    ORDER BY score ASC, x.root_key ASC`).all(workspaceId, match) as { root_key: string; score: number }[];
}

export function rankedUnicode61Unscoped(
  database: StorageDatabase, match: string
): ReadonlyArray<{ workspace_id: string; root_key: string; score: number }> {
  return database.connection.prepare(`SELECT x.workspace_id, x.root_key, bm25(source_index_fts) AS score
    FROM source_index_fts JOIN source_index_text x ON x.id=source_index_fts.rowid
    JOIN source_index_roots r ON r.workspace_id=x.workspace_id AND r.root_key=x.root_key
    WHERE source_index_fts MATCH ? AND x.content_digest=json_extract(r.target_json,'$.target.content_digest')
      AND x.body_bytes=json_extract(r.target_json,'$.body_bytes')
    ORDER BY score ASC, x.root_key ASC`).all(match) as { workspace_id: string; root_key: string; score: number }[];
}

export function vectorWindowIds(
  database: StorageDatabase, workspaceId: string, generationId: string, afterWindowId = ""
): readonly string[] {
  return database.connection.prepare(`SELECT v.window_id FROM source_index_vectors v
    JOIN source_index_windows w ON w.workspace_id=v.workspace_id AND w.generation_id=v.generation_id
      AND w.root_key=v.root_key AND w.window_id=v.window_id
    JOIN source_index_targets t ON t.workspace_id=v.workspace_id AND t.generation_id=v.generation_id AND t.root_key=v.root_key
    JOIN source_index_roots r ON r.workspace_id=v.workspace_id AND r.root_key=v.root_key
    WHERE v.workspace_id=? AND v.generation_id=? AND v.window_id>?
    ORDER BY v.window_id ASC`).all(workspaceId, generationId, afterWindowId).map(row =>
    (row as { window_id: string }).window_id);
}
