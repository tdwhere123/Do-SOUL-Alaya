import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, it } from "vitest";

const script = fileURLToPath(new URL("../../../scripts/recall-offline-report.mjs", import.meta.url));
const report = await import(pathToFileURL(script).href);
const target = (root_id: string) => ({ kind: "source_evidence", root_id });
const interval = (slot_index: number, root_id: string, bytes = 1000) => ({
  slot_index, target: target(root_id), span: { content_start: 10, content_end: 10 + bytes }
});
const metric = (any: boolean, all = any) => ({ any, all });
const contract = { owner: "recall-harness-score.mjs", revision: "fixture-score-owner", reader: "end_continuation", ranked_slots: 10 };
function row(id = "gain") {
  const roots = Array.from({ length: 16 }, (_, i) => `r${i + 1}`);
  return { question_id: id, arm: "time", status: "complete", reader: "end_continuation", question_type: "multi-session",
    input_identity: "fixed-input", snapshot_sha256: "fixed-snapshot", stop_cause: "observed_ten_slot_prefix",
    intervals: roots.slice(0, 10).map((r, i) => interval(i, r)), end_continuation: { continuations: [] },
    pool_capture: { status: "captured", pool: roots.map(r => ({ source: { target: target(r) } })),
      access_orders: [{ status: "ordered", truncated: false, total: 16,
        entries: roots.map(r => ({ target: target(r) })),
        statement_association: { status: "swapped", replacement_global_rank: 9, source_slot: 5 } }] } };
}
function score(id = "gain", hit = false) {
  return { question_id: id, arm: "time+end-continuation", status: "complete", gold: 2, scored: true,
    msg5: metric(hit), msg10: metric(true), b2048: metric(false), b4096: metric(!hit), b8192: metric(!hit),
    read_gold: { complete: true, mapped: 2 },
    source_diagnostics: { messages: ["r7", "outside", "r7"].map(r => ({ target: target(r) })) } };
}
function fixture() {
  return { label: "synthetic-offline-not-current-main", questions: [
    { question_id: "gain", cohort: "dev2", gold: 2 }, { question_id: "loss", cohort: "heldout", gold: 2 }],
  base: { label: "saved-base", arm: "time", score_arm: "time+end-continuation", score_contract: contract,
    rows: [row(), row("loss")], scores: [score(), score("loss", true)] },
  current: { label: "saved-current", arm: "time", score_arm: "time+end-continuation", score_contract: contract,
    rows: [row(), row("loss")], scores: [score("gain", true), score("loss")] } };
}

it("reports independent paired expectations, exact sign tests, floors, residual roots and actual swap traces", () => {
  const out = report.buildOfflineReport(fixture());
  expect(out.status).toBe("diagnostic_only");
  expect(out.qualification).toBe("NOT_VERIFIED");
  expect(out.paired.msg5.all).toMatchObject({ declared: 2, answerable_known: 2, base: 1, current: 1,
    wins: ["gain"], losses: ["loss"], exact_sign_p: 1 });
  expect(out.paired.b4096.all).toMatchObject({ wins: ["loss"], losses: ["gain"] });
  expect(out.paired.b8192.any.losses).toEqual(["gain"]);
  expect(report.exactSignTest(3, 0)).toBe(0.25);
  expect(report.exactSignTest(0, 0)).toBe(1);
  expect(out.cohorts.dev2.floor).toMatchObject({ any: { target: 263, met: null }, all: { target: 205, met: null } });
  expect(out.cohorts.o100.floor).toMatchObject({ any: { target: 90 }, all: { target: 70 } });
  expect(out.cohorts.heldout.floor).toMatchObject({ any: { target: 1 }, all: { target: 1 } });
  expect(out.rows[1].residual).toMatchObject({ status: "available", distinct_mapped_gold_roots: 2,
    in_pool: ["r7"], out_of_pool: ["outside"], in_slots_6_16: ["r7"] });
  expect(out.slot5).toMatchObject({ observed: 2, swapped: 2, observed_swap_rate: 1, entered_first5: 2 });
  expect(out.rows[0].slot5).toMatchObject({ replacement_global_rank: 9, replacement_root: "r5", entered_first5: true,
    paired: { msg5: { all: "gain" }, b4096: { all: "loss" }, b8192: { all: "loss" } } });
  expect(out.all_observed.current.status).toBe("unavailable");
});

