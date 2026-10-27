import { QuestionTimePreferenceSchema, SourceSemanticResourceExhausted, SourceSemanticResourceLedger,
  type QuestionTimePreference, type SourceIndexQuestionTimeDomain, type SourceSemanticResourceBudget } from "@do-soul/alaya-protocol";
import type { StorageDatabase } from "../../sqlite/db.js";
import { cachedReadStatement } from "../../sqlite/dynamic-prepared-statement-cache.js";
import { readRecord, readStringField } from "../shared/parse-row.js";

/** r is the captured index root. Event time comes only from its actual source owner. */
export function questionTimeSql(preference: QuestionTimePreference): { sql: string; parameters: string[] } {
  const parsed = QuestionTimePreferenceSchema.parse(preference);
  const stamp = `CASE r.root_kind WHEN 'source_record' THEN
    (SELECT s.event_time FROM source_records s WHERE s.workspace_id=r.workspace_id AND s.record_id=r.record_id)
    WHEN 'evidence_capsule' THEN (SELECT c.retained_source_event_time FROM evidence_capsules c
      WHERE c.workspace_id=r.workspace_id AND c.object_id=r.record_id) END`;
  return { sql: parsed.intervals.length === 0 ? "0" : `(${parsed.intervals.map(() =>
    `substr(${stamp},1,10) BETWEEN ? AND ?`).join(" OR ")})`,
    parameters: parsed.intervals.flatMap(interval => [interval.start, interval.end]) };
}

/** A bounded existence/membership read, not a corpus enumeration or authorization decision. */
export function readQuestionTimeDomain(database: StorageDatabase, workspaceId: string,
  preference: QuestionTimePreference, rootKeys: readonly string[], budget: SourceSemanticResourceBudget): SourceIndexQuestionTimeDomain {
  const meter = new SourceSemanticResourceLedger(budget);
  let nativeBytes = 0;
  try {
    const clause = questionTimeSql(preference);
    meter.retain(clause); meter.retain(rootKeys);
    // No match returns one scalar as well; reserve before SQL, then charge the actual rows.
    meter.charge(1, 8, "question time domain existence"); nativeBytes += 8;
    const exists = cachedReadStatement(database, `SELECT EXISTS(SELECT 1 FROM source_index_roots r
      WHERE r.workspace_id=? AND ${clause.sql}) AS present`).pluck().get(workspaceId, ...clause.parameters) === 1;
    const matched: string[] = [];
    for (const key of rootKeys) {
      meter.charge(1, Buffer.byteLength(key), "question time native membership"); nativeBytes += Buffer.byteLength(key);
      const row = cachedReadStatement(database, `SELECT r.root_key FROM source_index_roots r
        WHERE r.workspace_id=? AND r.root_key=? AND ${clause.sql}`).get(workspaceId, key, ...clause.parameters);
      if (row !== undefined) matched.push(readStringField(readRecord(row, "question time membership"), "root_key"));
    }
    return { status: "ready", exists, matched_root_keys: matched,
      resources: { work: meter.spentWork, memory_bytes: meter.spentBytes, native_bytes: nativeBytes, sql_internal_work: "unknown" } };
  } catch (error) {
    return { status: "unavailable", reason: error instanceof SourceSemanticResourceExhausted
      ? "question_time_read_budget" : "question_time_read_failed", resources: { work: meter.spentWork, memory_bytes: meter.spentBytes,
      native_bytes: nativeBytes, sql_internal_work: "unknown" } };
  }
}
