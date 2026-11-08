import { describe, expect, it } from "vitest";
import { SourceSemanticResourceLedger } from "@do-soul/alaya-protocol";
import { bindEvidenceDemands, preferEvidenceCoverage, quoteStatementAssociation, restrictStatementAssociation,
  StatementKeyRetention, STATEMENT_ASSOCIATION_KEYS_PER_ROOT, type EvidenceDemands,
  type StatementAssociation } from "../../source-index/statement-association.js";
import { orderNativeFieldAccess, type NativeRouteLane } from "../../recall/runtime/native-route-opportunity.js";
import { sourceEmbeddingInputDigest } from "../../embedding-recall/source-embedding-runtime.js";

const roots = ["a", "b", "c", "d", "e", "f", "g", "h"];
const meter = (work_units = 1e9, memory_bytes = 1e9) => new SourceSemanticResourceLedger({ work_units, memory_bytes });
const ready = (...vectors: number[][]): EvidenceDemands => ({ status: "ready", vectors: vectors.map(v => Float32Array.from(v)) });
const noRefusal = () => { throw new Error("unexpected refusal"); };
/** coverage[root] lists one value per statement; omitted roots have no statement key. */
function coverage(statements: number, values: Record<string, (number | null)[]>): StatementAssociation {
  return { roots, statements, coverage: roots.map(root => values[root] ?? Array<null>(statements).fill(null)),
    decision: { refused: null, applied: false } };
}

/** Independent statement of the declared rule over root indices, used as an oracle. */
function declaredRule(order: readonly string[], value: StatementAssociation): string[] {
  const score = (root: string, d: number) => value.coverage[value.roots.indexOf(root)]?.[d] ?? null;
  const tops: (string | null)[] = [];
  for (let d = 0; d < value.statements; d++) {
    let best: string | null = null;
    for (const root of order) {
      const s = score(root, d);
      if (s !== null && (best === null || s > score(best, d)!)) best = root;
    }
    tops.push(best);
  }
  const out = [...order];
  for (const top of tops) {
    if (top === null || out.slice(0, 5).includes(top)) continue;
    const slot = [4, 3, 2, 1].find(p => p < out.length && !tops.includes(out[p]!));
    if (slot === undefined) continue;
    out[slot] = top;
  }
  const first = out.slice(0, 5);
  return [...first, ...order.filter(root => !first.includes(root))];
}

describe("statement key retention and evidence coverage", () => {
  it("keeps the stable best sixteen keys per root and scores each statement by its best retained key", () => {
    const retained = new StatementKeyRetention(meter(), noRefusal, ready([1, 0], [0, 1]));
    // Seventeen keys: the lowest question cosine (0) is dropped even though it matches statement 1 exactly.
    for (let key = 0; key <= STATEMENT_ASSOCIATION_KEYS_PER_ROOT; key++) {
      retained.consider("a", key / 100, key === 0 ? Float32Array.of(0, 1) : Float32Array.of(1, 0.5));
    }
    retained.consider("b", 0.5, Float32Array.of(-1, 1));
    const value = retained.associate(["b", "a", "c"])!;
    expect(value.roots).toEqual(["b", "a", "c"]);
    expect(value.statements).toBe(2);
    expect(value.coverage[0]).toEqual([-Math.SQRT1_2, Math.SQRT1_2].map(v => expect.closeTo(v, 6)));
    expect(value.coverage[1]![0]).toBeCloseTo(1 / Math.sqrt(1.25), 6);
    expect(value.coverage[1]![1]).toBeCloseTo(0.5 / Math.sqrt(1.25), 6);
    expect(value.coverage[2]).toEqual([null, null]);
    expect(retained.availability()).toEqual({ status: "ready", reason: null, roots: 3, keys: 17 - 1 + 1, statements: 2 });
    expect(restrictStatementAssociation(value, root => root !== "b")).toEqual({ roots: ["a", "c"], statements: 2,
      coverage: [value.coverage[1], value.coverage[2]], decision: value.decision });
  });

  it("drops keys without coverage when statements are absent or unprepared, and refuses incompatible demands", () => {
    for (const [demands, status] of [[{ status: "not_supplied", reason: "evidence_statements_not_supplied" }, "not_requested"],
      [{ status: "unavailable", reason: "preparation_deadline" }, "unavailable"]] as const) {
      const retained = new StatementKeyRetention(meter(), noRefusal, demands);
      retained.consider("a", 1, Float32Array.of(1, 0));
      expect(retained.associate(["a"])).toBeUndefined();
      expect(retained.availability()).toEqual({ status, reason: demands.reason, roots: 1, keys: 1 });
    }
    const refused: string[] = [], mismatch = new StatementKeyRetention(meter(), phase => refused.push(phase), ready([1, 0, 0]));
    mismatch.consider("a", 1, Float32Array.of(1, 0));
    expect(mismatch.associate(["a"])).toBeUndefined();
    expect(refused).toEqual(["statement key association incompatible dimensions"]);
  });

  it("reports a funded refusal once, without returning partial coverage", () => {
    const ledger = meter(1e9, 10), refused: string[] = [];
    const retained = new StatementKeyRetention(ledger, phase => refused.push(phase), ready([1, 0]));
    retained.consider("a", 1, Float32Array.of(1, 0));
    retained.consider("b", 1, Float32Array.of(1, 0));
    expect(retained.associate(["a", "b"])).toBeUndefined();
    expect(refused).toEqual(["statement key association retention"]);
  });

  it("protects actual scoring and retained coverage within the finalization reserve", () => {
    for (const statements of [1, 4]) {
      const budget = meter(), demands = ready(...Array.from({ length: statements }, () => Array<number>(32).fill(1)));
      const retained = new StatementKeyRetention(budget, noRefusal, demands);
      const identities = Array.from({ length: 16 }, (_, index) => `${index}:${"字".repeat(1024)}`);
      for (const root of identities) for (let key = 0; key < 16; key++) retained.consider(root, 1, new Float32Array(32).fill(1));
      const protection = retained.finalizationProtection(identities.length, identities.reduce((sum, root) => sum + root.length, 0));
      const work = budget.spentWork, bytes = budget.spentBytes;
      budget.retain(retained.associate(identities)!);
      expect(budget.spentWork - work).toBeLessThanOrEqual(protection.work_units);
      expect(budget.spentBytes - bytes).toBeLessThanOrEqual(protection.memory_bytes);
    }
    const quoted = new SourceSemanticResourceLedger(quoteStatementAssociation(8, 40, 64));
    const capture = new StatementKeyRetention(quoted, noRefusal, { status: "not_supplied", reason: "none" });
    for (let i = 0; i < 40; i++) capture.consider(roots[i % 8]!, i / 40, new Float32Array(64).fill(1));
    expect(quoted.remaining().work_units).toBeGreaterThanOrEqual(0);
  });

  it("binds prepared vectors only to the exact admitted texts and the query profile", () => {
    const vector = (text: string, profile_id = "p") => ({ vector: { status: "available" as const, profile: {} as never, profile_id,
      input_digest: sourceEmbeddingInputDigest(text), embedding: Float32Array.of(1) } });
    const query = { status: "available" as const, profile: {} as never, profile_id: "p", input_digest: "q", embedding: Float32Array.of(1) };
    expect(bindEvidenceDemands(undefined, [vector("x")], query)).toEqual({ status: "not_supplied", reason: "evidence_statements_not_supplied" });
    expect(bindEvidenceDemands(["x"], undefined, query)).toEqual({ status: "unavailable", reason: "evidence_statement_preparation_absent" });
    expect(bindEvidenceDemands(["x"], [vector("y")], query)).toEqual({ status: "unavailable", reason: "evidence_statement_preparation_mismatch" });
    expect(bindEvidenceDemands(["x"], [vector("x", "other")], query).status).toBe("unavailable");
    expect(bindEvidenceDemands(["x"], [{ vector: { status: "unavailable", reason: "preparation_deadline" } }], query))
      .toEqual({ status: "unavailable", reason: "preparation_deadline" });
    expect(bindEvidenceDemands(["x", "y"], [vector("x"), vector("y")], query)).toMatchObject({ status: "ready", vectors: [expect.any(Float32Array), expect.any(Float32Array)] });
  });
});