it("keeps the full 488 denominator and uses declared answerable counts for held-out floor rounding", () => {
  const input = fixture();
  input.questions = ["dev2", "o100", "heldout"].flatMap(cohort => Array.from({ length: cohort === "dev2" ? 288 : 100 }, (_, i) => ({
    question_id: `${cohort}-${i}`, cohort, gold: i < (cohort === "dev2" ? 277 : cohort === "o100" ? 95 : 93) ? 2 : 0
  })));
  for (const side of [input.base, input.current]) {
    side.rows = input.questions.map(q => row(q.question_id));
    side.scores = input.questions.map(q => ({ ...score(q.question_id, q.gold > 0), gold: q.gold, scored: q.gold > 0 }));
  }
  const out = report.buildOfflineReport(input);
  expect(out.census).toMatchObject({ declared: 488, b0_size_matches: true });
  expect(out.overall.current.metrics.msg5.all).toEqual({ success: 465, miss: 0, unknown_answerable: 0, not_applicable: 23, declared: 488, answerable: 465 });
  expect(out.cohorts.heldout.floor).toEqual({ any: { target: 89, success: 93, answerable_unknown: 0, met: true },
    all: { target: 69, success: 93, answerable_unknown: 0, met: true } });
  expect(out.cohorts.dev2.floor.any.met).toBe(true);
});

it("accounts byte cuts in ordered ten-slot intervals without charging an eleventh slot", () => {
  const intervals = [interval(0, "a", 3000), interval(4, "b", 2000), interval(9, "c", 4000), interval(10, "d", 9000)];
  expect(report.slotBytes(intervals)).toEqual([
    { slot: 1, root_id: "a", bytes: 3000, cumulative_start: 0, cumulative_end: 3000,
      prefix_bytes: { 2048: 2048, 4096: 3000, 8192: 3000 } },
    { slot: 5, root_id: "b", bytes: 2000, cumulative_start: 3000, cumulative_end: 5000,
      prefix_bytes: { 2048: 0, 4096: 1096, 8192: 2000 } },
    { slot: 10, root_id: "c", bytes: 4000, cumulative_start: 5000, cumulative_end: 9000,
      prefix_bytes: { 2048: 0, 4096: 0, 8192: 3192 } }
  ]);
  expect(report.slotBytes(undefined)).toBeNull();
  expect(report.slotBytes([interval(0, "a"), interval(0, "a")])).toBeNull();
});

it("retains every missing, failed, partial, unavailable and gold0 census member", () => {
  const input = fixture();
  input.questions = ["missing", "failed", "partial", "unavailable", "gold0"].map(id => ({
    question_id: id, cohort: "dev2", gold: id === "gold0" ? 0 : 2 }));
  input.current.rows = ["failed", "partial", "unavailable", "gold0"].map(id => ({ ...row(id), status: id === "gold0" ? "complete" : id }));
  input.current.scores = input.current.rows.map(r => ({ ...score(r.question_id, true), gold: r.question_id === "gold0" ? 0 : 2 }));
  const out = report.buildOfflineReport(input);
  expect(out.census.declared_ids).toEqual(["missing", "failed", "partial", "unavailable", "gold0"]);
  expect(out.overall.current.metrics.msg5.any).toEqual({ success: 0, miss: 0, unknown_answerable: 4, not_applicable: 1, declared: 5, answerable: 4 });
  expect(out.overall.current.gold0).toBe(1);
  expect(out.census.current.rows.missing).toEqual(["missing"]);
  expect(out.paired.msg5.any.answerable_known).toBe(0);
  expect(out.rows).toHaveLength(5);
});

