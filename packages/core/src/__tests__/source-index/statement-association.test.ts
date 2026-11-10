import { describe, expect, it } from "vitest";
import { SourceSemanticResourceLedger, type EvidenceCondition, type SourceIndexTarget } from "@do-soul/alaya-protocol";
import { bindEvidenceDemands, evidenceWindow, selectEvidenceWitnesses, quoteStatementAssociation, restrictStatementAssociation,
  StatementKeyRetention, STATEMENT_ASSOCIATION_KEYS_PER_ROOT, type EvidenceDemands, type StatementAssociation,
  type StatementWitnessReader } from "../../source-index/statement-association.js";
import { orderNativeFieldAccess, type NativeRouteLane } from "../../recall/runtime/native-route-opportunity.js";
import { sourceEmbeddingInputDigest } from "../../embedding-recall/source-embedding-runtime.js";

const roots = ["a", "b", "c", "d", "e", "f", "g", "h"];
const meter = (work_units = 1e9, memory_bytes = 1e9) => new SourceSemanticResourceLedger({ work_units, memory_bytes });
const condition = (statement: string, speaker: EvidenceCondition["speaker"] = "user", anchors: string[] = []): EvidenceCondition =>
  ({ statement, speaker, anchors });
const ready = (...vectors: number[][]): EvidenceDemands => ({ status: "ready", vectors: vectors.map(v => Float32Array.from(v)),
  conditions: vectors.map((_, index) => condition(`s${index}`)) });
const noRefusal = () => { throw new Error("unexpected refusal"); };
// Acquisition passes scanned key targets through unchanged; only identity matters here.
const key = (id: string) => ({ root_key: id }) as unknown as SourceIndexTarget;
/** A statement key bound to one host message span of its root. */
const auxKey = (id: string, start: number) => ({ root_key: id, auxiliary: { artifact_id: `art-${id}`, key_digest: `dig-${id}`,
  source_span: [start, start + 10] } }) as unknown as SourceIndexTarget;
const zero = { work: 0, memory_bytes: 0, native_bytes: 0, sql_internal_work: "unknown" } as const;
/** Witness facts per key id: [role, matched anchor names, key text]; unlisted keys are user keys matching every anchor. */
const witnesses = (facts: Record<string, [string | null, string[]?, string?]> = {}, session: string | null = null): StatementWitnessReader =>
  (_root, keys, anchors) => ({ status: "ready", resources: zero, session_time: session,
    inventory: { status: "captured", inventory: { contract: "host-occurrence-v1",
      issuer: { namespace: "test", workspace_id: "test", producer: "test", basis: "pinned_dataset" },
      occurrences: keys.flatMap(target => target.auxiliary === undefined ? [] : [{ occurrence_id: target.root_key,
        utf8_span: target.auxiliary.source_span, role: facts[target.root_key]?.[0] ?? "user", channel: null,
        author_ref: null, container_ref: null, upstream_message_ref: null, upstream_position: null,
        completeness: "complete", fidelity: "original_bytes" }]) } }, witnesses: keys.map(target => {
    const fact = facts[target.root_key];
    return { role: fact?.[0] ?? (fact === undefined ? "user" : null),
      anchors: anchors.map(anchor => fact === undefined || (fact[1] ?? []).includes(anchor)), statement: fact?.[2] ?? "" };
  }) });
/** coverage[root] lists one value per statement; omitted roots have no statement key. */
function coverage(statements: number, values: Record<string, (number | null)[]>, open?: Record<string, boolean[]>): StatementAssociation {
  return { roots, statements, coverage: roots.map(root => values[root] ?? Array<null>(statements).fill(null)),
    ...(open === undefined ? {} : { possible: roots.map(root => open[root] ?? Array<boolean>(statements).fill(false)) }),
    decision: { refused: null, applied: false } };
}

/** Independent oracle: for each condition in order whose top is outside the first five, try every slot 2-5
 * and keep the lexicographically best (tops present, conditions witnessed) strict improvement, lowest slot on ties. */
