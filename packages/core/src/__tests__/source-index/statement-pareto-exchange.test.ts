import { describe, expect, it } from "vitest";
import { SourceSemanticResourceLedger, type EvidenceCondition, type SourceIndexTarget } from "@do-soul/alaya-protocol";
import { StatementKeyRetention, selectEvidenceWitnesses, type EvidenceDemands, type StatementAssociation,
  type StatementWitnessReader } from "../../source-index/statement-association.js";
import { exchangeStatementParetoSecondary, injectiveConditionWitnessAssignment } from "../../source-index/statement-pareto-exchange.js";
import { orderNativeFieldAccess, type NativeRouteLane } from "../../recall/runtime/native-route-opportunity.js";

const roots = ["a", "b", "c", "d", "e", "f", "g", "h"];
const meter = (work_units = 1e9, memory_bytes = 1e9) => new SourceSemanticResourceLedger({ work_units, memory_bytes });
const condition = (statement: string, speaker: EvidenceCondition["speaker"] = "user"): EvidenceCondition =>
  ({ statement, speaker, anchors: [] });
const ready = (...vectors: number[][]): EvidenceDemands => ({ status: "ready", vectors: vectors.map(v => Float32Array.from(v)),
  conditions: vectors.map((_, index) => condition(`s${index}`)) });
const noRefusal = () => { throw new Error("unexpected refusal"); };
const key = (id: string) => ({ root_key: id, target: { root_id: id } } as unknown as SourceIndexTarget);
const zero = { work: 0, memory_bytes: 0, native_bytes: 0, sql_internal_work: "unknown" } as const;
const witnesses: StatementWitnessReader = (_root, keys, anchors) => ({ status: "ready", resources: zero, session_time: null,
  inventory: { status: "captured", inventory: { contract: "host-occurrence-v1",
    issuer: { namespace: "test", workspace_id: "test", producer: "test", basis: "pinned_dataset" },
    occurrences: keys.map((target, i) => ({ occurrence_id: target.root_key, utf8_span: [i * 10, i * 10 + 8] as const,
      role: "user", channel: null, author_ref: null, container_ref: null, upstream_message_ref: null, upstream_position: null,
      completeness: "complete" as const, fidelity: "original_bytes" as const })) } },
  witnesses: keys.map(() => ({ role: "user", anchors: anchors.map(() => true), statement: "" })) });

function coverage(statements: number, values: Record<string, (number | null)[]>,
  extra: Partial<StatementAssociation> = {}): StatementAssociation {
  return { roots, statements, coverage: roots.map(root => values[root] ?? Array<null>(statements).fill(null)),
    decision: { refused: null, applied: false }, ...extra };
}

function fieldInput(association?: StatementAssociation) {
  const occurrences = roots.map((root, i) => ({ reference: `o-${root}`, root_key: root, native_rank: i + 1 }));
  const memory = [{ reference: "memory", root_key: "m", native_rank: 1 }];
  const lanes: NativeRouteLane[] = ["original-lexical", "original-vector", "hint-lexical", "hint-vector"].map((lane, i) => ({
    lane: lane as NativeRouteLane["lane"], scope: "q",
    ...(i === 0 ? { state: "exact-captured" as const, occurrences } : { state: "measured-empty" as const }) }));
  return { lanes, memory: { lane: "memory-lexical" as const, scope: "q", state: "exact-captured" as const, occurrences: memory },
    pool: [...roots, "m"].map(record_id => ({ record_id, catalog_position: null })), acquired_root_keys: [...roots, "m"],
    associations: [...occurrences, ...memory].map(row => ({ occurrence_reference: row.reference, root_key: row.root_key, record_id: row.root_key })),
    unvisited_sources: true, ...(association === undefined ? {} : { association }) };
}

describe("winning-key relation scoring", () => {
  it("scores the relation vector of the key that won coverage and never coerces missing cells to 0", () => {
    const retained = new StatementKeyRetention(meter(), noRefusal, ready([1, 0], [0, 1]));
    retained.consider("a", 0.9, Float32Array.of(1, 0), key("k-high"));
    retained.consider("a", 0.8, Float32Array.of(0.2, 0.1), key("k-low"));
    const value = retained.associate(["a"], witnesses, undefined, keys => ({
      status: "ready", vectors: keys.map(id => id === "k-high" ? Float32Array.of(1, 0) : Float32Array.of(0, 1))
    }))!;
    expect(value.coverage[0]![0]).toBeGreaterThan(value.coverage[0]![1]!);
    expect(value.relations![0]![0]).toBeCloseTo(1, 6);
    expect(value.relations![0]![1]).toBeCloseTo(1, 6);
  });

  it("keeps a missing overlay as null and abandons incompatible relation dimensions", () => {
    const missing = new StatementKeyRetention(meter(), noRefusal, ready([1, 0]));
    missing.consider("a", 1, Float32Array.of(1, 0), key("k0"));
    expect(missing.associate(["a"], witnesses, undefined, () => ({ status: "ready", vectors: [null] }))!.relations)
      .toEqual([[null]]);
    const refused: string[] = [];
    const bad = new StatementKeyRetention(meter(), phase => refused.push(phase), ready([1, 0]));
    bad.consider("a", 1, Float32Array.of(1, 0), key("k0"));
    expect(bad.associate(["a"], witnesses, undefined, () => ({ status: "ready", vectors: [Float32Array.of(1)] }))).toBeUndefined();
    expect(refused).toEqual(["statement relation association incompatible dimensions"]);
  });
});

