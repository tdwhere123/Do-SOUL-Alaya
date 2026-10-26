#!/usr/bin/env node
// Evaluation-only delivery bounds over recall-harness rows. Gold is the recorded host message of each
// has_answer turn (occurrence `<qid>:s<i>:m<t>`); it is visible when one delivered interval covers it.
// Every policy keeps the observed root order (first delivery wins) and cuts a byte stream at B:
//   observed   delivered intervals as captured
//   prefix     each root from byte 0, raw cut
//   line       each root from byte 0, cut at the largest recorded line end that fits (draft B Thm 4.4)
//   message    same with recorded message ends
//   role-type  only messages of the role the question type names (assistant for single-session-assistant)
//   role-gold  only messages of the gold turns' roles (oracle)
//   day-gold   only roots whose session day holds a gold session (oracle reference domain, order kept)
// Gold labels and oracle roles/days are read after capture and never reach a query.
//
//   node apps/bench-runner/scripts/recall-harness-bounds.mjs --out DIR [--arm NAME] [--base POLICY]
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createRequire } from "node:module";

const here = dirname(fileURLToPath(import.meta.url));
const Database = createRequire(join(here, "../package.json"))("better-sqlite3");
const { values } = parseArgs({ options: { out: { type: "string" }, arm: { type: "string" },
  base: { type: "string" }, dataset: { type: "string" } } });
const out = resolve(values.out);
const dataset = new Map(JSON.parse(readFileSync(resolve(values.dataset ?? join(here, "../data/longmemeval/longmemeval_s.json")), "utf8"))
  .map(q => [q.question_id, q]));