function declaredRule(order: readonly string[], value: StatementAssociation): string[] {
  const at = (root: string) => value.roots.indexOf(root);
  const score = (root: string, d: number) => at(root) < 0 ? null : value.coverage[at(root)]![d]!;
  const seen = (root: string, d: number) => score(root, d) !== null || at(root) >= 0 && value.possible?.[at(root)]![d] === true;
  const tops: (string | null)[] = [];
  for (let d = 0; d < value.statements; d++) {
    let best: string | null = null;
    for (const root of order) {
      const s = score(root, d);
      if (s !== null && (best === null || s > score(best, d)!)) best = root;
    }
    tops.push(best);
  }
  const rank = (first: string[]) => tops.filter(t => t !== null && first.includes(t)).length * 100
    + Array.from({ length: value.statements }, (_, d) => first.some(root => seen(root, d))).filter(Boolean).length;
  const first = order.slice(0, 5);
  for (const top of tops) {
    if (top === null || first.includes(top)) continue;
    let pick = -1, pickRank = rank(first);
    for (const slot of [4, 3, 2, 1]) {
      if (slot >= first.length) continue;
      const trial = [...first]; trial[slot] = top;
      if (rank(trial) > pickRank) { pick = slot; pickRank = rank(trial); }
    }
    if (pick >= 0) first[pick] = top;
  }
  return [...first, ...order.filter(root => !first.includes(root))];
}

