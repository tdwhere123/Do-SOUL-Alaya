#!/usr/bin/env node
// Scores recall-harness rows against LongMemEval answer turns. A gold message is visible when its
// whitespace-normalized content lies inside one delivered interval; Any/All@k use the first k slots,
// Any/All@B the delivered stream cut at B bytes in slot order. Root@k only asks whether a delivered
// root contains the gold message. Only the ranked ten-slot prefix is scored: paging stops at the first
// page boundary past ten slots, so later slots depend on page sizes, not on ranking.
// Additive source-bound diagnostics evaluate contiguous UTF-8 byte coverage without gaps, preserving
// all published text-substring scores unchanged.
// Rows read with the end-continuation reader are also scored as "<arm>+end-continuation": the
// delivered slots, then each continued slot re-read from the last message end at or before its cut.
//
//   node apps/bench-runner/scripts/recall-harness-score.mjs --out DIR --census FILE [--base ARM] [--dataset PATH]
// Census JSON: { "question_ids": [...], "arms": [...], "reader": "end_continuation" | "current", "capture_pool": true | false }.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { AlayaError, HostOccurrenceInventorySchema } from "@do-soul/alaya-protocol";
import { joinSnapshotAnswerSpans } from "../dist/runs/longmemeval-semantic/answer-spans.js";
import { endContinuationReading } from "../dist/runs/recall-measurement/ordinary/ordinary-end-continuation.js";
import { ORDINARY_RECALL_OBSERVED_SLOT_TARGET } from "../dist/runs/recall-measurement/ordinary/ordinary-entry-contract.js";
import { recallHarnessCensus } from "./recall-harness-census.mjs";
import { readRecallJsonlFile } from "./recall-jsonl-file.mjs";
import {
  scoreContiguousReadVisibility,
  unavailableRecallRowDiagnostics
} from "../dist/runs/longmemeval-semantic/recall-visibility-diagnostics.js";

const here = dirname(fileURLToPath(import.meta.url));
const Database = createRequire(join(here, "../package.json"))("better-sqlite3");
export const BUDGETS = [2048, 4096, 8192];
export const norm = text => text.replace(/\s+/gu, " ").trim();

export function loadSnapshotSources(snapshot, workspace) {
  const db = new Database(snapshot, { readonly: true, fileMustExist: true });
  try {
    const rows = db.prepare(
      "SELECT record_id, source_id, source_version, content_digest, source_body FROM source_records WHERE workspace_id=?"
    ).all(workspace);
    const bodyMap = new Map(rows.map(row => [row.record_id, Buffer.from(row.source_body, "utf8")]));
    return { bodyMap, sourceRows: rows };
  } finally {
    db.close();
  }
}

/** Host message ends per root; a root without a host inventory re-reads from its start. */
function loadMessageEnds(snapshot, workspace) {
  const db = new Database(snapshot, { readonly: true, fileMustExist: true });
  try {
    const rows = db.prepare("SELECT record_id, canonical_inventory FROM source_host_inventories WHERE workspace_id=?").all(workspace);
    return new Map(rows.map(row => [row.record_id,
      HostOccurrenceInventorySchema.parse(JSON.parse(row.canonical_inventory)).occurrences.map(o => o.utf8_span[1])]));
  } finally {
    db.close();
  }
}

/** Derives the end-continuation reading of each row that carries one, with its read records. */
function endContinuationRows(rows) {
  const read = [];
  const stat = { rows: 0, cut: 0, completed: 0, payload_calls: 0, issues: 0, initial_bytes: 0, continuation_bytes: 0 };
  for (const row of rows) {
    if ((row.status !== "complete" && row.status !== "partial") || row.end_continuation === undefined || !Array.isArray(row.intervals)) continue;
    const ends = loadMessageEnds(row.snapshot, row.workspace);
    const reading = endContinuationReading(row.intervals, row.end_continuation, root => ends.get(root) ?? []);
    stat.rows += 1; stat.cut += reading.cut; stat.completed += reading.completed;
    stat.payload_calls += row.end_continuation.payload_calls; stat.issues += row.end_continuation.issues.length;
    stat.initial_bytes += reading.initial_bytes; stat.continuation_bytes += reading.continuation_bytes;
    const { end_continuation: _record, ...rest } = row;
    read.push({ ...rest, arm: `${row.arm}+end-continuation`, intervals: reading.intervals });
  }
  return { read, stat };
}

