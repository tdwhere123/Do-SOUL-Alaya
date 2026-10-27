import { afterEach, describe, expect, it, vi } from "vitest";
import type { QuestionTimePreference } from "@do-soul/alaya-protocol";
import { SourceIndexAcquisition } from "../../source-index/source-index-acquisition.js";
import { fixture, configuration, fieldSha256, WORKSPACE, type Fixture } from
  "../../../../storage/src/__tests__/repos/source-index/source-index-fixture.js";
import { publishIndex, queryInput, query, admitScope, expectBounded } from "./source-index-acquisition-fixture.js";

const opened: Fixture[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const env of opened.splice(0)) env.database.close(); });
const preference: QuestionTimePreference = { interpretation_clock: "2026-09-07T00:00:00.000Z",
  intervals: [{ start: "2020-01-02", end: "2020-01-02" }] };
function setup(empty = false) {
  const env = fixture(); opened.push(env);
  const specs = empty ? [] : [...Array.from({ length: 18 }, (_, i) => ({ id: `native-${i}`, body: "needle a",
    vectors: [[1, 0, 0]], eventTime: i === 0 ? "2020-01-02T23:59:59.999Z" : "2020-01-01T12:00:00.000Z" })),
    { id: "time-only", body: `needle ${"noise ".repeat(100)}`, vectors: [[-1, 0, 0]], eventTime: "2020-01-02T00:00:00.000Z" }];
  const { config, records } = publishIndex(env, specs, configuration({ window_bytes: 4096, max_input_tokens: 4096 }));
  const input = queryInput(config, { allowance: { max_attempts: 128, max_roots: 16, max_vector_windows: 4096 } });
  return { env, input, records };
}
const ids = (result: ReturnType<typeof query>) => result.nominations.map(row => row.source.source_id);