describe("statement key retention and evidence coverage", () => {
  it("keeps the stable best sixteen keys per root and scores each statement by its best retained key", () => {
    const retained = new StatementKeyRetention(meter(), noRefusal, ready([1, 0], [0, 1]));
    // Seventeen keys: the lowest question cosine (0) is dropped even though it matches statement 1 exactly.
    for (let index = 0; index <= STATEMENT_ASSOCIATION_KEYS_PER_ROOT; index++) {
      retained.consider("a", index / 100, index === 0 ? Float32Array.of(0, 1) : Float32Array.of(1, 0.5), key(`a${index}`));
    }
    retained.consider("b", 0.5, Float32Array.of(-1, 1), key("b0"));
    const value = retained.associate(["b", "a", "c"], witnesses())!;
    expect(value.roots).toEqual(["b", "a", "c"]);
    expect(value.statements).toBe(2);
    expect(value.coverage[0]).toEqual([-Math.SQRT1_2, Math.SQRT1_2].map(v => expect.closeTo(v, 6)));
    expect(value.coverage[1]![0]).toBeCloseTo(1 / Math.sqrt(1.25), 6);
    expect(value.coverage[1]![1]).toBeCloseTo(0.5 / Math.sqrt(1.25), 6);
    expect(value.coverage[2]).toEqual([null, null]);
    expect(retained.availability()).toEqual({ status: "ready", reason: null, roots: 3, keys: 17 - 1 + 1, statements: 2 });
    expect(restrictStatementAssociation(value, root => root !== "b")).toEqual({ roots: ["a", "c"], statements: 2,
      coverage: [value.coverage[1], value.coverage[2]], openings: [value.openings![1], value.openings![2]], decision: value.decision });
  });

  it("drops keys without coverage when statements are absent or unprepared, and refuses incompatible demands", () => {
    for (const [demands, status] of [[{ status: "not_supplied", reason: "evidence_conditions_not_supplied" }, "not_requested"],
      [{ status: "unavailable", reason: "preparation_deadline" }, "unavailable"]] as const) {
      const retained = new StatementKeyRetention(meter(), noRefusal, demands);
      retained.consider("a", 1, Float32Array.of(1, 0), key("a0"));
      expect(retained.associate(["a"], witnesses())).toBeUndefined();
      expect(retained.availability()).toEqual({ status, reason: demands.reason, roots: 1, keys: 1 });
    }
    const refused: string[] = [], mismatch = new StatementKeyRetention(meter(), phase => refused.push(phase), ready([1, 0, 0]));
    mismatch.consider("a", 1, Float32Array.of(1, 0), key("a0"));
    expect(mismatch.associate(["a"], witnesses())).toBeUndefined();
    expect(refused).toEqual(["statement key association incompatible dimensions"]);
  });

  it("reports a funded refusal once, without returning partial coverage", () => {
    const ledger = meter(1e9, 10), refused: string[] = [];
    const retained = new StatementKeyRetention(ledger, phase => refused.push(phase), ready([1, 0]));
    retained.consider("a", 1, Float32Array.of(1, 0), key("a0"));
    retained.consider("b", 1, Float32Array.of(1, 0), key("b0"));
    expect(retained.associate(["a", "b"], witnesses())).toBeUndefined();
    expect(refused).toEqual(["statement key association retention"]);
  });

  it("protects actual scoring and retained coverage within the finalization reserve", () => {
    for (const statements of [1, 4]) {
      const budget = meter(), demands = ready(...Array.from({ length: statements }, () => Array<number>(32).fill(1)));
      const retained = new StatementKeyRetention(budget, noRefusal, demands);
      const identities = Array.from({ length: 16 }, (_, index) => `${index}:${"字".repeat(1024)}`);
      for (const root of identities) for (let index = 0; index < 16; index++) retained.consider(root, 1, new Float32Array(32).fill(1), key(`${root}:${index}`));
      const protection = retained.finalizationProtection(identities.length, identities.reduce((sum, root) => sum + root.length, 0));
      const work = budget.spentWork, bytes = budget.spentBytes;
      budget.retain(retained.associate(identities, witnesses())!);
      expect(budget.spentWork - work).toBeLessThanOrEqual(protection.work_units);
      expect(budget.spentBytes - bytes).toBeLessThanOrEqual(protection.memory_bytes);
    }
    const quoted = new SourceSemanticResourceLedger(quoteStatementAssociation(8, 40, 64));
    const capture = new StatementKeyRetention(quoted, noRefusal, { status: "not_supplied", reason: "none" });
    for (let i = 0; i < 40; i++) capture.consider(roots[i % 8]!, i / 40, new Float32Array(64).fill(1), key(`k${i}`));
    expect(quoted.remaining().work_units).toBeGreaterThanOrEqual(0);
  });

  it("scores a condition only over keys whose message has its speaker and, with anchors, one fully matched anchor", () => {
    const demands: EvidenceDemands = { status: "ready", vectors: [Float32Array.of(1, 0), Float32Array.of(1, 0), Float32Array.of(1, 0)],
      conditions: [condition("user fact"), condition("assistant fact", "assistant"), condition("named fact", "user", ["Rachel", "Miami"])] };
    const retained = new StatementKeyRetention(meter(), noRefusal, demands);
    retained.consider("a", 0.9, Float32Array.of(1, 0), key("a-user"));
    retained.consider("a", 0.8, Float32Array.of(1, 1), key("a-assistant"));
    retained.consider("b", 0.7, Float32Array.of(1, 0), key("b-miami"));
    retained.consider("c", 0.6, Float32Array.of(1, 0), key("c-null-role"));
    const value = retained.associate(["a", "b", "c"], witnesses({ "a-user": ["user"], "a-assistant": ["assistant", ["Rachel", "Miami"]],
      "b-miami": ["user", ["Miami"]], "c-null-role": [null, ["Rachel"]] }))!;
    expect(value.coverage[0]).toEqual([1, expect.closeTo(Math.SQRT1_2, 6), null]);
    expect(value.coverage[1]).toEqual([1, null, 1]);
    expect(value.coverage[2]).toEqual([null, null, null]);
  });

  it("adds the window as a time dimension: stated days decide, undated keys stay possible unless the session precedes it", () => {
    const window = evidenceWindow({ interpretation_clock: "2023-04-01T00:00:00.000Z", intervals: [
      { start: "2023-03-01", end: "2023-03-31" }, { start: "2023-05-01", end: "2023-05-31" }] })!;
    expect(window).toEqual({ intervals: [[Date.UTC(2023, 2, 1), Date.UTC(2023, 2, 31)]], earliest: Date.UTC(2023, 2, 1) });
    expect(evidenceWindow({ interpretation_clock: "2023-04-01T00:00:00.000Z", intervals: [{ start: "2023-05-01", end: "2023-05-31" }] }))
      .toBeUndefined();
    const run = (session: string | null, facts: Record<string, [string | null, string[]?, string?]>, keys: string[]) => {
      const retained = new StatementKeyRetention(meter(), noRefusal, ready([1, 0]));
      keys.forEach((id, i) => retained.consider("a", 1 - i / 10, Float32Array.of(1, i), key(id)));
      return retained.associate(["a", "z"], witnesses(facts, session), window)!;
    };
    // "last Saturday" said on 2023-03-06 is 2023-03-04: inside March, necessary with that key's cosine.
    const inside = run("2023-03-06T10:00:00.000Z", { k0: ["user", [], "Last Saturday I ran a 5K."], k1: ["user", [], "I like running."] }, ["k0", "k1"]);
    expect(inside.coverage).toEqual([[1], [null]]);
    expect(inside.possible).toEqual([[true], [true]]);
    // A stated day outside the window violates; an undated key after the window opens is possible.
    const outside = run("2023-04-20T10:00:00.000Z", { k0: ["user", [], "On April 2 I ran a 5K."], k1: ["user", [], "I like running."] }, ["k0", "k1"]);
    expect(outside.coverage).toEqual([[null], [null]]);
    expect(outside.possible).toEqual([[true], [true]]);
    // A session before the window bounds an undated report; an assistant key never witnesses a user condition.
    const before = run("2023-02-10T10:00:00.000Z", { k0: ["user", [], "I like running."], k1: ["assistant", [], "On March 3 you ran."] }, ["k0", "k1"]);
    expect(before.possible).toEqual([[false], [true]]);
    expect(run(null, { k0: ["user", [], "On April 2 I ran a 5K."] }, ["k0"]).possible).toEqual([[true], [true]]);
    // Without a window the matrix has no possible dimension and time is not read.
    const plain = new StatementKeyRetention(meter(), noRefusal, ready([1, 0]));
    plain.consider("a", 1, Float32Array.of(1, 0), key("k0"));
    expect(plain.associate(["a"], witnesses({ k0: ["user", [], "On April 2 I ran."] }, "2023-04-20T10:00:00.000Z"))).not.toHaveProperty("possible");
  });

  it("keeps each cell's witnessing host-message span only under a derived relation", () => {
    const fill = (demands: EvidenceDemands) => {
      const retained = new StatementKeyRetention(meter(), noRefusal, demands);
      retained.consider("a", 0.9, Float32Array.of(1, 0), auxKey("k0", 0));
      retained.consider("a", 0.8, Float32Array.of(0, 1), auxKey("k1", 20));
      retained.consider("b", 0.7, Float32Array.of(0, 1), key("k2"));
      return retained.associate(["a", "b", "z"], witnesses({ k1: ["assistant"] }))!;
    };
    // k1 is an assistant message: statement 1 (user) is witnessed only by k0 on root a.
    expect(fill({ ...ready([1, 0], [0, 1]) as Extract<EvidenceDemands, { status: "ready" }>, derived: true }).spans).toEqual([[[0, 10], [0, 10]], [null, null], [null, null]]);
    expect(fill(ready([1, 0], [0, 1]))).not.toHaveProperty("spans");
    // Every root opens at its necessary witness messages, with or without a derived relation.
    expect(fill(ready([1, 0], [0, 1])).openings).toEqual([{ statement: 0, span: [0, 10] }, null, null]);
    // Two conditions witnessed by two messages of one root: the opening covers both, the best condition names it.
    const both = new StatementKeyRetention(meter(), noRefusal, ready([1, 0], [0, 1]));
    both.consider("a", 0.9, Float32Array.of(1, 0), auxKey("k0", 0));
    both.consider("a", 0.8, Float32Array.of(0, 0.6), auxKey("k1", 20));
    expect(both.associate(["a"], witnesses({}))!.openings).toEqual([{ statement: 0, span: [0, 30] }]);
    // An assistant witness takes the prompt it answers; a root with no witness opens at its first message.
    const asked: EvidenceDemands = { status: "ready", vectors: [Float32Array.of(0, 1)], conditions: [condition("s0", "assistant")] };
    const reply = new StatementKeyRetention(meter(), noRefusal, asked);
    reply.consider("a", 0.9, Float32Array.of(1, 0), auxKey("k0", 0));
    reply.consider("a", 0.8, Float32Array.of(0, 1), auxKey("k1", 20));
    reply.consider("b", 0.7, Float32Array.of(0, 1), auxKey("k2", 40));
    reply.consider("b", 0.6, Float32Array.of(0, 1), auxKey("k3", 60));
    expect(reply.associate(["a", "b"], witnesses({ k1: ["assistant"] }))!.openings)
      .toEqual([{ statement: 0, span: [0, 30] }, { statement: null, span: [0, 50] }]);
    expect(bindEvidenceDemands([condition("s")], [{ vector: { status: "available", embedding: Float32Array.of(1),
      profile_id: "p", input_digest: sourceEmbeddingInputDigest("s") } as never }], { status: "available", profile_id: "p" } as never, "derived"))
      .toMatchObject({ status: "ready", derived: true });
  });

  it("leaves the whole association unavailable on an unknown or misaligned witness read", () => {
    const run = (reader: StatementWitnessReader | undefined) => {
      const refused: string[] = [], retained = new StatementKeyRetention(meter(), phase => refused.push(phase), ready([1, 0]));
      retained.consider("a", 1, Float32Array.of(1, 0), key("a0"));
      retained.consider("b", 1, Float32Array.of(1, 0), key("b0"));
      return { value: retained.associate(["a", "b"], reader), availability: retained.availability(), refused };
    };
    let calls = 0;
    const second: StatementWitnessReader = (root, keys, anchors) => ++calls === 1 ? witnesses()(root, keys, anchors)
      : { status: "unknown", reason: "statement_witness_message_binding", resources: zero };
    expect(run(second)).toEqual({ value: undefined, refused: [],
      availability: { status: "unavailable", reason: "statement_witness_message_binding" } });
    expect(run(undefined).availability).toEqual({ status: "unavailable", reason: "statement_witness_reader_absent" });
    expect(run(() => ({ status: "ready", session_time: null, inventory: { status: "unknown" }, witnesses: [], resources: zero })).availability.reason).toBe("statement_witness_misaligned");
    expect(run(() => ({ status: "unknown", reason: "statement_witness_read_budget:x", resources: zero })).refused)
      .toEqual(["statement_witness_read_budget:x"]);
  });

  it("binds prepared vectors only to the exact admitted texts and the query profile", () => {
    const vector = (text: string, profile_id = "p") => ({ vector: { status: "available" as const, profile: {} as never, profile_id,
      input_digest: sourceEmbeddingInputDigest(text), embedding: Float32Array.of(1) } });
    const query = { status: "available" as const, profile: {} as never, profile_id: "p", input_digest: "q", embedding: Float32Array.of(1) };
    const x = condition("x"), y = condition("y", "assistant", ["Y"]);
    expect(bindEvidenceDemands(undefined, [vector("x")], query)).toEqual({ status: "not_supplied", reason: "evidence_conditions_not_supplied" });
    expect(bindEvidenceDemands([x], undefined, query)).toEqual({ status: "unavailable", reason: "evidence_statement_preparation_absent" });
    expect(bindEvidenceDemands([x], [vector("y")], query)).toEqual({ status: "unavailable", reason: "evidence_statement_preparation_mismatch" });
    expect(bindEvidenceDemands([x], [vector("x", "other")], query).status).toBe("unavailable");
    expect(bindEvidenceDemands([x], [{ vector: { status: "unavailable", reason: "preparation_deadline" } }], query))
      .toEqual({ status: "unavailable", reason: "preparation_deadline" });
    expect(bindEvidenceDemands([x, y], [vector("x"), vector("y")], query)).toMatchObject({ status: "ready",
      vectors: [expect.any(Float32Array), expect.any(Float32Array)], conditions: [x, y] });
  });
});

