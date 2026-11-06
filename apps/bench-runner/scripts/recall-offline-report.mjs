#!/usr/bin/env node
/**
 * Offline saved-row comparison; no recall, provider, snapshot writes, or qualification.
 * Usage: node apps/bench-runner/scripts/recall-offline-report.mjs --input INPUT.json > REPORT.json
 * Paths are relative to INPUT.json. JSONL files may be split across shards.
 * INPUT = {label, questions:[{question_id,cohort:"dev2"|"o100"|"heldout",gold}],
 *   base:Side, current:Side}. gold is the declared annotated-answer count (including 0).
 * Side = {label,arm,score_arm,rows:[paths],scores:[paths],
 *   score_contract:{owner:"recall-harness-score.mjs",revision,reader:"end_continuation",ranked_slots:10},
 *   all_observed_scores?:[paths]}.
 * Use the scorer's +end-continuation score_arm with original full-pool capture rows.
 * The score_contract is an explicit caller assertion, NOT a runtime receipt. Legacy scores
 * without a proven ten-slot reading must be rescored by the scorer owner, not relabelled.
 * Optional all_observed_scores use the same score_arm; absent means unavailable, never zero.
 * Output: diagnostic_only, input SHA256 identities, every declared ID, census anomalies,
 * parity changed/unknown IDs, fixed-denominator B0 floors, paired metrics/sign tests,
 * residual cross-tabs and per-ID source-slot-5 traces. Unknown/partial rows stay in denominators.
 * Missing files/invalid JSON/invalid declarations fail; row anomalies are retained in the report.
 * Gold0 remains in the declared census but is not applicable to answerable metrics.
 * Formation observations are reported, never used to reject raw-fallback recall.
 * Output parity excludes input/runtime provenance and continuation latency; these differences
 * remain explicit metadata. Missing snapshot binding remains unknown, not equal by hashing.
 * initial_ten_slot_bytes is NOT full C-end byte-cost attribution.
 * Counts are saved-artifact observations, never D23 acceptance or current-main/B0 qualification.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual, parseArgs } from "node:util";
import { BUDGETS } from "./recall-harness-score.mjs";
import { readRecallJsonlFile } from "./recall-jsonl-file.mjs";
import { clipDeliveredSlotsByBudget } from "../dist/runs/longmemeval-semantic/recall-visibility-diagnostics.js";

const metrics = ["msg5", "msg10", ...BUDGETS.map(b => `b${b}`)];
const fail = message => { throw new TypeError(message); };
const unique = values => [...new Set(values)];
const root = item => item?.target?.root_id;

function indexRows(rows, arm, ids) {
  const groups = new Map();
  const unexpected = [], other_arms = [];
  for (const row of rows) {
    if (row.arm !== arm) { other_arms.push({ question_id: row.question_id, arm: row.arm }); continue; }
    if (!ids.has(row.question_id)) unexpected.push(row.question_id ?? null);
    const group = groups.get(row.question_id) ?? [];
    group.push(row); groups.set(row.question_id, group);
  }
  return { get: id => groups.get(id)?.length === 1 ? groups.get(id)[0] : null,
    count: id => groups.get(id)?.length ?? 0,
    anomalies: { missing: [...ids].filter(id => !groups.has(id)),
      duplicate: [...groups].filter(([, rs]) => rs.length > 1).map(([id]) => id),
      unexpected: unique(unexpected), other_arms } };
}

function sideIndex(side, ids) {
  const contract = side.score_contract;
  const guard = contract?.owner === "recall-harness-score.mjs" && typeof contract.revision === "string"
    && contract.revision.length > 0 && contract.reader === "end_continuation" && contract.ranked_slots === 10
    && side.score_arm === `${side.arm}+end-continuation`;
  return { ...side, guard, rowsIndex: indexRows(side.rows, side.arm, ids),
    scoresIndex: indexRows(side.scores, side.score_arm, ids),
    allIndex: indexRows(side.all_observed_scores ?? [], side.score_arm, ids) };
}

function observation(side, q) {
  const row = side.rowsIndex.get(q.question_id), score = side.scoresIndex.get(q.question_id);
  const issues = [];
  if (!row) issues.push(side.rowsIndex.count(q.question_id) > 1 ? "duplicate_row" : "missing_row");
  if (!score) issues.push(side.scoresIndex.count(q.question_id) > 1 ? "duplicate_score" : "missing_score");
  if (!side.guard) issues.push("score_guard_mismatch");
  if (row && row.status !== "complete") issues.push(`row_status_${row.status ?? "unknown"}`);
  if (row && (row.reader !== "end_continuation" || row.end_continuation === undefined)) issues.push("row_reader_mismatch");
  if (score && score.status !== "complete") issues.push(`score_status_${score.status ?? "unknown"}`);
  if (score && score.gold !== q.gold) issues.push("gold_census_mismatch");
  if (q.gold > 0 && score && score.scored !== true) issues.push("unscored");
  return { row, score, issues, applicable: q.gold > 0, known: issues.length === 0 };
}

function flag(obs, metric, kind) {
  return obs.applicable && obs.known && typeof obs.score?.[metric]?.[kind] === "boolean" ? obs.score[metric][kind] : null;
}

// Two-sided exact binomial sign test; recurrence avoids overflowing binomial coefficients.
export function exactSignTest(wins, losses) {
  const n = wins + losses;
  if (!n) return 1;
  let term = 2 ** -n, sum = term;
  for (let i = 1; i <= Math.min(wins, losses); i++) { term *= (n - i + 1) / i; sum += term; }
  return Math.min(1, 2 * sum);
}

function paired(entries, metric, kind) {
  const wins = [], losses = [], unknown = [], notApplicable = [];
  let base = 0, current = 0, known = 0;
  for (const e of entries) {
    if (e.gold === 0) { notApplicable.push(e.question_id); continue; }
    const a = flag(e.base, metric, kind), b = flag(e.current, metric, kind);
    if (a === null || b === null) { unknown.push(e.question_id); continue; }
    known++; base += Number(a); current += Number(b);
    if (!a && b) wins.push(e.question_id);
    if (a && !b) losses.push(e.question_id);
  }
  return { declared: entries.length, answerable_known: known, unknown_answerable: unknown.length,
    unknown_answerable_ids: unknown, not_applicable: notApplicable.length, not_applicable_ids: notApplicable, base, current,
    wins, losses, exact_sign_p: exactSignTest(wins.length, losses.length),
    aggregate_not_below_base: unknown.length ? null : current >= base };
}

function summarize(entries, side) {
  const statuses = {}, issues = {};
  for (const e of entries) {
    const o = e[side], status = o.row?.status ?? "missing_or_duplicate";
    statuses[status] = (statuses[status] ?? 0) + 1;
    for (const issue of o.issues) issues[issue] = (issues[issue] ?? 0) + 1;
  }
  return { declared: entries.length, answerable: entries.filter(e => e.gold > 0).length,
    gold0: entries.filter(e => e.gold === 0).length, statuses, issues,
    metrics: Object.fromEntries(metrics.map(m => [m, Object.fromEntries(["any", "all"].map(k => {
      const values = entries.filter(e => e.gold > 0).map(e => flag(e[side], m, k));
      return [k, { success: values.filter(v => v === true).length, miss: values.filter(v => v === false).length,
        unknown_answerable: values.filter(v => v === null).length,
        not_applicable: entries.length - values.length, declared: entries.length, answerable: values.length }];
    }))])) };
}

function floor(entries, cohort) {
  const answerable = entries.filter(e => e.gold > 0).length;
  const expected = { dev2: [288, 277, 263, 205], o100: [100, 95, 90, 70],
    heldout: [100, answerable, Math.ceil(90 / 95 * answerable), Math.ceil(70 / 95 * answerable)] }[cohort];
  const summary = summarize(entries, "current");
  const census_matches = entries.length === expected[0] && answerable === expected[1];
  return { ...summary, expected_declared: expected[0], expected_answerable: expected[1], census_matches,
    floor: Object.fromEntries(["any", "all"].map((k, i) => {
      const m = summary.metrics.msg5[k], answerableUnknown = entries.filter(e => e.gold > 0 && flag(e.current, "msg5", k) === null).length;
      return [k, { target: expected[i + 2], success: m.success, answerable_unknown: answerableUnknown,
        met: !census_matches || answerableUnknown ? null : m.success >= expected[i + 2] }];
    })) };
}

function parityMetadata(a, b) {
  const fields = ["input_identity", "implementation_revision", "arm_identity", "snapshot_identity"];
  const provenance = Object.fromEntries(fields.map(k => [k, { base: a?.[k] ?? null, current: b?.[k] ?? null }]));
  const timing = Object.fromEntries(["base", "current"].map((side, i) => [side, {
    elapsed_ms: (i ? b : a)?.elapsed_ms ?? null,
    continuation_latency_ms: (i ? b : a)?.end_continuation?.latency_ms ?? null
  }]));
  return { provenance, provenance_changed_fields: fields.filter(k => !isDeepStrictEqual(a?.[k], b?.[k])),
    timing, timing_changed: !isDeepStrictEqual(timing.base, timing.current) };
}

function continuationOutput(record) {
  if (record === undefined || record === null) return record;
  const { latency_ms: _latency, ...output } = record;
  return output;
}

function parity(e) {
  const a = e.base.row, b = e.current.row;
  if (!a || !b) return { status: "unknown", changed: [], unavailable: ["row"] };
  const fields = ["status", "stop_cause", "snapshot_sha256", "intervals", "end_continuation"];
  const changed = [], unavailable = [];
  if (a.status !== "complete" || b.status !== "complete") unavailable.push("row_output_incomplete");
  for (const key of fields) {
    if (a[key] === undefined || a[key] === null || b[key] === undefined || b[key] === null) unavailable.push(key);
    else if (!isDeepStrictEqual(key === "end_continuation" ? continuationOutput(a[key]) : a[key],
      key === "end_continuation" ? continuationOutput(b[key]) : b[key])) changed.push(key);
  }
  const a5 = [flag(e.base, "msg5", "any"), flag(e.base, "msg5", "all")];
  const b5 = [flag(e.current, "msg5", "any"), flag(e.current, "msg5", "all")];
  if (e.gold > 0) {
    if ([...a5, ...b5].includes(null)) unavailable.push("msg5");
    else if (!isDeepStrictEqual(a5, b5)) changed.push("msg5");
  }
  return { status: changed.length ? "changed" : unavailable.length ? "unknown" : "identical", changed, unavailable };
}

function poolFacts(obs) {
  const capture = obs.row?.pool_capture, order = capture?.access_orders?.[0];
  if (capture?.status !== "captured" || !Array.isArray(capture.pool) || capture.pool.length > 16
    || order?.status !== "ordered" || order.truncated !== false || !Array.isArray(order.entries)
    || order.total !== order.entries.length) return null;
  const roots = capture.pool.map(p => p.source?.target?.root_id);
  if (roots.some(r => typeof r !== "string") || unique(roots).length !== roots.length) return null;
  return { roots, order };
}

function residual(obs) {
  if (!obs.applicable) return { status: "not_applicable", reason: "gold0" };
  if (!obs.known) return { status: "unavailable", reason: obs.issues };
  const messages = obs.score.source_diagnostics?.messages;
  const mapped = Array.isArray(messages) && messages.every(m => typeof root(m) === "string")
    ? unique(messages.map(root)) : null;
  const pool = poolFacts(obs);
  return { status: obs.score.read_gold?.complete && mapped && pool ? "available" : "partial",
    all_miss: flag(obs, "msg5", "all") === false,
    distinct_mapped_gold_roots: mapped?.length ?? null, mapping_complete: obs.score.read_gold?.complete ?? null,
    gold_roots: mapped, pool_status: pool ? "available" : "unavailable",
    in_pool: mapped && pool ? mapped.filter(r => pool.roots.includes(r)) : null,
    out_of_pool: mapped && pool ? mapped.filter(r => !pool.roots.includes(r)) : null,
    in_slots_6_16: mapped && pool ? mapped.filter(r => pool.order.entries.some((entry, index) =>
      index >= 5 && index < 16 && root(entry) === r)) : null };
}

// Interval byte accounting only; scoring remains owned by recall-harness-score.mjs.
export function slotBytes(intervals) {
  if (!Array.isArray(intervals)) return null;
  const slots = intervals.filter(i => i.span !== null && i.slot_index < 10)
    .map(i => ({ slot: i.slot_index, target: i.target, span: i.span }));
  if (unique(slots.map(i => i.slot)).length !== slots.length || slots.some(i => !Number.isSafeInteger(i.slot) || i.slot < 0
    || !i.span || !Number.isSafeInteger(i.span.content_start) || !Number.isSafeInteger(i.span.content_end)
    || i.span.content_start < 0 || i.span.content_end < i.span.content_start)) return null;
  let cumulative = 0;
  return slots.map(s => {
    const bytes = s.span.content_end - s.span.content_start, start = cumulative;
    cumulative += bytes;
    return { slot: s.slot + 1, root_id: root(s), bytes, cumulative_start: start, cumulative_end: cumulative,
      prefix_bytes: Object.fromEntries(BUDGETS.map(b => [b, clipDeliveredSlotsByBudget(slots, b)
        .filter(i => i.slot === s.slot).reduce((n, i) => n + i.span.content_end - i.span.content_start, 0)])) };
  });
}

function swapTrace(e) {
  const pool = poolFacts(e.current), association = pool?.order.statement_association;
  const sourceEntries = pool?.order.entries.filter(i => i.target?.kind === "source_evidence");
  const accessOrders = e.current.row?.pool_capture?.access_orders;
  const status = ["swapped", "unchanged", "resource_refused", "not_run"].includes(association?.status)
    ? association.status : "unavailable";
  const retainedLifecycle = e.current.row?.pool_capture?.association_lifecycle;
  const lifecycle = Array.isArray(retainedLifecycle)
    ? retainedLifecycle.filter(item => pool === null || item.request_id === pool.order.request_id) : [];
  const stages = ["acquisition", "source_retention", "field_admission"];
  const availabilityObserved = pool !== null && stages.every(stage => {
    const facts = lifecycle.filter(item => item.stage === stage);
    return facts.length === 1 && (stage === "acquisition" ? ["not_requested", "ready", "unavailable"]
      : ["retained", "discarded", "absent"]).includes(facts[0].status)
      && (["ready", "retained"].includes(facts[0].status) ? facts[0].reason === null || typeof facts[0].reason === "string"
        : typeof facts[0].reason === "string" && facts[0].reason.length > 0);
  });
  const replacement = status === "swapped" ? root(sourceEntries?.[4]) : null;
  const entered = replacement && Array.isArray(e.current.row?.intervals)
    ? e.current.row.intervals.some(i => i.slot_index < 5 && root(i) === replacement) : null;
  return { status, navigation_refusals: (Array.isArray(accessOrders) ? accessOrders : [])
      .filter(order => order?.status === "resource_refused").map(order => ({ request_id: order.request_id, ...order.navigation_refusal })),
    availability: { status: availabilityObserved ? "observed" : lifecycle.length ? "partial" : "unknown",
      stages: lifecycle }, replacement_global_rank: association?.replacement_global_rank ?? null,
    replacement_root: replacement, entered_first5: entered, diagnostic: association ?? null,
    paired: Object.fromEntries(["msg5", "b4096", "b8192"].map(m => [m,
      Object.fromEntries(["any", "all"].map(k => {
        const a = flag(e.base, m, k), b = flag(e.current, m, k);
        return [k, e.gold === 0 ? "not_applicable" : a === null || b === null ? "unknown" : !a && b ? "gain" : a && !b ? "loss" : "unchanged"];
      }))])), initial_ten_slot_bytes: slotBytes(e.current.row?.intervals) };
}

function formationSummary(entries, side) {
  return Object.fromEntries(["question_time", "statements"].map(field => {
    const statuses = {};
    for (const e of entries) {
      const status = e[side].row?.formation?.[field]?.status ?? "not_observed";
      (statuses[status] ??= []).push(e.question_id);
    }
    return [field, Object.fromEntries(Object.entries(statuses).map(([status, ids]) => [status, { count: ids.length, ids }]))];
  }));
}

export function buildOfflineReport(input) {
  if (!Array.isArray(input.questions) || !input.questions.length) fail("questions must declare the full census");
  const ids = new Set();
  for (const q of input.questions) {
    if (typeof q.question_id !== "string" || !q.question_id || ids.has(q.question_id)
      || !["dev2", "o100", "heldout"].includes(q.cohort) || !Number.isSafeInteger(q.gold) || q.gold < 0) fail("invalid or duplicate census question");
    ids.add(q.question_id);
  }
  const base = sideIndex(input.base, ids), current = sideIndex(input.current, ids);
  const entries = input.questions.map(q => ({ ...q, base: observation(base, q), current: observation(current, q) }));
  const rows = entries.map(e => ({ question_id: e.question_id, cohort: e.cohort, gold: e.gold,
    question_type: e.current.row?.question_type ?? e.base.row?.question_type ?? "unavailable",
    base: { status: e.base.row?.status ?? null, issues: e.base.issues },
    current: { status: e.current.row?.status ?? null, issues: e.current.issues },
    identities: Object.fromEntries(["base", "current"].map(s => [s, Object.fromEntries(
      ["implementation_revision", "input_identity", "snapshot_sha256", "snapshot_identity", "arm_identity"]
        .map(k => [k, e[s].row?.[k] ?? null]))])),
    formation: { base: e.base.row?.formation ?? null, current: e.current.row?.formation ?? null },
    parity_metadata: parityMetadata(e.base.row, e.current.row),
    parity: parity(e), residual: residual(e.current), slot5: swapTrace(e) }));
  const residual_classes = {};
  for (const row of rows.filter(r => r.residual.all_miss === true)) {
    const r = row.residual;
    const key = JSON.stringify([row.question_type, r.distinct_mapped_gold_roots, r.mapping_complete,
      r.in_pool?.length ?? null, r.out_of_pool?.length ?? null, r.in_slots_6_16?.length ?? null]);
    (residual_classes[key] ??= []).push(row.question_id);
  }
  const observedSwaps = rows.filter(r => r.slot5.status !== "unavailable");
  const swapped = observedSwaps.filter(r => r.slot5.status === "swapped");
  const decidedSwaps = observedSwaps.filter(r => ["swapped", "unchanged"].includes(r.slot5.status));
  return { status: "diagnostic_only", qualification: "NOT_VERIFIED", label: input.label ?? null,
    provenance: input.provenance ?? null, sides: { base: { label: base.label, arm: base.arm, score_arm: base.score_arm },
      current: { label: current.label, arm: current.arm, score_arm: current.score_arm } },
    score_contracts: { base: base.score_contract ?? null, current: current.score_contract ?? null },
    census: { declared_ids: [...ids], declared: ids.size, b0_expected: 488, b0_size_matches: ids.size === 488,
      base: { rows: base.rowsIndex.anomalies, scores: base.scoresIndex.anomalies },
      current: { rows: current.rowsIndex.anomalies, scores: current.scoresIndex.anomalies } },
    overall: { base: summarize(entries, "base"), current: summarize(entries, "current") },
    formation: { base: formationSummary(entries, "base"), current: formationSummary(entries, "current") },
    cohorts: Object.fromEntries(["dev2", "o100", "heldout"].map(c => [c, floor(entries.filter(e => e.cohort === c), c)])),
    parity: { changed_ids: rows.filter(r => r.parity.status === "changed").map(r => r.question_id),
      unknown_ids: rows.filter(r => r.parity.unavailable.length).map(r => r.question_id),
      identical_ids: rows.filter(r => r.parity.status === "identical").map(r => r.question_id) },
    paired: Object.fromEntries(metrics.map(m => [m, Object.fromEntries(["any", "all"].map(k => [k, paired(entries, m, k)]))])),
    all_observed: Object.fromEntries([base, current].map((s, i) => [i ? "current" : "base", {
      status: s.all_observed_scores ? "caller_supplied_diagnostic" : "unavailable",
      anomalies: s.allIndex.anomalies, scores: [...ids].map(id => ({ question_id: id, score: s.allIndex.get(id) })) }])),
    residual_classes, residual_unknown_ids: rows.filter(r => !["available", "not_applicable"].includes(r.residual.status)).map(r => r.question_id),
    slot5: { declared: rows.length, observed: observedSwaps.length, unknown: rows.length - observedSwaps.length,
      swapped: swapped.length, completed_decisions: decidedSwaps.length,
      not_run: observedSwaps.filter(r => r.slot5.status === "not_run").length,
      optional_work_refused: observedSwaps.filter(r => r.slot5.status === "resource_refused").length,
      availability_unknown: rows.filter(r => r.slot5.availability.status !== "observed").length,
      observed_swap_rate_denominator: "completed_decisions_only",
      observed_swap_rate: decidedSwaps.length ? swapped.length / decidedSwaps.length : null,
      entered_first5: swapped.filter(r => r.slot5.entered_first5 === true).length }, rows };
}

export function readOfflineReportInput(path) {
  const absolute = resolve(path), provenance = [];
  const read = p => {
    const absolutePath = resolve(dirname(absolute), p), bytes = readFileSync(absolutePath);
    provenance.push({ path: absolutePath, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
    return bytes.toString("utf8");
  };
  const input = JSON.parse(read(absolute));
  for (const side of [input.base, input.current]) {
    if (!side || typeof side.arm !== "string" || typeof side.score_arm !== "string") fail("both sides require explicit arm and score_arm");
    for (const key of ["rows", "scores", "all_observed_scores"]) {
      if (key === "all_observed_scores" && side[key] === undefined) continue;
      if (!Array.isArray(side[key])) fail(`${key} must be an array of JSONL paths`);
      side[key] = side[key].flatMap(p => {
        const absolutePath = resolve(dirname(absolute), p);
        const { rows, bytes, sha256 } = readRecallJsonlFile(absolutePath, { skipWhitespace: true });
        provenance.push({ path: absolutePath, bytes, sha256 });
        return rows;
      });
    }
  }
  return { ...input, provenance };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { input: { type: "string" }, help: { type: "boolean" } } });
  if (values.help) console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split(" */")[0]);
  else {
    if (!values.input) fail("Usage: recall-offline-report.mjs --input INPUT.json > REPORT.json (see --help)");
    console.log(JSON.stringify(buildOfflineReport(readOfflineReportInput(values.input)), null, 2));
  }
}