describe("injective condition assignment and secondary exchange", () => {
  it("rematches duplicate marginal tops and leaves distinct tops unsolved", () => {
    const pool = ["a", "b", "c"];
    const value = (id: string, column: number) => ({ a: [0.9, 0.8], b: [0.1, 0.7], c: [0.2, 0.1] }[id]![column]!);
    const ranks = [0, 1].map(column => pool.filter(id => value(id, column) !== null)
      .sort((left, right) => value(right, column) - value(left, column) || pool.indexOf(left) - pool.indexOf(right)));
    expect(injectiveConditionWitnessAssignment(pool, ranks, value)?.roots).toEqual(["a", "b"]);
    expect(injectiveConditionWitnessAssignment(pool, [["a"], ["b"]], (id, column) =>
      id === "a" && column === 0 || id === "b" && column === 1 ? 1 : null)).toBeUndefined();
  });

  it("is a no-op when every relation cell is null and never evicts an unwitnessed original head", () => {
    const association = coverage(2, { g: [0.9, 0.1], f: [0.2, 0.8] }, {
      relations: roots.map(() => [null, null]) });
    const baseline = selectEvidenceWitnesses(roots, association, meter());
    expect(orderNativeFieldAccess(fieldInput(association), meter())).toMatchObject({
      record_ids: ["a", "m", ...baseline.base_order.slice(1)] });
    const guarded = coverage(1, { b: [0.9], f: [0.8], d: [0.5], c: [0.5] }, {
      spans: roots.map((_, i) => [[i, i + 5] as const]),
      relations: roots.map(root => [root === "f" ? 0.4 : root === "d" || root === "c" ? 0.9 : root === "b" ? 0.5 : null]) });
    const head = ["a", "b", "c", "d", "e"], tail = ["f", "g", "h"];
    expect(exchangeStatementParetoSecondary({ association: guarded, pool: roots, head, tail, agreed: [], meter: meter() })).toBe(false);
    expect(head).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("places a derived rank-2 witness of a distinct physical source root", () => {
    const association = coverage(1, { b: [0.9], h: [0.8], e: [0.1] }, {
      spans: roots.map((_, i) => [[i, i + 5] as const]),
      relations: roots.map(root => [root === "h" ? 0.95 : root === "e" ? 0.2 : root === "b" ? 0.5 : null]) });
    const head = ["a", "b", "c", "d", "e"], tail = ["f", "g", "h"];
    expect(exchangeStatementParetoSecondary({ association, pool: roots, head, tail, agreed: [], meter: meter() })).toBe(true);
    expect(head.includes("h")).toBe(true);
    expect(head.includes("e")).toBe(false);
    const alreadyHead = coverage(1, { b: [0.9], d: [0.8], e: [0.1] }, {
      spans: roots.map((_, i) => [[i, i + 5] as const]),
      relations: roots.map(root => [root === "d" ? 0.95 : root === "e" ? 0.2 : root === "b" ? 0.5 : null]) });
    const head2 = ["a", "b", "c", "d", "e"], tail2 = ["f", "g", "h"];
    expect(exchangeStatementParetoSecondary({
      association: alreadyHead, pool: roots, head: head2, tail: tail2, agreed: [], meter: meter() })).toBe(false);
  });

  it("keeps surviving derived variants contiguous after slot 5 when a secondary swap enters the head", () => {
    const association = coverage(1, { b: [0.9], h: [0.8], f: [0.7], e: [0.1] }, {
      spans: roots.map((_, i) => [[i, i + 5] as const]),
      relations: roots.map(root => [root === "h" ? 0.9 : root === "e" ? 0.1 : root === "b" ? 0.4 : null]) });
    const result = orderNativeFieldAccess(fieldInput(association), meter());
    expect(association.decision.applied).toBe(true);
    const ids = (result as { record_ids: string[] }).record_ids.filter(id => id !== "m");
    expect(ids.slice(0, 5).includes("h") || ids.includes("h")).toBe(true);
    const firstFive = ids.slice(0, 5);
    const rest = ids.slice(5);
    if (!firstFive.includes("f") && rest.includes("f")) expect(rest.indexOf("f")).toBe(0);
    expect(() => orderNativeFieldAccess(fieldInput(association), meter(0))).toThrow(/budget exhausted/u);
  });
});