describe("evidence coverage permutation of the source first five", () => {
  it("injects a late top root into the last non-serving slot and protects serving roots", () => {
    const value = coverage(3, { g: [0.9, 0.1, 0.1], d: [0.2, 0.2, 0.2], c: [0.1, 0.8, 0.1], h: [0.1, 0.1, 0.7] });
    const decided = preferEvidenceCoverage(roots, value, meter());
    // c serves statement 1 and stays; e (slot 5) then d (slot 4) are replaced and follow in base order.
    expect(decided.order).toEqual(["a", "b", "c", "h", "g", "d", "e", "f"]);
    expect(decided.top_positions).toEqual([7, 3, 8]);
    expect(decided.injections).toEqual([{ statement: 0, root_position: 7, status: "injected", slot: 5 },
      { statement: 2, root_position: 8, status: "injected", slot: 4 }]);
  });

  it("keeps the order when every slot 2-5 serves, never moves slot 1 and breaks ties to the earlier position", () => {
    const full = coverage(4, { b: [0.9, 0, 0, 0], c: [0, 0.9, 0, 0], d: [0, 0, 0.9, 0], e: [0, 0, 0, 0.9] });
    expect(preferEvidenceCoverage(roots, full, meter()).order).toEqual(roots);
    const saturated = coverage(4, { b: [0.9, 0, 0, 0], c: [0, 0.9, 0, 0], d: [0, 0, 0.9, 0], e: [0, 0, 0, 0.5], f: [0, 0, 0, 0.5],
      g: [0, 0, 0, 0.5] });
    expect(preferEvidenceCoverage(roots, saturated, meter()).order).toEqual(roots);
    const firstServes = coverage(1, { a: [0.9], h: [0.5] });
    expect(preferEvidenceCoverage(roots, firstServes, meter()).order).toEqual(roots);
    const tie = coverage(1, { g: [0.5], h: [0.5] });
    expect(preferEvidenceCoverage(roots, tie, meter()).order).toEqual(["a", "b", "c", "d", "g", "e", "f", "h"]);
  });

  it("matches the declared rule over generated coverage, keyless roots, ties and short orders", () => {
    let seed = 7;
    const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    for (let trial = 0; trial < 400; trial++) {
      const statements = 1 + Math.floor(random() * 4), length = 1 + Math.floor(random() * roots.length);
      const values: Record<string, (number | null)[]> = {};
      for (const root of roots) if (random() > 0.2) {
        values[root] = Array.from({ length: statements }, () => Math.round(random() * 4) / 4);
      }
      const value = coverage(statements, values), order = [...roots].sort(() => random() - 0.5).slice(0, length);
      expect(preferEvidenceCoverage(order, value, meter()).order).toEqual(declaredRule(order, value));
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