describe("evidence coverage permutation of the source first five", () => {
  it("injects a late top root into the last non-serving slot and protects serving roots", () => {
    const value = coverage(3, { g: [0.9, 0.1, 0.1], d: [0.2, 0.2, 0.2], c: [0.1, 0.8, 0.1], h: [0.1, 0.1, 0.7] });
    const decided = selectEvidenceWitnesses(roots, value, meter());
    // c serves statement 1 and stays; e (slot 5) then d (slot 4) are replaced and follow in base order.
    expect(decided.order).toEqual(["a", "b", "c", "h", "g", "d", "e", "f"]);
    expect(decided.top_positions).toEqual([7, 3, 8]);
    expect(decided.injections).toEqual([{ statement: 0, root_position: 7, status: "injected", slot: 5 },
      { statement: 2, root_position: 8, status: "injected", slot: 4 }]);
  });

  it("keeps a condition's only witness in the first five and displaces roots no condition sees", () => {
    // g tops statement 0; e (slot 5) is statement 1's only witness, possible under the window; d witnesses nothing.
    const value = coverage(2, { g: [0.9, null], b: [null, null] }, { e: [false, true], b: [true, false] });
    expect(selectEvidenceWitnesses(roots, value, meter()).order).toEqual(["a", "b", "c", "g", "e", "d", "f", "h"]);
    // A root possible only for the condition whose top enters is not protected: the lowest slot goes.
    const single = coverage(1, { g: [0.9] }, { b: [true], c: [true], d: [true], e: [true] });
    expect(selectEvidenceWitnesses(roots, single, meter()).order).toEqual(["a", "b", "c", "d", "g", "e", "f", "h"]);
    // Replacing another condition's top never improves the pair, so a fully topped first five stays.
    const topped = coverage(2, { b: [0.9, null], c: [null, 0.9], g: [0.95, null] });
    expect(selectEvidenceWitnesses(roots, topped, meter()).order.slice(0, 5)).toEqual(["a", "b", "c", "d", "g"]);
  });

  it("keeps the order when every slot 2-5 serves, never moves slot 1 and breaks ties to the earlier position", () => {
    const full = coverage(4, { b: [0.9, 0, 0, 0], c: [0, 0.9, 0, 0], d: [0, 0, 0.9, 0], e: [0, 0, 0, 0.9] });
    expect(selectEvidenceWitnesses(roots, full, meter()).order).toEqual(roots);
    const saturated = coverage(4, { b: [0.9, 0, 0, 0], c: [0, 0.9, 0, 0], d: [0, 0, 0.9, 0], e: [0, 0, 0, 0.5], f: [0, 0, 0, 0.5],
      g: [0, 0, 0, 0.5] });
    expect(selectEvidenceWitnesses(roots, saturated, meter()).order).toEqual(roots);
    const firstServes = coverage(1, { a: [0.9], h: [0.5] });
    expect(selectEvidenceWitnesses(roots, firstServes, meter()).order).toEqual(roots);
    const tie = coverage(1, { g: [0.5], h: [0.5] });
    expect(selectEvidenceWitnesses(roots, tie, meter()).order).toEqual(["a", "b", "c", "d", "g", "e", "f", "h"]);
  });

  it("moves each placed top's rank 2-5 witnesses from outside the first five after it, as witness variants", () => {
    const span = (s: number) => [s, s + 10] as const;
    const value = { ...coverage(2, { b: [0.9, null], h: [0.8, 0.2], f: [0.7, null], c: [0.6, null], g: [0.5, null], e: [0.4, null], d: [null, 0.3] }),
      spans: roots.map((root, i) => root === "g" ? [null, null] : [span(10 * i), span(10 * i + 5)]) };
    const decided = selectEvidenceWitnesses(roots, value, meter());
    // Condition 0: top b; ranks 2-5 are h, f, c (in the first five), g (no span). Condition 1: top d; h is already moved.
    expect(decided.order).toEqual(["a", "b", "c", "d", "e", "h", "f", "g"]);
    expect(decided.variants).toEqual([
      { root: "h", statement: 0, root_position: 8, support_span: { start_byte: 70, end_byte: 80 } },
      { root: "f", statement: 0, root_position: 6, support_span: { start_byte: 50, end_byte: 60 } }]);
    expect(selectEvidenceWitnesses(roots, coverage(2, { b: [0.9, null], h: [0.8, 0.2] }), meter()).variants).toEqual([]);
  });

  it("matches the declared rule over generated coverage, keyless roots, ties and short orders", () => {
    let seed = 7;
    const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    for (let trial = 0; trial < 400; trial++) {
      const statements = 1 + Math.floor(random() * 4), length = 1 + Math.floor(random() * roots.length);
      const values: Record<string, (number | null)[]> = {}, open: Record<string, boolean[]> = {};
      for (const root of roots) if (random() > 0.2) {
        values[root] = Array.from({ length: statements }, () => random() < 0.4 ? null : Math.round(random() * 4) / 4);
        open[root] = Array.from({ length: statements }, () => random() < 0.3);
      }
      const value = coverage(statements, values, trial % 2 === 0 ? open : undefined);
      const order = [...roots].sort(() => random() - 0.5).slice(0, length);
      expect(selectEvidenceWitnesses(order, value, meter()).order).toEqual(declaredRule(order, value));
    }
  });
});

