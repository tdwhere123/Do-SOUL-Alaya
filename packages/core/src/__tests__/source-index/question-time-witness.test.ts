import { describe, expect, it } from "vitest";
import { SourceSemanticResourceLedger, sourceIndexNativeRootKey, type QuestionTimePreference,
  type SourceIndexStatementKeyVectorRead, type SourceIndexTarget, type SourceIndexTemplateRead } from "@do-soul/alaya-protocol";
import { preferQuestionTimeWitness } from "../../source-index/question-time-witness.js";
import { readResources, templateStatement } from "./source-template-fixture.js";

const march: QuestionTimePreference = { interpretation_clock: "2023-04-10T00:00:00.000Z",
  intervals: [{ start: "2023-03-01", end: "2023-03-31" }] };
const near = Float32Array.of(1, 0), far = Float32Array.of(0.6, 0.8);
type Root = Readonly<{ text?: string; role?: string; session?: string | null; vector?: Float32Array; unread?: boolean }>;

function scenario(roots: readonly Root[]) {
  const built = roots.map((root, i) => {
    const made = templateStatement(`root-${i}`, root.text ?? "I like tea.", root.text ?? "I like tea.", root.role ?? "user");
    const statement = { ...made.statement, bound: { ...made.statement.bound,
      message: { ...made.statement.bound.message, recorded_at: root.session === undefined ? "2023-01-01T00:00:00.000Z" : root.session } } };
    return { key: sourceIndexNativeRootKey(made.source), source: made.source, statement, root };
  });
  const reads: string[] = [];
  const repository = {
    readTemplateStatements: (source: SourceIndexTarget): SourceIndexTemplateRead => {
      const row = built.find(item => item.source.root_key === source.root_key)!; reads.push(row.key);
      return row.root.unread ? { status: "unknown", reason: "fixture_unread", resources: readResources }
        : { status: "complete", statements: [row.statement], resources: readResources };
    },
    readStatementKeyVectors: (keys: readonly SourceIndexTarget[]): SourceIndexStatementKeyVectorRead => ({ status: "ready",
      vectors: keys.map(key => built.find(item => item.statement.source.root_key === key.root_key)?.root.vector ?? null), resources: readResources })
  };
  const run = (options: { preference?: QuestionTimePreference; budget?: number; readers?: boolean } = {}) => preferQuestionTimeWitness({
    order: built.map(item => item.key), sources: new Map(built.map(item => [item.key, item.source])),
    preference: options.preference ?? march, query: Float32Array.of(1, 0),
    repository: options.readers === false ? {} : repository,
    meter: new SourceSemanticResourceLedger({ work_units: options.budget ?? 1_000_000, memory_bytes: 64_000_000 }), nativeBytes: () => {} });
  const index = (keys: readonly string[]) => keys.map(key => built.findIndex(item => item.key === key));
  return { run, index, reads };
}

const firstFive: Root[] = [
  {},
  { session: "2023-01-01T00:00:00.000Z" }, // no stated time, session outside
  { text: "I moved on January 3rd.", session: "2023-03-20T00:00:00.000Z" }, // dated outside, session inside
  { session: "2023-03-15T00:00:00.000Z" }, // no stated time, session in the window: possibly in it
  { unread: true }
];

describe("question-time stated-event witness", () => {
  it("places the query-nearest user witness in the last slot that is neither witness, possibly in window, nor unread", () => {
    const env = scenario([...firstFive, {}, { text: "I hiked on March 12th.", session: "2023-03-20T00:00:00.000Z", vector: far },
      { text: "I ran the race on March 5th.", session: "2023-03-20T00:00:00.000Z", vector: near }]);
    const { order, decision } = env.run();
    expect(env.index(order)).toEqual([0, 1, 7, 3, 4, 2, 5, 6]);
    expect(decision).toEqual({ status: "injected", reason: null, witnesses: 2, root_position: 8, slot: 3 });
  });

  it("resolves relative and weekday terms against the statement's own session", () => {
    const env = scenario([...firstFive, { text: "I ran the race last Saturday.", session: "2023-03-06T00:00:00.000Z", vector: near },
      { text: "I ran another last Saturday.", session: "2023-04-03T00:00:00.000Z", vector: near }]);
    expect(env.run().decision).toMatchObject({ status: "injected", witnesses: 1, root_position: 6, slot: 3 });
  });

  it("never treats session time alone, assistant statements or dates outside the window as witnesses", () => {
    const env = scenario([...firstFive, { session: "2023-03-20T00:00:00.000Z", vector: near },
      { text: "You ran it on March 5th.", role: "assistant", session: "2023-03-20T00:00:00.000Z", vector: near },
      { text: "I ran it on February 5th.", session: "2023-03-20T00:00:00.000Z", vector: near }]);
    const { order, decision } = env.run();
    expect(decision).toMatchObject({ status: "unchanged", reason: "question_time_no_witness", witnesses: 0 });
    expect(env.index(order)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it("keeps the order when the witness is already first five, every slot is protected, or the window follows the clock", () => {
    const inFive = scenario([{}, { text: "I ran it on March 5th.", session: "2023-03-20T00:00:00.000Z", vector: near }, {}, {}, {}, {}]);
    expect(inFive.run().decision).toMatchObject({ status: "unchanged", reason: "question_time_witness_in_first_five" });
    const protectedFive = scenario([{}, { unread: true }, { unread: true }, { unread: true }, { unread: true },
      { text: "I ran it on March 5th.", session: "2023-03-20T00:00:00.000Z", vector: near }]);
    expect(protectedFive.run().decision).toMatchObject({ status: "no_free_slot", witnesses: 1 });
    const future = scenario([...firstFive, { text: "I ran it on March 5th.", vector: near }]);
    expect(future.run({ preference: { interpretation_clock: "2023-02-01T00:00:00.000Z", intervals: march.intervals } }).decision)
      .toMatchObject({ status: "unchanged", reason: "question_time_window_after_clock" });
    expect(future.reads).toEqual([]);
  });

  it("is unknown and unchanged without readers or budget", () => {
    const env = scenario([...firstFive, { text: "I ran it on March 5th.", session: "2023-03-20T00:00:00.000Z", vector: near }]);
    expect(env.run({ readers: false }).decision).toMatchObject({ status: "unknown", reason: "question_time_witness_reader_unavailable" });
    const starved = env.run({ budget: 20 });
    expect(starved.decision).toMatchObject({ status: "unknown", reason: expect.stringMatching(/^question_time_witness_budget:/u) });
    expect(env.index(starved.order)).toEqual([0, 1, 2, 3, 4, 5]);
  });
});