export function scoreRecallHarnessRow(row, dataset) {
  const question = dataset.get(row.question_id);
  if (!question) {
    throw new AlayaError("VALIDATION", `Question ${row.question_id} not found in dataset`);
  }
  const gold = question.haystack_sessions.flat().filter(turn => turn.has_answer).map(turn => norm(turn.content)).filter(Boolean);
  const baseData = { question_id: row.question_id, question_type: row.question_type, arm: row.arm, status: row.status };

  if (row.status !== "complete" && row.status !== "partial") {
    const unavail = unavailableRecallRowDiagnostics(`row_status_${row.status}`, gold.length);
    return {
      ...baseData,
      scored: false,
      gold: gold.length,
      ...unavail
    };
  }

  if (!Array.isArray(row.intervals)) {
    throw new AlayaError("VALIDATION", `Row ${row.question_id} (${row.arm}) status "${row.status}" requires intervals array`);
  }

  const { bodyMap, sourceRows } = loadSnapshotSources(row.snapshot, row.workspace);
  const slots = row.intervals.filter(i => i.span !== null && i.slot_index < ORDINARY_RECALL_OBSERVED_SLOT_TARGET).map(i => {
    const bytes = bodyMap.get(i.target.root_id) ?? Buffer.alloc(0);
    const text = bytes.subarray(i.span.content_start, i.span.content_end);
    return {
      slot: i.slot_index,
      root: norm(bytes.toString("utf8")),
      bytes: text,
      target: i.target,
      span: i.span
    };
  });

  const visibleIn = (texts) => gold.map(g => texts.some(t => t.includes(g)));
  const at = (k, f) => f(slots.filter(s => s.slot < k));
  const byK = k => ({
    msg: visibleIn(at(k, s => s.map(x => norm(x.bytes.toString("utf8"))))),
    root: visibleIn(at(k, s => s.map(x => x.root)))
  });
  const byB = B => {
    let left = B;
    const texts = [];
    for (const s of slots) {
      if (left <= 0) break;
      const cut = s.bytes.subarray(0, left);
      left -= cut.length;
      texts.push(norm(cut.toString("utf8")));
    }
    return visibleIn(texts);
  };
  const flags = { at5: byK(5), at10: byK(10), ...Object.fromEntries(BUDGETS.map(B => [`b${B}`, byB(B)])) };
  const anyAll = v => ({ any: v.some(Boolean), all: v.length > 0 && v.every(Boolean) });

  let diagnostics;
  if (gold.length === 0) {
    diagnostics = unavailableRecallRowDiagnostics("no_annotated_answer_turn", 0);
  } else {
    const answerGold = joinSnapshotAnswerSpans(question, row.workspace, sourceRows);
    const deliveredIntervals = slots.map(s => ({
      slot: s.slot,
      target: {
        workspace_id: s.target.workspace_id,
        root_kind: s.target.root_kind,
        root_id: s.target.root_id,
        source_version: s.target.source_version,
        content_digest: s.target.content_digest
      },
      span: {
        content_start: s.span.content_start,
        content_end: s.span.content_end
      }
    }));
    const at10Chunks = at(10, s => s.map(x => norm(x.bytes.toString("utf8"))));
    const textChunkMatches = answerGold.spans.map(span => {
      const turnContent = question.haystack_sessions[span.session_index]?.[span.message_index]?.content;
      const turnText = turnContent ? norm(turnContent) : null;
      const bodyBytes = bodyMap.get(span.target.root_id);
      const spanText = bodyBytes ? norm(bodyBytes.subarray(span.start, span.end).toString("utf8")) : null;
      const matchText = turnText || spanText;
      return matchText ? at10Chunks.some(t => t.includes(matchText)) : false;
    });
    diagnostics = scoreContiguousReadVisibility({
      gold: answerGold,
      slots: deliveredIntervals,
      textChunkMatches
    });
  }

  return {
    ...baseData,
    scored: gold.length > 0,
    gold: gold.length,
    delivered_bytes: slots.reduce((n, s) => n + s.bytes.length, 0),
    slots: slots.length,
    msg5: anyAll(flags.at5.msg),
    msg10: anyAll(flags.at10.msg),
    root5: anyAll(flags.at5.root),
    root10: anyAll(flags.at10.root),
    ...Object.fromEntries(BUDGETS.map(B => [`b${B}`, anyAll(flags[`b${B}`])])),
    read_gold: diagnostics.read_gold,
    read5: diagnostics.read5,
    read10: diagnostics.read10,
    ...Object.fromEntries(BUDGETS.map(B => [`read_b${B}`, diagnostics[`read_b${B}`]])),
    source_diagnostics: diagnostics.source_diagnostics
  };
}