it("quarantines duplicates and unexpected IDs rather than silently intersecting or choosing the last row", () => {
  const input = fixture();
  input.current.rows.push(row("gain"), row("unexpected"));
  input.current.scores.push(score("loss"), score("unexpected"));
  const out = report.buildOfflineReport(input);
  expect(out.census.current.rows).toMatchObject({ duplicate: ["gain"], unexpected: ["unexpected"] });
  expect(out.census.current.scores.duplicate).toEqual(["loss"]);
  expect(out.overall.current.metrics.msg5.any.unknown_answerable).toBe(2);
  expect(out.paired.msg5.any.aggregate_not_below_base).toBeNull();
  expect(() => report.buildOfflineReport({ ...input, questions: [...input.questions, input.questions[0]] })).toThrow("duplicate census");
});

it("does not treat absent or partial pool captures or missing association diagnostics as no recurrence", () => {
  const input = fixture();
  const withoutPool = { ...input.current.rows[0], pool_capture: undefined };
  const out = report.buildOfflineReport({ ...input, current: { ...input.current, rows: [
    withoutPool, { ...row("loss"), pool_capture: { ...row().pool_capture, status: "partial" } }
  ] } });
  expect(out.rows[0].residual).toMatchObject({ pool_status: "unavailable", in_pool: null, out_of_pool: null, in_slots_6_16: null });
  expect(out.slot5).toMatchObject({ observed: 0, unknown: 2, observed_swap_rate: null });
  expect(out.rows[1].slot5.status).toBe("unavailable");
});

it("separates causal absence, optional refusal, completed decisions and unknown historical slot evidence", () => {
  const input = fixture();
  const ids = ["swapped", "unchanged", "resource_refused", "field_discarded", "acquisition_failed", "legacy"];
  const rows = ids.map(id => ({ ...row(id), pool_capture: { ...row(id).pool_capture,
    access_orders: [{ ...row(id).pool_capture.access_orders[0], request_id: 4,
      statement_association: id === "legacy" ? undefined : {
        status: ["field_discarded", "acquisition_failed"].includes(id) ? "not_run" : id,
        source_slot: 5, replacement_global_rank: id === "swapped" ? 9 : null,
        reason: ["field_discarded", "acquisition_failed"].includes(id) ? "association_absent_at_navigation" : "native_decision" } }],
    association_lifecycle: id === "legacy" ? undefined : [
      { request_id: 4, stage: "acquisition", status: id === "acquisition_failed" ? "unavailable" : "ready",
        reason: id === "acquisition_failed" ? "statement key association retention" : null },
      { request_id: 4, stage: "source_retention", status: id === "acquisition_failed" ? "absent" : "retained",
        reason: id === "acquisition_failed" ? "association_not_provided" : null },
      { request_id: 4, stage: "field_admission", status: id === "field_discarded" ? "discarded"
        : id === "acquisition_failed" ? "absent" : "retained",
        reason: id === "field_discarded" ? "field_retained_statement_association"
          : id === "acquisition_failed" ? "association_not_provided" : null }
    ] } }));
  const out = report.buildOfflineReport({ ...input, questions: ids.map(question_id => ({ question_id, cohort: "dev2", gold: 2 })),
    current: { ...input.current, rows, scores: ids.map(id => score(id)) } });
  expect(out.slot5).toMatchObject({ declared: 6, observed: 5, unknown: 1, swapped: 1,
    completed_decisions: 2, not_run: 2, optional_work_refused: 1, availability_unknown: 1,
    observed_swap_rate_denominator: "completed_decisions_only", observed_swap_rate: 0.5 });
  expect(out.rows[3].slot5).toMatchObject({ status: "not_run", availability: { status: "observed", stages: [
    { stage: "acquisition", status: "ready" }, { stage: "source_retention", status: "retained" },
    { stage: "field_admission", status: "discarded", reason: "field_retained_statement_association" }
  ] } });
  expect(out.rows[4].slot5).toMatchObject({ status: "not_run", availability: { status: "observed" } });
  expect(out.rows[5].slot5).toMatchObject({ status: "unavailable", availability: { status: "unknown", stages: [] } });
});

