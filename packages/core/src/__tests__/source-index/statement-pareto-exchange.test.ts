import { describe, expect, it } from "vitest";
import { SourceSemanticResourceExhausted, SourceSemanticResourceLedger, type EvidenceCondition, type SourceIndexQueryCapacity,
  type SourceIndexTarget } from "@do-soul/alaya-protocol";
import { SourceIndexAcquisition } from "../../source-index/source-index-acquisition.js";
import { StatementKeyRetention, selectEvidenceWitnesses, quoteStatementAssociation, type EvidenceDemands, type StatementAssociation,
  type StatementWitnessReader } from "../../source-index/statement-association.js";
import { exchangeStatementParetoSecondary, injectiveConditionWitnessAssignment, quoteStatementParetoExchange } from "../../source-index/statement-pareto-exchange.js";
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
    const demand = Float32Array.of(1, 0);
    const retained = new StatementKeyRetention(meter(), noRefusal, ready([1, 0]));
    retained.consider("a", 0.85, Float32Array.of(0.85, Math.sqrt(1 - 0.85 ** 2)), key("k-a"));
    retained.consider("a", 0.60, Float32Array.of(0.60, 0.8), key("k-b"));
    const value = retained.associate(["a"], witnesses, undefined, keys => ({
      status: "ready", vectors: keys.map(id => id === "k-a"
        ? Float32Array.of(0.15, Math.sqrt(1 - 0.15 ** 2))
        : Float32Array.of(0.95, Math.sqrt(1 - 0.95 ** 2)))
    }))!;
    expect(value.coverage[0]![0]).toBeCloseTo(0.85, 5);
    expect(value.relations![0]![0]).toBeCloseTo(0.15, 5);
    expect(value.relations![0]![0]).not.toBeCloseTo(0.95, 5);
    expect(demand[0]).toBe(1);
  });

  it("keeps a missing overlay as null and abandons incompatible relation dimensions", () => {
    const missing = new StatementKeyRetention(meter(), noRefusal, ready([1, 0]));
    missing.consider("a", 1, Float32Array.of(1, 0), key("k0"));
    expect(missing.associate(["a"], witnesses, undefined, () => ({ status: "ready", vectors: [null] }))!.relations)
      .toBeUndefined();
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
    expect(exchangeStatementParetoSecondary({ association: guarded, pool: roots, head, tail, agreed: [], meter: meter() }))
      .toEqual({ executed: true, swapped: false });
    expect(head).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("places a derived rank-2 witness of a distinct physical source root", () => {
    const association = coverage(1, { b: [0.9], h: [0.8], e: [0.1] }, {
      spans: roots.map((_, i) => [[i, i + 5] as const]),
      relations: roots.map(root => [root === "h" ? 0.95 : root === "e" ? 0.2 : root === "b" ? 0.5 : null]) });
    const head = ["a", "b", "c", "d", "e"], tail = ["f", "g", "h"];
    expect(exchangeStatementParetoSecondary({ association, pool: roots, head, tail, agreed: [], meter: meter() }))
      .toEqual({ executed: true, swapped: true });
    expect(head.includes("h")).toBe(true);
    expect(head.includes("e")).toBe(false);
    const alreadyHead = coverage(1, { b: [0.9], d: [0.8], e: [0.1] }, {
      spans: roots.map((_, i) => [[i, i + 5] as const]),
      relations: roots.map(root => [root === "d" ? 0.95 : root === "e" ? 0.2 : root === "b" ? 0.5 : null]) });
    const head2 = ["a", "b", "c", "d", "e"], tail2 = ["f", "g", "h"];
    expect(exchangeStatementParetoSecondary({
      association: alreadyHead, pool: roots, head: head2, tail: tail2, agreed: [], meter: meter() }))
      .toEqual({ executed: true, swapped: false });
  });

  it("keeps surviving derived variants contiguous after slot 5 when a secondary swap enters the head", () => {
    const association = coverage(1, { b: [0.9], h: [0.8], f: [0.7], e: [0.1] }, {
      spans: roots.map((_, i) => [[i, i + 5] as const]),
      relations: roots.map(root => [root === "h" ? 0.9 : root === "e" ? 0.1 : root === "b" ? 0.4 : null]) });
    const result = orderNativeFieldAccess(fieldInput(association), meter());
    expect(association.decision.applied).toBe(true);
    const ids = (result as { record_ids: string[] }).record_ids.filter(id => id !== "m");
    expect(ids.slice(0, 5)).toContain("h");
    expect(ids[5]).toBe("f");
    expect(ids.indexOf("e")).toBeGreaterThan(5);
    expect(() => orderNativeFieldAccess(fieldInput(association), meter(0))).toThrow(/budget exhausted/u);
  });

  it("funds one Pareto exchange from the optional ledger without double-withholding", () => {
    const association = coverage(1, { g: [0.9] }, {
      relations: roots.map(root => [root === "g" ? 0.8 : null]) });
    const oneD = roots.length * (1 + 1) + roots.length * (1 + 2) + 4 * 1 * 1 * 5;
    const pareto = quoteStatementParetoExchange(roots.length, 1);
    const mandatory = { work_units: 12, memory_bytes: 0 };
    const ledger = meter(mandatory.work_units + oneD + pareto.work_units, 1e9);
    expect(() => orderNativeFieldAccess(fieldInput(association), ledger, mandatory)).not.toThrow();
    expect(association.decision.refused).toBeNull();
    expect(ledger.spentWork).toBe(oneD + pareto.work_units);
  });

  it("quotes at least the elementary steps of a 16-root 4-condition exchange", () => {
    const identities = Array.from({ length: 16 }, (_, index) => `r${index}`);
    const statements = 4;
    const association: StatementAssociation = {
      roots: identities, statements,
      coverage: identities.map(() => Array<number>(statements).fill(0.5)),
      relations: identities.map(() => Array<number>(statements).fill(0.5)),
      decision: { refused: null, applied: false }
    };
    const head = identities.slice(0, 5), tail = identities.slice(5);
    const ledger = meter();
    exchangeStatementParetoSecondary({
      association, pool: identities, head, tail, agreed: [], meter: ledger });
    const quote = quoteStatementParetoExchange(16, statements);
    const n = statements, roots = 16, masks = 1 << n;
    // Rank sort comparisons, DP transitions with n-step sourceEarlier plus n-slot copies,
    // and tryPlace tail dominance scans.
    const elementary = roots * n * roots + masks * n * roots * (2 * n) + 4 * n * n * roots;
    expect(quote.work_units).toBeGreaterThanOrEqual(elementary);
    expect(ledger.spentWork).toBe(quote.work_units);
    expect(quote.memory_bytes).toBeGreaterThanOrEqual(masks * n * roots * n);
  });

  it("matches no-overlay promotion on a 60-work-unit all-null overlay", () => {
    const none = coverage(1, { g: [0.9] });
    const allNull = coverage(1, { g: [0.9] }, {
      relations: roots.map(() => [null]) });
    const without = orderNativeFieldAccess(fieldInput(none), meter(60));
    const withNulls = orderNativeFieldAccess(fieldInput(allNull), meter(60));
    expect(withNulls).toMatchObject({ record_ids: (without as { record_ids: string[] }).record_ids });
    expect(allNull.decision.refused).toBeNull();
  });

  it("treats a funded witness opening as applied so an unfunded continuation cannot drop it", () => {
    const association = coverage(1, { b: [0.9] }, {
      openings: roots.map((root, i) => root === "b" ? { statement: 0, span: [i, i + 4] as const } : null) });
    const first = orderNativeFieldAccess(fieldInput(association), meter());
    expect(first).toMatchObject({
      record_ids: ["a", "m", "b", "c", "d", "e", "f", "g", "h"],
      evidence_openings: [{ root: "b", statement: 0, support_span: { start_byte: 1, end_byte: 5 } }] });
    expect(association.decision.applied).toBe(true);
    expect(() => orderNativeFieldAccess(fieldInput(association), meter(0))).toThrow(SourceSemanticResourceExhausted);
  });

  it("covers worst-case relation-populated association and navigation within quotes", () => {
    const identities = Array.from({ length: 16 }, (_, index) => `r${index}`);
    const dims = 384, statements = 4;
    const demands = ready(...Array.from({ length: statements }, () => Array<number>(dims).fill(1)));
    const budget = meter();
    const retained = new StatementKeyRetention(budget, noRefusal, demands);
    const embedding = new Float32Array(dims).fill(1);
    for (const root of identities) for (let index = 0; index < 16; index++) {
      retained.consider(root, 1, embedding, key(`${root}:${index}`));
    }
    const protection = retained.finalizationProtection(identities.length, identities.reduce((sum, root) => sum + root.length, 0));
    const work = budget.spentWork, bytes = budget.spentBytes;
    const value = retained.associate(identities, witnesses, undefined, keys => ({
      status: "ready" as const, vectors: keys.map(() => embedding)
    }))!;
    expect(budget.spentWork - work).toBeLessThanOrEqual(protection.work_units);
    expect(budget.spentBytes - bytes).toBeLessThanOrEqual(protection.memory_bytes);
    expect(value.relations).toBeDefined();
    const native: SourceIndexQueryCapacity = {
      budget: { work_units: 2_000_000, memory_bytes: 64 * 1024 * 1024 },
      resources: { work: 0, native_bytes: 0, memory_bytes: 0, sql_internal_work: "unknown" },
      vector_windows: 256, dimensions: dims, root_key_bytes: 8
    };
    const quoted = SourceIndexAcquisition.quoteAllowanceBudget({
      workspace_id: "workspace-1", navigation_text: "q",
      allowance: { max_attempts: 16, max_roots: 16, max_vector_windows: 256 },
      vector: { status: "unavailable", reason: "fixture" }
    }, native);
    expect(quoted.work_units).toBeGreaterThanOrEqual(protection.work_units);
    expect(quoted.work_units).toBeGreaterThanOrEqual(quoteStatementAssociation(16, 256, dims).work_units
      + quoteStatementParetoExchange(16, statements).work_units);
    const occurrences = identities.map((root, i) => ({ reference: `o-${root}`, root_key: root, native_rank: i + 1 }));
    const memory = [{ reference: "memory", root_key: "m", native_rank: 1 }];
    const lanes: NativeRouteLane[] = ["original-lexical", "original-vector", "hint-lexical", "hint-vector"].map((lane, i) => ({
      lane: lane as NativeRouteLane["lane"], scope: "q",
      ...(i === 0 ? { state: "exact-captured" as const, occurrences } : { state: "measured-empty" as const }) }));
    const navigation = new SourceSemanticResourceLedger(quoted);
    expect(() => orderNativeFieldAccess({
      lanes, memory: { lane: "memory-lexical", scope: "q", state: "exact-captured", occurrences: memory },
      pool: [...identities, "m"].map(record_id => ({ record_id, catalog_position: null })),
      acquired_root_keys: [...identities, "m"],
      associations: [...occurrences, ...memory].map(row => ({ occurrence_reference: row.reference, root_key: row.root_key, record_id: row.root_key })),
      unvisited_sources: true, association: value
    }, navigation)).not.toThrow();
  });

  it("latches a refused Pareto so continuation cannot flip or reject the funded 1D order", () => {
    const association = coverage(1, { b: [0.9], h: [0.8], e: [0.1] }, {
      spans: roots.map((_, i) => [[i, i + 5] as const]),
      relations: roots.map(root => [root === "h" ? 0.95 : root === "e" ? 0.2 : root === "b" ? 0.5 : null]) });
    const oneD = roots.length * (1 + 1) + roots.length * (1 + 2) + 4 * 1 * 1 * 5 + 1 * roots.length * 4;
    const page1 = orderNativeFieldAccess(fieldInput(association), meter(oneD));
    expect(association.decision.applied).toBe(true);
    expect(association.decision.pareto).toBe("refused");
    const page1Ids = (page1 as { record_ids: string[] }).record_ids;
    expect(() => orderNativeFieldAccess(fieldInput(association), meter(oneD))).not.toThrow();
    expect((orderNativeFieldAccess(fieldInput(association), meter(oneD)) as { record_ids: string[] }).record_ids)
      .toEqual(page1Ids);
    expect((orderNativeFieldAccess(fieldInput(association), meter(oneD * 10)) as { record_ids: string[] }).record_ids)
      .toEqual(page1Ids);
  });

  it("rejects a tighter continuation once Pareto has been applied", () => {
    const association = coverage(1, { b: [0.9], h: [0.8], e: [0.1] }, {
      spans: roots.map((_, i) => [[i, i + 5] as const]),
      relations: roots.map(root => [root === "h" ? 0.95 : root === "e" ? 0.2 : root === "b" ? 0.5 : null]) });
    const oneD = roots.length * (1 + 1) + roots.length * (1 + 2) + 4 * 1 * 1 * 5 + 1 * roots.length * 4;
    orderNativeFieldAccess(fieldInput(association), meter());
    expect(association.decision.pareto).toBe("applied");
    expect(() => orderNativeFieldAccess(fieldInput(association), meter(oneD))).toThrow(SourceSemanticResourceExhausted);
  });

  it("returns false without scanning when the positioned pool is empty", () => {
    let scanned = false;
    const relations = roots.map(() => new Proxy([0.5], {
      get(target, prop, receiver) {
        scanned = true;
        return Reflect.get(target, prop, receiver);
      }
    }));
    const association = coverage(1, { a: [0.9] }, { relations });
    expect(exchangeStatementParetoSecondary({
      association, pool: [], head: [], tail: [], agreed: [], meter: meter(0) }))
      .toEqual({ executed: false, swapped: false });
    expect(scanned).toBe(false);
  });

  it("leaves Pareto not_run when native field access has an empty positioned source pool", () => {
    const association = coverage(1, { a: [0.9] }, {
      relations: roots.map(() => [0.5]),
      decision: { refused: null, applied: false, pareto: "not_run" } });
    const memory = [{ reference: "memory", root_key: "m", native_rank: 1 }];
    const lanes: NativeRouteLane[] = ["original-lexical", "original-vector", "hint-lexical", "hint-vector"].map(lane => ({
      lane: lane as NativeRouteLane["lane"], scope: "q", state: "measured-empty" as const }));
    orderNativeFieldAccess({
      lanes,
      memory: { lane: "memory-lexical", scope: "q", state: "exact-captured", occurrences: memory },
      pool: [{ record_id: "m", catalog_position: null }],
      acquired_root_keys: ["m"],
      associations: [{ occurrence_reference: "memory", root_key: "m", record_id: "m" }],
      unvisited_sources: true, association
    }, meter());
    expect(association.decision.pareto).toBe("not_run");
  });

  it("charges the association-root quote before indexing a partial pool", () => {
    let indexed = false;
    const identities = new Proxy([...roots], {
      get(target, prop, receiver) {
        if (prop === "map") indexed = true;
        return Reflect.get(target, prop, receiver);
      }
    });
    const association: StatementAssociation = {
      roots: identities, statements: 1,
      coverage: roots.map(() => [0.5]),
      relations: roots.map(() => [0.5]),
      decision: { refused: null, applied: false }
    };
    const quote = quoteStatementParetoExchange(8, 1);
    expect(() => exchangeStatementParetoSecondary({
      association, pool: ["a", "b"], head: ["a", "b"], tail: [], agreed: [], meter: meter(0) }))
      .toThrow(SourceSemanticResourceExhausted);
    expect(indexed).toBe(false);
    const ledger = meter();
    exchangeStatementParetoSecondary({
      association, pool: ["a", "b"], head: ["a", "b"], tail: [], agreed: [], meter: ledger });
    expect(ledger.spentWork).toBe(quote.work_units);
  });
});
