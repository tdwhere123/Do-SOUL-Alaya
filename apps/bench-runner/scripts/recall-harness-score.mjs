#!/usr/bin/env node
// Scores recall-harness rows against LongMemEval answer turns. A gold message is visible when its
// whitespace-normalized content lies inside one delivered interval; Any/All@k use the first k slots,
// Any/All@B the delivered stream cut at B bytes in slot order. Root@k only asks whether a delivered
// root contains the gold message.
//
//   node apps/bench-runner/scripts/recall-harness-score.mjs --out DIR [--base ARM]
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createRequire } from "node:module";

const here = dirname(fileURLToPath(import.meta.url));
const Database = createRequire(join(here, "../package.json"))("better-sqlite3");
const { values } = parseArgs({ options: { out: { type: "string" }, base: { type: "string" }, dataset: { type: "string" } } });
const out = resolve(values.out);
const datasetPath = resolve(values.dataset ?? join(here, "../data/longmemeval/longmemeval_s.json"));
const dataset = new Map(JSON.parse(readFileSync(datasetPath, "utf8")).map(q => [q.question_id, q]));
const rows = readFileSync(join(out, "rows.jsonl"), "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));
const BUDGETS = [2048, 4096, 8192];
const norm = text => text.replace(/\s+/gu, " ").trim();

function bodies(snapshot, workspace) {
  const db = new Database(snapshot, { readonly: true, fileMustExist: true });
  try {
    return new Map(db.prepare("SELECT record_id, source_body FROM source_records WHERE workspace_id=?").all(workspace)
      .map(row => [row.record_id, Buffer.from(row.source_body, "utf8")]));
  } finally { db.close(); }
}

function score(row) {
  const question = dataset.get(row.question_id);
  const gold = question.haystack_sessions.flat().filter(turn => turn.has_answer).map(turn => norm(turn.content)).filter(Boolean);
  if (row.status === "error" || row.status === "failed" || row.status === "unavailable") return { ...base(row), scored: false, gold: gold.length };
  const body = bodies(row.snapshot, row.workspace);
  const slots = row.intervals.filter(i => i.span !== null).map(i => {
    const bytes = body.get(i.target.root_id) ?? Buffer.alloc(0);
    const text = bytes.subarray(i.span.content_start, i.span.content_end);
    return { slot: i.slot_index, root: norm(bytes.toString("utf8")), bytes: text };
  });
  const visibleIn = (texts) => gold.map(g => texts.some(t => t.includes(g)));
  const at = (k, f) => f(slots.filter(s => s.slot < k));
  const byK = k => ({ msg: visibleIn(at(k, s => s.map(x => norm(x.bytes.toString("utf8"))))),
    root: visibleIn(at(k, s => s.map(x => x.root))) });
  const byB = B => {
    let left = B; const texts = [];
    for (const s of slots) { if (left <= 0) break; const cut = s.bytes.subarray(0, left); left -= cut.length; texts.push(norm(cut.toString("utf8"))); }
    return visibleIn(texts);
  };
  const flags = { at5: byK(5), at10: byK(10), ...Object.fromEntries(BUDGETS.map(B => [`b${B}`, byB(B)])) };
  const anyAll = v => ({ any: v.some(Boolean), all: v.length > 0 && v.every(Boolean) });
  return { ...base(row), scored: gold.length > 0, gold: gold.length,
    delivered_bytes: slots.reduce((n, s) => n + s.bytes.length, 0), slots: slots.length,
    msg5: anyAll(flags.at5.msg), msg10: anyAll(flags.at10.msg), root5: anyAll(flags.at5.root), root10: anyAll(flags.at10.root),
    ...Object.fromEntries(BUDGETS.map(B => [`b${B}`, anyAll(flags[`b${B}`])])) };
}
const base = row => ({ question_id: row.question_id, question_type: row.question_type, arm: row.arm, status: row.status });

const scored = rows.map(score);
writeFileSync(join(out, "scores.jsonl"), scored.map(s => JSON.stringify(s)).join("\n") + "\n");
const metrics = ["root5", "msg5", "msg10", ...BUDGETS.map(B => `b${B}`)];
const arms = [...new Set(scored.map(s => s.arm))];
const table = [];
for (const arm of arms) {
  const mine = scored.filter(s => s.arm === arm && s.scored);
  const line = { arm, scored: mine.length, failed: scored.filter(s => s.arm === arm && !s.scored && s.gold > 0).length,
    bytes: mine.reduce((n, s) => n + s.delivered_bytes, 0) };
  for (const m of metrics) line[m] = `${mine.filter(s => s[m].any).length}/${mine.filter(s => s[m].all).length}`;
  table.push(line);
}
console.log("Any/All counts per arm");
console.table(table);
if (values.base) {
  const ref = new Map(scored.filter(s => s.arm === values.base && s.scored).map(s => [s.question_id, s]));
  for (const arm of arms.filter(a => a !== values.base)) {
    const pairs = scored.filter(s => s.arm === arm && s.scored && ref.has(s.question_id));
    const diff = {};
    for (const m of metrics) {
      const wins = pairs.filter(s => s[m].any && !ref.get(s.question_id)[m].any).length;
      const losses = pairs.filter(s => !s[m].any && ref.get(s.question_id)[m].any).length;
      diff[m] = `+${wins}/-${losses}`;
    }
    console.log(`${arm} vs ${values.base} (Any wins/losses over ${pairs.length} pairs)`, diff);
  }
}