describe("question time bounded preference through SQLite acquisition", () => {
  it("orders original in-window roots, time lexical roots, then native fallback under one allowance", () => {
    const { env, input } = setup();
    const baseline = query(env, input, admitScope);
    expect(ids(baseline)).not.toContain("time-only");
    const preferred = query(env, { ...input, question_time: preference }, admitScope);
    const inWindow = ids(baseline).filter(id => id === "native-0");
    expect(ids(preferred)).toEqual([...inWindow, "time-only", ...ids(baseline).filter(id => id !== "native-0")].slice(0, 16));
    expectBounded(preferred, input);
    expect(preferred.accounting.attempted).toBeLessThan(128);
    expect(preferred.nominations).toHaveLength(16);
    expect(preferred.limitations).toContain("question_time_bounded_preference");
    expect(preferred.resource_refusals).toEqual([]);
    expect(preferred.nominations.find(row => row.source.source_id === "time-only")!.lexical)
      .toEqual([expect.objectContaining({ domain: "question_time", rank: 2 })]);
    const capture = env.database.connection.transaction(() => new SourceIndexAcquisition(env.index, fieldSha256)
      .nominateWithWitness({ ...input, question_time: preference }, admitScope))();
    expect(capture.question_time_order).toEqual(capture.result.nominations.map(row => row.source.root_key));
    expect(capture.witness.find(row => row.source.source_id === "time-only")).toMatchObject({
      domain: "question_time", route: { kind: "lexical", native_rank: 2 } });
    // Filtering must retain the established FTS statistics, not rebuild a per-query corpus.
    const all = env.index.readLexicalCandidates(WORKSPACE, "needle", 128, input.budget);
    const timed = env.index.readLexicalCandidates(WORKSPACE, "needle", 128, input.budget, preference);
    expect(timed.candidates.map(row => row.source.source_id).sort()).toEqual(["native-0", "time-only"]);
    for (const row of timed.candidates) expect(row.lexical.bm25)
      .toBe(all.candidates.find(candidate => candidate.source.root_key === row.source.root_key)!.lexical.bm25);
  });

  it("keeps empty windows and outside-corpus windows nomination-identical, including witnesses", () => {
    const { env, input } = setup();
    const acquire = (question_time?: QuestionTimePreference) => env.database.connection.transaction(() =>
      new SourceIndexAcquisition(env.index, fieldSha256).nominateWithWitness({ ...input,
        ...(question_time === undefined ? {} : { question_time }) }, admitScope))();
    const baseline = acquire();
    const empty = acquire({ ...preference, intervals: [] });
    expect(empty).toEqual(baseline);
    const outside = acquire({ ...preference, intervals: [{ start: "1900-01-01", end: "1900-01-02" }] });
    expect(outside.result.nominations).toEqual(baseline.result.nominations);
    expect(outside.witness).toEqual(baseline.witness);
    expect(outside.result.accounting).toEqual(baseline.result.accounting);
    const tight = { ...input, budget: { work_units: baseline.result.resources.work,
      memory_bytes: baseline.result.resources.memory_bytes } };
    expect(ids(query(env, { ...tight, question_time: { ...preference,
      intervals: [{ start: "1900-01-01", end: "1900-01-02" }] } }, admitScope)))
      .toEqual(ids(query(env, tight, admitScope)));
  });

  it("does not increase attempts to recover a denied time root or an exhausted original schedule", () => {
    const { env, input } = setup();
    const denied = query(env, { ...input, question_time: preference }, (_scope, source) =>
      source.source_id === "time-only" ? "denied" : "admitted");
    expect(ids(denied)).not.toContain("time-only");
    expect(ids(denied)).toHaveLength(16);
    expect(denied.accounting.scope_denied).toBeGreaterThan(0);
    expectBounded(denied, input);
    const limited = { ...input, question_time: preference, allowance: { ...input.allowance, max_attempts: 16 } };
    const result = query(env, limited, admitScope);
    expectBounded(result, limited);
    expect(result.accounting.attempted).toBe(16);
    expect(ids(result)).not.toContain("time-only");
  });

  it("reports actual failed SQL separately from no time matches and permits recovery", () => {
    const { env, input } = setup();
    const base = query(env, input, admitScope);
    env.database.connection.exec("ALTER TABLE evidence_capsules RENAME COLUMN retained_source_event_time TO missing_event_time");
    const failed = query(env, { ...input, question_time: preference }, admitScope);
    expect(failed.completion).toBe("partial");
    expect(failed.resource_refusals).toContainEqual({ stage: "nomination", phase: "question_time_read_failed" });
    expect(ids(failed)).toEqual(ids(base));
    env.database.connection.exec("ALTER TABLE evidence_capsules RENAME COLUMN missing_event_time TO retained_source_event_time");
    expect(ids(query(env, { ...input, question_time: preference }, admitScope))).toContain("time-only");
  });

  it("distinguishes valid-empty domain, bounded refusal and invalid input", () => {
    const { env, input } = setup(true);
    const empty = query(env, { ...input, question_time: preference }, admitScope);
    expect(empty.nominations).toEqual([]);
    expect(empty.completion).toBe("complete");
    expect(empty.vector.state?.status).toBe("valid_empty");
    expect(empty.resource_refusals).toEqual([]);
    const limited = env.index.readQuestionTimeDomain(WORKSPACE, preference, [], { work_units: 0, memory_bytes: 0 });
    expect(limited).toMatchObject({ status: "unavailable", reason: "question_time_read_budget" });
    expect(limited.resources.work).toBe(0);
    expect(limited.resources.memory_bytes).toBe(0);
    expect(() => query(env, { ...input, question_time: { ...preference,
      intervals: [{ start: "not-a-day", end: "2020-01-02" }] } }, admitScope)).toThrow();
  });

  it("retains fallback when time lexical admission runs out of resources", () => {
    const { env, input } = setup();
    const admit = env.index.admitQueryCandidate.bind(env.index);
    vi.spyOn(env.index, "admitQueryCandidate").mockImplementation((source, ...rest) => source.source_id === "time-only"
      ? { status: "resource_limited", reason: "read_budget", phase: "injected_time_admission_refusal",
        resources: { work: 0, memory_bytes: 0, native_bytes: 0, sql_internal_work: "unknown" } }
      : admit(source, ...rest));
    const result = query(env, { ...input, question_time: preference }, admitScope);
    expectBounded(result, input);
    expect(ids(result)).toHaveLength(16);
    expect(ids(result)).not.toContain("time-only");
    expect(result.resource_refusals).toContainEqual({ stage: "admission", phase: "injected_time_admission_refusal" });
  });
});
