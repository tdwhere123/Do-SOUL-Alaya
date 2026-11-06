import { AlayaError } from "@do-soul/alaya-protocol";

/** The census is fixed before scoring; an unobserved row is unknown, not a miss. */
export function recallHarnessCensus(rows, dataset, manifest) {
  if (manifest === undefined) return { status: "not_qualifiable", reason: "expected_census_missing" };
  const { question_ids: ids, arms, reader, capture_pool: capturePool } = manifest;
  for (const [name, values] of [["question_ids", ids], ["arms", arms]]) {
    if (!Array.isArray(values) || values.length === 0 || values.some(value => typeof value !== "string" || value.length === 0)
        || new Set(values).size !== values.length) throw new AlayaError("VALIDATION", `census ${name} must be a nonempty unique string array`);
  }
  if (!["current", "end_continuation"].includes(reader)) throw new AlayaError("VALIDATION", "census reader must be explicit");
  if (typeof capturePool !== "boolean") throw new AlayaError("VALIDATION", "census capture_pool must be explicit");
  const answerable = new Map(ids.map(id => {
    const question = dataset.get(id);
    if (!question || !Array.isArray(question.haystack_sessions)) throw new AlayaError("VALIDATION", `census question ${id} is absent or malformed`);
    return [id, question.haystack_sessions.flat().some(turn => turn.has_answer && typeof turn.content === "string" && turn.content.trim())];
  }));
  const wanted = new Set(ids.flatMap(id => arms.map(arm => JSON.stringify([id, arm]))));
  const seen = new Map(), unexpected = [], duplicates = [];
  for (const row of rows) {
    const key = JSON.stringify([row.question_id, row.arm]);
    if (!wanted.has(key)) { unexpected.push({ question_id: row.question_id, arm: row.arm }); continue; }
    if (seen.has(key)) duplicates.push({ question_id: row.question_id, arm: row.arm });
    else seen.set(key, row);
  }
  const missing = [], incomplete = [], by_arm = [];
  for (const arm of arms) {
    const counts = { arm, expected: ids.length, answerable: ids.filter(id => answerable.get(id)).length,
      complete: 0, unknown: 0, unknown_answerable: 0, unanswerable: ids.filter(id => !answerable.get(id)).length };
    for (const id of ids) {
      const row = seen.get(JSON.stringify([id, arm]));
      if (!row) { missing.push({ question_id: id, arm }); counts.unknown++; if (answerable.get(id)) counts.unknown_answerable++; continue; }
      const reasons = [];
      if (row.status !== "complete") reasons.push(`status_${row.status ?? "missing"}`);
      if ((row.reader ?? "current") !== reader) reasons.push("reader_mismatch");
      if (reader === "end_continuation") {
        if (!row.end_continuation || !Array.isArray(row.end_continuation.issues)) reasons.push("continuation_missing");
        else if (row.end_continuation.issues.length) reasons.push("continuation_issues");
      }
      if (capturePool && (row.capture_requested !== true || row.pool_capture?.status !== "captured"
        || !Array.isArray(row.pool_capture.issues) || row.pool_capture.issues.length)) reasons.push("pool_capture_incomplete");
      if (reasons.length) {
        incomplete.push({ question_id: id, arm, reasons }); counts.unknown++; if (answerable.get(id)) counts.unknown_answerable++;
      } else counts.complete++;
    }
    by_arm.push(counts);
  }
  return { status: missing.length || unexpected.length || duplicates.length || incomplete.length ? "not_qualifiable" : "qualifiable",
    reader, capture_pool: capturePool, expected_rows: wanted.size, observed_rows: rows.length, by_arm, missing, unexpected, duplicates, incomplete };
}