it("retains a native navigation refusal and partial lifecycle without promoting an incomplete pool", () => {
  const input = fixture();
  const current = row();
  const refused = { ...current, pool_capture: { ...current.pool_capture, status: "partial",
    access_orders: [{ status: "resource_refused", request_id: 4, entries: [], total: 16, truncated: true,
      navigation_refusal: { phase: "statement key association link", constraints: { work: { required: 20, available: 0 } } } }],
    association_lifecycle: [{ request_id: 4, stage: "field_admission", status: "retained" }] } };
  const out = report.buildOfflineReport({ ...input, current: { ...input.current, rows: [refused, row("loss")] } });
  expect(out.rows[0].slot5).toMatchObject({ status: "unavailable", availability: { status: "partial", stages: [
    { stage: "field_admission", status: "retained" }
  ] }, navigation_refusals: [{ request_id: 4, phase: "statement key association link" }] });
  expect(out.slot5).toMatchObject({ unknown: 1, completed_decisions: 1, swapped: 1 });
});

it("detects guard mismatches, gold census mismatches and all parity dimensions", () => {
  const input = fixture();
  input.current.score_contract = { ...contract, ranked_slots: 16 };
  let out = report.buildOfflineReport(input);
  expect(out.overall.current.metrics.b4096.all.unknown_answerable).toBe(2);
  expect(out.rows[0].current.issues).toContain("score_guard_mismatch");
  input.current.score_contract = contract;
  const wrongReader = { ...input, current: { ...input.current, rows: [{ ...row(), reader: "current" }, row("loss")] } };
  expect(report.buildOfflineReport(wrongReader).rows[0].current.issues).toContain("row_reader_mismatch");
  input.current.rows[0] = { ...row(), status: "partial", stop_cause: "failed", input_identity: "other-input",
    snapshot_sha256: "other-snapshot", intervals: [interval(0, "different")], end_continuation: { continuations: [] } };
  out = report.buildOfflineReport(input);
  expect(out.rows[0].parity.changed).toEqual(["status", "stop_cause", "snapshot_sha256", "intervals"]);
  expect(out.rows[0].parity.unavailable).toContain("msg5");
  input.current.scores = [score("gain", true), { ...score("loss"), gold: 1 }];
  expect(report.buildOfflineReport(input).rows[1].current.issues).toContain("gold_census_mismatch");
});

it("compares continuations and retains missing parity identities as unknown even when scores match", () => {
  const input = fixture();
  const baseline = row();
  const current = { ...row(), end_continuation: { continuations: [interval(0, "r1")] } };
  let out = report.buildOfflineReport({ ...input, current: { ...input.current, rows: [current, row("loss")] } });
  expect(out.rows[0].parity.changed).toEqual(["end_continuation", "msg5"]);
  out = report.buildOfflineReport({ ...input, current: { ...input.current, rows: [{ ...baseline, snapshot_sha256: undefined }, row("loss")],
    scores: input.base.scores } });
  expect(out.rows[0].parity).toEqual({ status: "unknown", changed: [], unavailable: ["snapshot_sha256"] });
});

it("separates runtime provenance and latency from semantic delivery without hiding payload changes", () => {
  const input = fixture();
  const baseRow = { ...row(), end_continuation: { continuations: [], issues: [], latency_ms: 10 } };
  const currentRow = { ...baseRow, input_identity: "new-runtime", end_continuation: { ...baseRow.end_continuation, latency_ms: 99 } };
  const compare = (r: unknown) => report.buildOfflineReport({ ...input,
    base: { ...input.base, rows: [baseRow, row("loss")] },
    current: { ...input.current, rows: [r, row("loss")], scores: input.base.scores } }).rows[0];
  expect(compare(currentRow).parity.status).toBe("identical");
  expect(compare(currentRow).parity_metadata).toMatchObject({ provenance_changed_fields: ["input_identity"], timing_changed: true,
    timing: { base: { continuation_latency_ms: 10 }, current: { continuation_latency_ms: 99 } } });
  for (const changed of [
    { ...currentRow, intervals: [interval(0, "r1", 1001)] },
    { ...currentRow, intervals: [interval(1, "r1")] },
    { ...currentRow, end_continuation: { ...currentRow.end_continuation, issues: ["no progress"] } },
    { ...currentRow, end_continuation: { ...currentRow.end_continuation, continuations: [interval(0, "r1")] } },
    { ...currentRow, status: "failed" }
  ]) expect(compare(changed).parity.status).toBe("changed");
});