const rows = readFileSync(join(out, "rows.jsonl"), "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line))
  .filter(row => values.arm === undefined || row.arm === values.arm);
const BUDGETS = [2048, 4096, 8192];
const POLICIES = ["observed", "prefix", "line", "message", "role-type", "role-gold", "day-gold"];
const day = stamp => stamp.slice(0, 10);

function roots(snapshot, workspace) {
  const db = new Database(snapshot, { readonly: true, fileMustExist: true });
  try {
    const lines = new Map();
    for (const s of db.prepare("SELECT record_id, end_offset FROM source_spans WHERE workspace_id=? AND purpose='line'").all(workspace)) {
      (lines.get(s.record_id) ?? lines.set(s.record_id, []).get(s.record_id)).push(s.end_offset);
    }
    const inventories = new Map(db.prepare("SELECT record_id, canonical_inventory FROM source_host_inventories WHERE workspace_id=?")
      .all(workspace).map(r => [r.record_id, JSON.parse(r.canonical_inventory).occurrences]));
    return new Map(db.prepare("SELECT record_id, source_body FROM source_records WHERE workspace_id=?").all(workspace).map(r => {
      const length = Buffer.byteLength(r.source_body, "utf8");
      const messages = (inventories.get(r.record_id) ?? []).filter(o => o.completeness === "complete" && o.utf8_span[1] > o.utf8_span[0]);
      return [r.record_id, { length, messages, lineEnds: [...(lines.get(r.record_id) ?? []), length].sort((a, b) => a - b),
        messageEnds: [...messages.map(o => o.utf8_span[1]), length].sort((a, b) => a - b),
        session: messages[0]?.container_ref?.id.split(":").at(-1) }];
    }));
  } finally { db.close(); }
}

/** Largest boundary in (0, limit]; without one the raw cut stands (Thm 4.4 fallback). */
const aligned = (ends, limit) => { let best = 0; for (const e of ends) if (e <= limit) best = e; return best > 0 ? best : limit; };

function stream(units, B) {
  let left = B; const shown = [];
  for (const unit of units) {
    if (left <= 0) break;
    for (const [start, end, ends] of unit.parts) {
      if (left <= 0) break;
      const cut = ends === null ? Math.min(end - start, left) : aligned(ends.filter(e => e > start).map(e => e - start), Math.min(end - start, left));
      shown.push([unit.root, start, start + cut]); left -= cut;
    }
  }
  return shown;
}

function score(row) {
  const question = dataset.get(row.question_id);
  const gold = [];
  question.haystack_sessions.forEach((session, s) => session.forEach((turn, t) => {
    if (turn.has_answer) gold.push({ id: `${row.question_id}:s${s}:m${t}`, role: turn.role, day: day(question.haystack_dates[s]) });
  }));
  const base = { question_id: row.question_id, question_type: row.question_type, arm: row.arm, gold: gold.length };
  if (["error", "failed", "unavailable"].includes(row.status) || gold.length === 0) return { ...base, scored: false };
  const body = roots(row.snapshot, row.workspace);
  const located = gold.map(g => {
    for (const [root, r] of body) {
      const o = r.messages.find(m => m.occurrence_id === g.id);
      if (o !== undefined) return { ...g, root, span: o.utf8_span, lineEnd: r.lineEnds.includes(o.utf8_span[1]) };
    }
    return { ...g, root: null };
  });
  const order = [];
  for (const i of row.intervals) if (i.span !== null && !order.includes(i.target.root_id)) order.push(i.target.root_id);
  const goldRoles = new Set(gold.map(g => g.role)), goldDays = new Set(gold.map(g => g.day));
  const typeRole = row.question_type === "single-session-assistant" ? "assistant" : "user";
  const sessionDay = r => r.session === undefined ? null : day(question.haystack_dates[Number(r.session.slice(1))]);
  const whole = (kind) => order.filter(id => body.has(id)).map(id => {
    const r = body.get(id);
    return { root: id, parts: [[0, r.length, kind === "prefix" ? null : kind === "line" ? r.lineEnds : r.messageEnds]] };
  });
  const roleOnly = role => order.filter(id => body.has(id)).map(id => ({ root: id,
    parts: body.get(id).messages.filter(m => role(m.role)).map(m => [m.utf8_span[0], m.utf8_span[1], [m.utf8_span[1]]]) }));
  const units = {
    prefix: whole("prefix"), line: whole("line"), message: whole("message"),
    "role-type": roleOnly(r => r === typeRole), "role-gold": roleOnly(r => goldRoles.has(r)),
    "day-gold": whole("message").filter(u => goldDays.has(sessionDay(body.get(u.root))))
  };
  const observed = B => {
    let left = B; const shown = [];
    for (const i of row.intervals) {
      if (i.span === null || left <= 0) continue;
      const cut = Math.min(i.span.content_end - i.span.content_start, left);
      shown.push([i.target.root_id, i.span.content_start, i.span.content_start + cut]); left -= cut;
    }
    return shown;
  };
  const visible = shown => located.map(g => g.root !== null && shown.some(([root, s, e]) => root === g.root && s <= g.span[0] && g.span[1] <= e));
  const result = { ...base, scored: true, located: located.filter(g => g.root !== null).length,
    line_premise: located.filter(g => g.root !== null && g.lineEnd).length,
    gold_root_delivered: located.some(g => g.root !== null && order.includes(g.root)),
    day_domain_roots: [...body.values()].filter(r => goldDays.has(sessionDay(r))).length, roots: body.size };
  for (const policy of POLICIES) for (const B of BUDGETS) {
    const v = visible(policy === "observed" ? observed(B) : stream(units[policy], B));
    result[`${policy}@${B}`] = { any: v.some(Boolean), all: v.length > 0 && v.every(Boolean) };
  }
  return result;
}

const scored = rows.map(score);
writeFileSync(join(out, `bounds${values.arm === undefined ? "" : `-${values.arm}`}.jsonl`), scored.map(s => JSON.stringify(s)).join("\n") + "\n");
const mine = scored.filter(s => s.scored);
const goldTotal = mine.reduce((n, s) => n + s.gold, 0), locatedTotal = mine.reduce((n, s) => n + s.located, 0);
console.log(`scored ${mine.length}/${scored.length}; gold messages located ${locatedTotal}/${goldTotal}; ` +
  `message-end premise ${locatedTotal}/${goldTotal}; line-end premise ${mine.reduce((n, s) => n + s.line_premise, 0)}/${goldTotal}; ` +
  `gold root delivered ${mine.filter(s => s.gold_root_delivered).length}`);
const med = xs => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
console.log(`gold-day domain roots: median ${med(mine.map(s => s.day_domain_roots))} of median ${med(mine.map(s => s.roots))}`);
console.table(POLICIES.map(policy => Object.fromEntries([["policy", policy],
  ...BUDGETS.map(B => [`${B}`, `${mine.filter(s => s[`${policy}@${B}`].any).length}/${mine.filter(s => s[`${policy}@${B}`].all).length}`])])));
const ref = values.base ?? "message";
for (const policy of POLICIES.filter(p => p !== ref)) {
  console.log(`${policy} vs ${ref} (Any wins/losses)`, Object.fromEntries(BUDGETS.map(B => [B,
    `+${mine.filter(s => s[`${policy}@${B}`].any && !s[`${ref}@${B}`].any).length}/-${mine.filter(s => !s[`${policy}@${B}`].any && s[`${ref}@${B}`].any).length}`])));
}
