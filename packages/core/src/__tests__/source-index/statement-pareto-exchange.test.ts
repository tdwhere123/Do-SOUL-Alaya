import { describe, expect, it } from "vitest";
import { SourceSemanticResourceExhausted, SourceSemanticResourceLedger, type EvidenceCondition, type SourceIndexQueryCapacity,
  type SourceIndexTarget } from "@do-soul/alaya-protocol";
import { SourceIndexAcquisition } from "../../source-index/source-index-acquisition.js";
import { StatementKeyRetention, selectEvidenceWitnesses, quoteStatementAssociation, type EvidenceDemands, type StatementAssociation,
  type StatementWitnessReader } from "../../source-index/statement-association.js";
import { exchangeStatementParetoSecondary, injectiveConditionWitnessAssignment,
  quoteStatementParetoExchange } from "../../source-index/statement-pareto-exchange.js";
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

  it("breaks equal-weight ties by earlier column-0 pool position", () => {
    const value = (id: string, column: number) => ({ a: [3, 4], b: [1, 0], c: [0, 2] }[id]?.[column] ?? null);
    const ranksFor = (ids: readonly string[]) => [0, 1].map(column => ids.filter(id => value(id, column) !== null)
      .sort((left, right) => value(right, column)! - value(left, column)! || ids.indexOf(left) - ids.indexOf(right)));
    const packedPool = ["a", "b", "c"];
    expect(injectiveConditionWitnessAssignment(packedPool, ranksFor(packedPool), value)?.roots).toEqual(["a", "c"]);
    const copiedPool = ["a", "b", "c", ...Array.from({ length: 1022 }, (_, index) => `z${index}`)];
    expect(injectiveConditionWitnessAssignment(copiedPool, ranksFor(copiedPool), value)?.roots).toEqual(["a", "c"]);
  });

  it("assigns a duplicated pool id to at most one condition", () => {
    const pool = ["r0", "r0", "r1"];
    const value = (id: string) => id === "r0" ? 1 : 0.1;
    const ranks = [0, 1].map(() => pool.filter(id => value(id) !== null)
      .sort((left, right) => value(right) - value(left) || pool.indexOf(left) - pool.indexOf(right)));
    const assigned = injectiveConditionWitnessAssignment(pool, ranks, (id) => value(id))?.roots ?? [];
    expect(assigned.filter(id => id === "r0")).toHaveLength(1);
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

  it("quotes a packed 16-root 4-condition exchange under 9,000 work units", () => {
    const identities = Array.from({ length: 16 }, (_, index) => `r${index}`);
    const statements = 4, value = () => 0.5;
    const ranks = Array.from({ length: statements }, () => identities);
    expect(injectiveConditionWitnessAssignment(identities, ranks, value)?.roots).toEqual(["r0", "r1", "r2", "r3"]);
    const copiedPool = [...identities, ...Array.from({ length: 1009 }, (_, index) => `z${index}`)];
    const copiedValue = (id: string) => id.startsWith("r") ? 0.5 : null;
    const copiedRanks = Array.from({ length: statements }, () => copiedPool.filter(id => copiedValue(id) !== null));
    expect(injectiveConditionWitnessAssignment(copiedPool, copiedRanks, copiedValue)?.roots)
      .toEqual(["r0", "r1", "r2", "r3"]);
    const association: StatementAssociation = {
      roots: identities, statements,
      coverage: identities.map(() => Array<number>(statements).fill(0.5)),
      relations: identities.map(() => Array<number>(statements).fill(0.5)),
      decision: { refused: null, applied: false }
    };
    const head = identities.slice(0, 5), tail = identities.slice(5);
    const quote = quoteStatementParetoExchange(16, statements);
    expect(quote.work_units).toBeLessThanOrEqual(6_000);
    expect(quote.memory_bytes).toBe(11_520);
    const packedBytes = 4 * 16 + 8 * 16 + 8 * 16 + 8 * statements;
    expect(packedBytes).toBeLessThan(quote.memory_bytes);
    const ledger = meter(quote.work_units, quote.memory_bytes);
    expect(exchangeStatementParetoSecondary({
      association, pool: identities, head, tail, agreed: [], meter: ledger }).executed).toBe(true);
    expect(ledger.spentWork).toBe(quote.work_units);
    expect(ledger.spentBytes).toBe(quote.memory_bytes);
  });

  it("funds a copied 1025-root 4-condition exchange from its quote", () => {
    const identities = Array.from({ length: 1025 }, (_, index) => `r${index}`);
    const statements = 4;
    const association: StatementAssociation = {
      roots: identities, statements,
      coverage: identities.map(() => Array<number>(statements).fill(0.5)),
      relations: identities.map(() => Array<number>(statements).fill(0.5)),
      decision: { refused: null, applied: false }
    };
    const head = identities.slice(0, 5), tail = identities.slice(5);
    const quote = quoteStatementParetoExchange(1025, statements);
    const ledger = meter(quote.work_units, quote.memory_bytes);
    expect(exchangeStatementParetoSecondary({
      association, pool: identities, head, tail, agreed: [], meter: ledger }).executed).toBe(true);
    expect(ledger.spentWork).toBe(quote.work_units);
    expect(ledger.spentBytes).toBe(quote.memory_bytes);
  });

  it("quotes a base container for one root and one condition", () => {
    const quote = quoteStatementParetoExchange(1, 1);
    expect(quote.memory_bytes).toBeGreaterThanOrEqual(512);
    expect(quote.work_units).toBeGreaterThan(0);
    const association: StatementAssociation = {
      roots: ["a"], statements: 1, coverage: [[0.5]], relations: [[0.5]],
      decision: { refused: null, applied: false }
    };
    const head = ["a"], tail: string[] = [];
    const ledger = meter();
    expect(exchangeStatementParetoSecondary({
      association, pool: ["a"], head, tail, agreed: [], meter: ledger }).executed).toBe(true);
  });

  it("abstains without quoting when more than five conditions are present", () => {
    const identities = Array.from({ length: 16 }, (_, index) => `r${index}`);
    let allocated = false;
    const roots = new Proxy(identities, {
      get(target, prop, receiver) {
        if (prop === "map") allocated = true;
        return Reflect.get(target, prop, receiver);
      }
    });
    const association: StatementAssociation = {
      roots, statements: 1000,
      coverage: identities.map(() => Array<number>(1000).fill(0.5)),
      relations: identities.map(() => Array<number>(1000).fill(0.5)),
      decision: { refused: null, applied: false }
    };
    expect(quoteStatementParetoExchange(16, 1000)).toEqual({ work_units: 0, memory_bytes: 0 });
    expect(exchangeStatementParetoSecondary({
      association, pool: identities, head: identities.slice(0, 5), tail: identities.slice(5),
      agreed: [], meter: meter(0) })).toEqual({ executed: false, swapped: false });
    expect(allocated).toBe(false);
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

  it("preserves identical head and tail under strictly increasing per-column score transforms", () => {
    const rawValues: Record<string, (number | null)[]> = {
      a: [0.90, 0.50, null, null],
      b: [0.20, null, null, null],
      c: [null, null, 0.80, null],
      d: [null, null, 0.60, 0.85],
      e: [0.10, 0.10, null, null],
      f: [0.15, 0.45, null, null],
      g: [0.89, 0.15, null, null],
      h: [null, null, 0.40, null]
    };
    const transforms = [
      (s: number) => Math.exp(5 * s),
      (r: number) => Math.exp(3 * r + 0.5),
      (x: number) => 10 * x + 1,
      (y: number) => y ** 3
    ];
    const scaleValues = (values: Record<string, (number | null)[]>) =>
      Object.fromEntries(Object.entries(values).map(([root, row]) => [
        root, row.map((value, column) => value === null ? null : transforms[column]!(value))
      ]));
    const scaledValues = scaleValues(rawValues);
    const ranksFor = (values: Record<string, (number | null)[]>) => [0, 1, 2, 3].map(column =>
      roots.filter(root => values[root]![column] !== null)
        .sort((left, right) => values[right]![column]! - values[left]![column]! || roots.indexOf(left) - roots.indexOf(right))
    );
    // Confirm raw-cosine summing would flip the assignment under the monotone transforms.
    expect(injectiveConditionWitnessAssignment(roots, ranksFor(rawValues), (id, col) => rawValues[id]![col]!)?.roots)
      .toEqual(["g", "a", "c", "d"]);
    expect(injectiveConditionWitnessAssignment(roots, ranksFor(scaledValues), (id, col) => scaledValues[id]![col]!)?.roots)
      .toEqual(["a", "f", "c", "d"]);

    const spans = roots.map((_, i) => Array.from({ length: 4 }, (_, d) => [i * 10 + d, i * 10 + d + 5] as const));
    const relations = roots.map(root => {
      if (root === "e") return [0.1, 0.1, null, null];
      if (root === "f") return [0.8, 0.9, null, null];
      if (root === "g") return [0.9, 0.8, null, null];
      if (root === "b") return [0.99, null, null, null];
      if (root === "h") return [null, null, 0.9, null];
      return [0.5, 0.5, 0.5, 0.5];
    });
    const baseHead = ["a", "b", "c", "d", "e"], baseTail = ["f", "g", "h"];
    const scaledHead = ["a", "b", "c", "d", "e"], scaledTail = ["f", "g", "h"];
    expect(exchangeStatementParetoSecondary({
      association: coverage(4, rawValues, { relations, spans }),
      pool: roots, head: baseHead, tail: baseTail, agreed: [], meter: meter()
    })).toEqual({ executed: true, swapped: true });
    expect(exchangeStatementParetoSecondary({
      association: coverage(4, scaledValues, { relations, spans }),
      pool: roots, head: scaledHead, tail: scaledTail, agreed: [], meter: meter()
    })).toEqual({ executed: true, swapped: true });
    expect(scaledHead).toEqual(baseHead);
    expect(scaledTail).toEqual(baseTail);
    expect(baseHead).toContain("g");
    expect(baseHead).not.toContain("f");

    // Also confirm Stage-2b Pass 2 + U_min veto remains 100% invariant under per-column exp(...) transforms.
    const vetoPass2Raw: Record<string, (number | null)[]> = {
      a: [0.95, null, 0.70],
      b: [null, 0.95, null],
      c: [0.20, null, null],
      d: [0.30, null, null],
      e: [null, null, 0.95],
      f: [null, null, null],
      g: [0.80, null, null],
      h: [null, null, 0.40]
    };
    const vetoPass2Scaled = scaleValues(vetoPass2Raw);
    const vetoSpans = roots.map((_, i) => Array.from({ length: 3 }, (_, d) => [i * 10 + d, i * 10 + d + 5] as const));
    const vetoRel = roots.map(root => {
      if (root === "c") return [0.99, null, null];
      if (root === "d") return [0.10, null, null];
      return [0.5, 0.5, 0.5];
    });
    const vetoHead1 = ["a", "b", "c", "d", "e"], vetoTail1 = ["f", "g", "h"];
    const vetoHead2 = ["a", "b", "c", "d", "e"], vetoTail2 = ["f", "g", "h"];
    expect(exchangeStatementParetoSecondary({
      association: coverage(3, vetoPass2Raw, { relations: vetoRel, spans: vetoSpans }),
      pool: roots, head: vetoHead1, tail: vetoTail1, agreed: [], meter: meter()
    })).toEqual({ executed: true, swapped: false });
    expect(exchangeStatementParetoSecondary({
      association: coverage(3, vetoPass2Scaled, { relations: vetoRel, spans: vetoSpans }),
      pool: roots, head: vetoHead2, tail: vetoTail2, agreed: [], meter: meter()
    })).toEqual({ executed: true, swapped: false });
    expect(vetoHead2).toEqual(vetoHead1);
    expect(vetoTail2).toEqual(vetoTail1);
  });

  it("vetoes Stage-2b eviction of a dominated occupant when a weaker-coverage peer has the same masks", () => {
    const association = coverage(2, {
      a: [0.95, null],
      b: [null, 0.95],
      c: [0.20, null],
      d: [0.30, null],
      g: [0.80, null]
    }, {
      spans: roots.map((_, i) => [[i, i + 5] as const, [i + 10, i + 15] as const]),
      relations: roots.map(root => root === "c" ? [0.99, null]
        : root === "d" ? [0.10, null]
        : root === "g" ? [0.50, null]
        : [0.5, 0.5])
    });
    const head = ["a", "b", "c", "d", "e"], tail = ["f", "g", "h"];
    expect(exchangeStatementParetoSecondary({ association, pool: roots, head, tail, agreed: [], meter: meter() }))
      .toEqual({ executed: true, swapped: false });
    expect(head).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("runs breadth-first Pass 1 rank-2 derived witnesses before Pass 2 fallback tail witnesses", () => {
    const association = coverage(2, {
      a: [0.95, null],
      b: [0.85, 0.95],
      e: [0.10, 0.10],
      f: [0.75, null],
      g: [null, 0.80]
    }, {
      spans: roots.map((_, i) => [[i, i + 5] as const, [i + 10, i + 15] as const]),
      relations: roots.map(root => root === "e" ? [0.1, 0.1] : [0.9, 0.9])
    });
    // Only slot 4 (e) is replaceable; Col 0's ranked[1] (b) is already in head, so Pass 1 places Col 1's g first.
    const head = ["a", "b", "c", "d", "e"], tail = ["f", "g", "h"];
    expect(exchangeStatementParetoSecondary({ association, pool: roots, head, tail, agreed: [], meter: meter() }))
      .toEqual({ executed: true, swapped: true });
    expect(head).toEqual(["a", "b", "c", "d", "g"]);
    expect(tail).toContain("f");

    // When a second replaceable slot (d) is also available, Pass 2 promotes Col 0's first unplaced tail witness (f).
    const twoSlots = coverage(2, {
      a: [0.95, null],
      b: [0.85, 0.95],
      d: [0.12, null],
      e: [null, 0.10],
      f: [0.75, null],
      g: [null, 0.80]
    }, {
      spans: roots.map((_, i) => [[i, i + 5] as const, [i + 10, i + 15] as const]),
      relations: roots.map(root => root === "d" || root === "e" ? [0.1, 0.1] : [0.9, 0.9])
    });
    const head2 = ["a", "b", "c", "d", "e"], tail2 = ["f", "g", "h"];
    expect(exchangeStatementParetoSecondary({ association: twoSlots, pool: roots, head: head2, tail: tail2, agreed: [], meter: meter() }))
      .toEqual({ executed: true, swapped: true });
    expect(head2).toEqual(["a", "b", "c", "f", "g"]);
  });

  it("protects a placed derived rank-2 witness from eviction by a later derived column", () => {
    const association = coverage(2, {
      a: [0.95, null],
      b: [null, 0.95],
      e: [0.10, 0.10],
      f: [0.90, null],
      g: [0.80, null],
      h: [null, 0.80]
    }, {
      spans: roots.map((_, i) => [[i, i + 5] as const, [i + 10, i + 15] as const]),
      relations: roots.map(root => root === "e" ? [0.1, 0.1]
        : root === "g" ? [0.5, null]
        : root === "f" ? [0.95, null]
        : root === "h" ? [null, 0.95]
        : [0.5, 0.5])
    });
    const pool = ["a", "b", "c", "d", "e", "g", "h"];
    const head = ["a", "b", "c", "d", "e"], tail = ["f", "g", "h"];
    expect(exchangeStatementParetoSecondary({ association, pool, head, tail, agreed: [], meter: meter() }))
      .toEqual({ executed: true, swapped: true });
    expect(head).toEqual(["a", "b", "c", "d", "g"]);
    expect(tail).toContain("h");
  });

  it("breaks exact rational 12/5 === 12/5 quantile ties without IEEE-754 float sum drift", () => {
    const tiePool = ["x", "a", "b", "c", "d", "e"];
    const tieCoverage: Record<string, (number | null)[]> = {
      x: [null, null, null],
      a: [0.90, 0.90, 0.90],
      c: [0.80, 0.80, 0.80],
      d: [0.60, 0.70, 0.70],
      e: [0.50, 0.50, 0.50],
      b: [0.70, 0.60, 0.60]
    };
    const tieRanks = [0, 1, 2].map(col => tiePool.filter(id => tieCoverage[id]![col] !== null)
      .sort((left, right) => tieCoverage[right]![col]! - tieCoverage[left]![col]!));
    expect(tieRanks.map(row => row.join(""))).toEqual(["acbde", "acdbe", "acdbe"]);
    // Unscaled binary64 sums ((1 + 3/5) + 4/5 = 2.4000000000000004 vs (1 + 4/5) + 3/5 = 2.4) flip to ["b", "a", "c"].
    const rawFloatQuantile = (id: string, col: number) => {
      const rank = tieRanks[col]!.indexOf(id);
      return rank < 0 ? null : (tieRanks[col]!.length - rank) / tieRanks[col]!.length;
    };
    expect(injectiveConditionWitnessAssignment(tiePool, tieRanks, rawFloatQuantile)?.roots).toEqual(["b", "a", "c"]);

    const association: StatementAssociation = {
      roots: tiePool, statements: 3,
      coverage: tiePool.map(id => tieCoverage[id]!),
      relations: tiePool.map(id => id === "e" ? [0.1, 0.1, 0.1] : [0.9, 0.9, 0.9]),
      decision: { refused: null, applied: false }
    };
    const head = ["x", "a", "c", "d", "e"], tail = ["b"];
    expect(exchangeStatementParetoSecondary({ association, pool: tiePool, head, tail, agreed: [], meter: meter() }))
      .toEqual({ executed: true, swapped: false });
    expect(head).toEqual(["x", "a", "c", "d", "e"]);
  });

  it("deduplicates repeated pool IDs preserving first-seen order", () => {
    const association = coverage(2, {
      a: [0.95, null],
      b: [null, 0.95],
      e: [0.10, 0.10],
      g: [0.80, null],
      h: [null, 0.80]
    }, {
      spans: roots.map((_, i) => [[i, i + 5] as const, [i + 10, i + 15] as const]),
      relations: roots.map(root => root === "e" ? [0.1, 0.1] : [0.9, 0.9])
    });
    const cleanHead = ["a", "b", "c", "d", "e"], cleanTail = ["f", "g", "h"];
    const dupHead = ["a", "b", "c", "d", "e"], dupTail = ["f", "g", "h"];
    expect(exchangeStatementParetoSecondary({ association, pool: roots, head: cleanHead, tail: cleanTail, agreed: [], meter: meter() }))
      .toEqual({ executed: true, swapped: true });
    expect(exchangeStatementParetoSecondary({
      association, pool: ["a", "a", "a", ...roots, "g", "g"], head: dupHead, tail: dupTail, agreed: [], meter: meter()
    })).toEqual({ executed: true, swapped: true });
    expect(dupHead).toEqual(cleanHead);
    expect(dupTail).toEqual(cleanTail);
  });

  it("abstains without charging the meter when head exceeds five slots", () => {
    const association = coverage(1, { a: [0.9], g: [0.8], f: [0.1] }, {
      relations: roots.map(() => [0.5])
    });
    const head = ["a", "b", "c", "d", "e", "f"], tail = ["g", "h"];
    const ledger = meter(0);
    expect(exchangeStatementParetoSecondary({ association, pool: roots, head, tail, agreed: [], meter: ledger }))
      .toEqual({ executed: false, swapped: false });
    expect(head).toEqual(["a", "b", "c", "d", "e", "f"]);
  });

  it.each([
    [5, 1], [16, 1], [128, 1], [1025, 1],
    [5, 4], [16, 4], [128, 4], [1025, 4]
  ])("bounds elementary array reads at R=%i, n=%i within quoteStatementParetoExchange(R, n).work_units", (R, n) => {
    const ids = Array.from({ length: R }, (_, index) => `r${index}`);
    let reads = 0;
    const watchRow = (row: (number | null)[]) => new Proxy(row, {
      get(target, prop, receiver) {
        if (typeof prop === "string" && /^\d+$/.test(prop)) reads++;
        return Reflect.get(target, prop, receiver);
      }
    });
    const covRows = ids.map((_, index) => watchRow(Array.from({ length: n }, (_, d) =>
      index === 0 ? 0.95 : index === 1 ? 0.10 : index <= 4 ? 0.20 + index * 0.05 - d * 0.01 : index === 5 + d ? 0.88 : 0.70
    )));
    const relRows = ids.map((_, index) => watchRow(Array.from({ length: n }, () =>
      index === 1 ? 0.99 : index <= 4 ? 0.10 : 0.80
    )));
    const association: StatementAssociation = {
      roots: ids, statements: n,
      coverage: covRows,
      relations: relRows,
      spans: ids.map((_, index) => Array.from({ length: n }, (_, d) => [index + d, index + d + 4] as const)),
      decision: { refused: null, applied: false }
    };
    const quote = quoteStatementParetoExchange(R, n);
    const ledger = meter(quote.work_units, quote.memory_bytes);
    const head = ids.slice(0, 5), tail = ids.slice(5);
    expect(exchangeStatementParetoSecondary({ association, pool: ids, head, tail, agreed: [], meter: ledger }).executed).toBe(true);
    expect(reads).toBeLessThanOrEqual(quote.work_units);
  });
});