it("distinguishes five gold0 IDs from unknown answerable rows in a complete 100-question comparison", () => {
  const input = fixture();
  input.questions = Array.from({ length: 100 }, (_, i) => ({ question_id: `q${i}`, cohort: "o100", gold: i < 95 ? 2 : 0 }));
  for (const side of [input.base, input.current]) {
    side.rows = input.questions.map(q => row(q.question_id));
    side.scores = input.questions.map(q => ({ ...score(q.question_id, true), gold: q.gold, scored: q.gold > 0 }));
  }
  let out = report.buildOfflineReport(input);
  expect(out.paired.msg5.any).toMatchObject({ declared: 100, answerable_known: 95, not_applicable: 5,
    not_applicable_ids: ["q95", "q96", "q97", "q98", "q99"], unknown_answerable: 0, aggregate_not_below_base: true });
  expect(out.parity.identical_ids).toHaveLength(100);
  input.current.rows = input.current.rows.filter(r => r.question_id !== "q0");
  out = report.buildOfflineReport(input);
  expect(out.paired.msg5.any).toMatchObject({ declared: 100, answerable_known: 94, not_applicable: 5,
    unknown_answerable: 1, unknown_answerable_ids: ["q0"], aggregate_not_below_base: null });
  input.current.rows = input.current.rows.filter(r => r.question_id !== "q95").map(r => r.question_id === "q96" ? { ...r, status: "failed" } : r);
  out = report.buildOfflineReport(input);
  expect(out.parity.unknown_ids).toEqual(["q0", "q95", "q96"]);
});

it("preserves incomplete formation without rejecting successful raw-fallback recall", () => {
  const input = fixture();
  const formation = { question_time: { status: "incomplete", proposal: "not_issued" },
    statements: { status: "partial", missing_sessions: ["s2"] } };
  const out = report.buildOfflineReport({ ...input, current: { ...input.current,
    rows: [{ ...row(), formation }, row("loss")] } });
  expect(out.rows[0].formation.current).toEqual(formation);
  expect(out.rows[1].formation.current).toBeNull();
  expect(out.rows[0].current.issues).toEqual([]);
  expect(out.overall.current.metrics.msg5.any.success).toBe(1);
  expect(out.formation.current).toEqual({
    question_time: { incomplete: { count: 1, ids: ["gain"] }, not_observed: { count: 1, ids: ["loss"] } },
    statements: { partial: { count: 1, ids: ["gain"] }, not_observed: { count: 1, ids: ["loss"] } }
  });
});

it("reads actual JSONL shards through the offline CLI, hashes inputs and emits the full declared census", () => {
  const dir = mkdtempSync(join(tmpdir(), "recall-offline-report-"));
  try {
    const input = fixture();
    const saved = Object.fromEntries(["base", "current"].map(name => {
      const side = name === "base" ? input.base : input.current;
      for (const [kind, values] of [["rows", side.rows], ["scores", side.scores]] as const) {
        writeFileSync(join(dir, `${name}-${kind}.jsonl`), values.map(v => JSON.stringify(v)).join("\n") + "\n");
      }
      return [name, { ...side, rows: [`${name}-rows.jsonl`], scores: [`${name}-scores.jsonl`] }];
    }));
    const path = join(dir, "input.json");
    writeFileSync(path, JSON.stringify({ ...input, ...saved }));
    const out = JSON.parse(execFileSync(process.execPath, [script, "--input", path], { encoding: "utf8" }));
    expect(out.census.declared_ids).toEqual(["gain", "loss"]);
    expect(out.provenance).toHaveLength(5);
    expect(out.provenance[0]).toMatchObject({ path, bytes: Buffer.byteLength(readFileSync(path)), sha256: expect.stringMatching(/^[a-f0-9]{64}$/u) });
    expect(out.parity.changed_ids).toEqual(["gain", "loss"]);
    expect(out.paired.b4096.all.losses).toEqual(["gain"]);
    expect(out.rows[0].current.issues).toEqual([]);
    expect(out.rows[0].residual).toMatchObject({ status: "available", distinct_mapped_gold_roots: 2 });
    expect(out.rows[0].slot5.paired.b8192.all).toBe("loss");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