export function runRecallHarnessScore({ outDir, baseArm, datasetPath, censusPath }) {
  const out = resolve(outDir), censusPathname = join(out, "census.json");
  // Invalidate the current projection before any fallible input read/parse/validation.
  // Frozen evidence is never a scoring destination; callers use fresh output directories.
  writeFileSync(censusPathname, JSON.stringify({ status: "not_qualifiable", reason: "scoring_incomplete" }, null, 2) + "\n");
  const inputs = {};
  const readInput = (name, path) => {
    const bytes = readFileSync(path);
    inputs[name] = { path: resolve(path), sha256: createHash("sha256").update(bytes).digest("hex") };
    return bytes.toString("utf8");
  };
  const resolvedDatasetPath = resolve(datasetPath ?? join(here, "../data/longmemeval/longmemeval_s.json"));
  const dataset = new Map(JSON.parse(readInput("dataset", resolvedDatasetPath)).map(q => [q.question_id, q]));
  const rowsPath = join(out, "rows.jsonl");
  const { rows: captured, sha256 } = readRecallJsonlFile(rowsPath);
  inputs.rows = { path: rowsPath, sha256 };
  const manifest = censusPath === undefined ? undefined : JSON.parse(readInput("census", resolve(censusPath)));
  const census = { ...recallHarnessCensus(captured, dataset, manifest), inputs };
  const continued = endContinuationRows(captured);
  const rows = [...captured, ...continued.read];

  const scored = rows.map(r => scoreRecallHarnessRow(r, dataset));
  writeFileSync(join(out, "scores.jsonl"), scored.map(s => JSON.stringify(s)).join("\n") + "\n");

  const metrics = ["root5", "msg5", "msg10", ...BUDGETS.map(B => `b${B}`)];
  const arms = [...new Set(scored.map(s => s.arm))];
  const table = [];
  for (const arm of arms) {
    const mine = scored.filter(s => s.arm === arm && s.scored);
    const line = {
      arm,
      total: scored.filter(s => s.arm === arm).length,
      scored: mine.length,
      partial: scored.filter(s => s.arm === arm && s.status === "partial").length,
      failed: scored.filter(s => s.arm === arm && !s.scored && s.gold > 0).length,
      bytes: mine.reduce((n, s) => n + s.delivered_bytes, 0)
    };
    for (const m of metrics) line[m] = `${mine.filter(s => s[m]?.any).length}/${mine.filter(s => s[m]?.all).length}`;
    table.push(line);
  }
  console.log("Conditional scored-subset Any/All counts per arm (diagnostic, not the fixed denominator)");
  console.table(table);

  const diagMetrics = ["read5", "read10", ...BUDGETS.map(B => `read_b${B}`)];
  const diagTable = [];
  for (const arm of arms) {
    const mine = scored.filter(s => s.arm === arm && s.scored);
    const line = { arm, scored: mine.length };
    for (const m of diagMetrics) line[m] = `${mine.filter(s => s[m]?.any).length}/${mine.filter(s => s[m]?.all).length}`;
    diagTable.push(line);
  }
  console.log("Contiguous read Any/All counts per arm (diagnostic)");
  console.table(diagTable);

  if (continued.stat.rows > 0) {
    const n = continued.stat.rows;
    console.log("End-continuation reading records", { ...continued.stat, per_question: {
      payload_calls: (continued.stat.payload_calls / n).toFixed(1),
      initial_kb: (continued.stat.initial_bytes / n / 1024).toFixed(2),
      continuation_kb: (continued.stat.continuation_bytes / n / 1024).toFixed(2) } });
  }

  const incompleteGaps = scored.filter(s => s.scored && !s.read_gold?.complete);
  if (incompleteGaps.length > 0) {
    console.log(`Source gold mapping gaps: ${incompleteGaps.length} scored row(s) had incomplete gold mapping`);
  }

  if (baseArm) {
    const ref = new Map(scored.filter(s => s.arm === baseArm && s.scored).map(s => [s.question_id, s]));
    for (const arm of arms.filter(a => a !== baseArm)) {
      const pairs = scored.filter(s => s.arm === arm && s.scored && ref.has(s.question_id));
      const diff = {};
      for (const m of metrics) {
        const wins = pairs.filter(s => s[m]?.any && !ref.get(s.question_id)[m]?.any).length;
        const losses = pairs.filter(s => !s[m]?.any && ref.get(s.question_id)[m]?.any).length;
        diff[m] = `+${wins}/-${losses}`;
      }
      console.log(`${arm} vs ${baseArm} (diagnostic Any wins/losses over ${pairs.length} available pairs)`, diff);
    }
  }

  writeFileSync(censusPathname, JSON.stringify(census, null, 2) + "\n");
  console.log(`Fixed cohort: ${census.status}; see census.json`);
  return { scored, table, diagTable, endContinuation: continued.stat, census };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const { values } = parseArgs({ options: { out: { type: "string" }, base: { type: "string" }, dataset: { type: "string" },
    census: { type: "string" } } });
  if (!values.out) {
    console.error("Usage: recall-harness-score.mjs --out DIR --census FILE [--base ARM] [--dataset PATH]");
    process.exit(1);
  }
  const result = runRecallHarnessScore({ outDir: values.out, baseArm: values.base, datasetPath: values.dataset, censusPath: values.census });
  if (result.census.status !== "qualifiable") process.exitCode = 1;
}