describe("field access with evidence coverage", () => {
  const occurrences = roots.map((root, i) => ({ reference: `o-${root}`, root_key: root, native_rank: i + 1 }));
  const memory = [{ reference: "memory", root_key: "m", native_rank: 1 }];
  const lanes: NativeRouteLane[] = ["original-lexical", "original-vector", "hint-lexical", "hint-vector"].map((lane, i) => ({
    lane: lane as NativeRouteLane["lane"], scope: "q",
    ...(i === 0 ? { state: "exact-captured" as const, occurrences } : { state: "measured-empty" as const }) }));
  const input = { lanes, memory: { lane: "memory-lexical" as const, scope: "q", state: "exact-captured" as const, occurrences: memory },
    pool: [...roots, "m"].map(record_id => ({ record_id, catalog_position: null })), acquired_root_keys: [...roots, "m"],
    associations: [...occurrences, ...memory].map(row => ({ occurrence_reference: row.reference, root_key: row.root_key, record_id: row.root_key })),
    unvisited_sources: true };
  const base = ["a", "m", "b", "c", "d", "e", "f", "g", "h"];

  it("is byte-identical without coverage and permutes source slots only, preserving memory positions", () => {
    expect(orderNativeFieldAccess(input, meter())).toEqual(orderNativeFieldAccess(input));
    expect(orderNativeFieldAccess(input)).toMatchObject({ status: "ordered", record_ids: base });
    const result = orderNativeFieldAccess({ ...input, association: coverage(1, { g: [0.9] }) }, meter());
    expect(result).toMatchObject({ status: "ordered", record_ids: ["a", "m", "b", "c", "d", "g", "e", "f", "h"],
      evidence_coverage: { status: "permuted", statements: 1, top_source_positions: [7],
        injections: [{ statement: 0, root_position: 7, status: "injected", slot: 5 }], reason: null } });
    const unchanged = orderNativeFieldAccess({ ...input, association: coverage(1, { b: [0.9] }) }, meter());
    expect(unchanged).toMatchObject({ record_ids: base, evidence_coverage: { status: "unchanged", injections: [] } });
  });

  it("places witness variants after the first five source slots and reports them", () => {
    const value = { ...coverage(1, { b: [0.9], h: [0.8] }), spans: roots.map((_, i) => [[i, i + 5] as const]) };
    const result = orderNativeFieldAccess({ ...input, association: value }, meter());
    expect(result).toMatchObject({ record_ids: ["a", "m", "b", "c", "d", "e", "h", "f", "g"],
      evidence_coverage: { status: "permuted", injections: [], variants: [{ statement: 0, root_position: 8 }] },
      evidence_variants: [{ root: "h", statement: 0, support_span: { start_byte: 7, end_byte: 12 } }] });
    expect(() => orderNativeFieldAccess({ ...input, association: { ...value, decision: { refused: null, applied: false },
      spans: roots.map(() => [[5, 5] as const]) } }, meter())).toThrow(/one byte range or null/u);
    const opened = { ...coverage(1, { b: [0.9] }), openings: roots.map((root, i) => root === "b" ? { statement: 0, span: [i, i + 4] as const } : null) };
    expect(orderNativeFieldAccess({ ...input, association: opened }, meter())).toMatchObject({
      evidence_openings: [{ root: "b", statement: 0, support_span: { start_byte: 1, end_byte: 5 } }] });
    const first = { ...opened, openings: roots.map((root, i) => root === "c" ? { statement: null, span: [0, i + 4] as const } : null) };
    const unit = orderNativeFieldAccess({ ...input, association: first }, meter()) as { evidence_openings: unknown[] };
    expect(unit.evidence_openings).toEqual([{ root: "c", support_span: { start_byte: 0, end_byte: 6 } }]);
    expect(() => orderNativeFieldAccess({ ...input, association: { ...opened, decision: { refused: null, applied: false },
      openings: roots.map(() => ({ statement: 3, span: [0, 4] as const })) } }, meter())).toThrow(/witness openings/u);
  });

  it("keeps base access and records refusal when the optional ordering is unfunded", () => {
    const value = coverage(1, { g: [0.9] });
    expect(orderNativeFieldAccess({ ...input, association: value }, meter(0))).toMatchObject({ status: "ordered", record_ids: base,
      evidence_coverage: { status: "resource_refused", top_source_positions: null, reason: "evidence statement coverage validation" } });
    // A refused permutation is not retried for free on a later, larger page.
    expect(orderNativeFieldAccess({ ...input, association: value }, meter())).toMatchObject({ record_ids: base,
      evidence_coverage: { status: "resource_refused" } });
  });

  it("refuses a smaller later budget instead of undoing an applied permutation", () => {
    const value = coverage(1, { g: [0.9] });
    const first = orderNativeFieldAccess({ ...input, association: value }, meter());
    expect(value.decision).toEqual({ refused: null, applied: true });
    expect(() => orderNativeFieldAccess({ ...input, association: value }, meter(0))).toThrow(/budget exhausted/u);
    expect(orderNativeFieldAccess({ ...input, association: value }, meter())).toEqual(first);
  });

  it("rejects malformed coverage rather than using fabricated data", () => {
    const value = coverage(2, { g: [0.9, 0.1] });
    (value.coverage as (number | null)[][])[6] = [0.9];
    expect(() => orderNativeFieldAccess({ ...input, association: value }, meter())).toThrow(/one finite value or null/u);
    expect(() => orderNativeFieldAccess({ ...input, association: { ...coverage(1, {}), statements: 5,
      coverage: roots.map(() => Array<null>(5).fill(null)) } }, meter())).toThrow(/one to four/u);
  });
});
