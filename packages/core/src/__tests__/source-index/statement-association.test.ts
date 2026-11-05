import { describe, expect, it } from "vitest";
import { SourceSemanticResourceLedger } from "@do-soul/alaya-protocol";
import { preferAssociatedSlot, quoteStatementAssociation, restrictStatementAssociation, StatementKeyRetention,
  statementAssociationLink, statementAssociationRefusalReason,
  STATEMENT_ASSOCIATION_KEYS_PER_ROOT, type StatementAssociation } from "../../source-index/statement-association.js";
import { orderNativeFieldAccess, type NativeRouteLane } from "../../recall/runtime/native-route-opportunity.js";

const roots = ["a", "b", "c", "d", "e", "f", "g"];
const meter = (work_units = 1e9, memory_bytes = 1e9) => new SourceSemanticResourceLedger({ work_units, memory_bytes });
function association(question: Record<string, number>, links: Record<string, number>): StatementAssociation {
  return { roots, question: roots.map(root => question[root] ?? 0.1), keys: roots.map(() => []), refusal: { phase: null, swap_selected: false },
    link: roots.map((left, i) => roots.slice(0, i).map(right => links[[left, right].sort().join("")] ?? 0.1)) };
}
const select = (order: readonly string[], value: StatementAssociation) => preferAssociatedSlot(order, value, meter());

describe("statement association source-slot heuristic", () => {
  it("chooses the earliest two-coordinate dominator, not a weighted score", () => {
    expect(select(roots, association({ e: 0.3, f: 0.4, g: 0.5 }, { ae: 0.2, af: 0.2, bg: 0.6 })))
      .toEqual(["a", "b", "c", "d", "f", "e", "g"]);
    expect(select(roots, association({ e: 0.3, f: 0.9, g: 0.1 }, { ae: 0.5, af: 0.2, bg: 0.9 }))).toEqual(roots);
  });
  it("preserves a tied slot, a keyless candidate and an unassociated incumbent", () => {
    expect(select(roots, association({}, {}))).toEqual(roots);
    expect(select(roots, association({ f: -1, g: -1 }, {}))).toEqual(roots);
    const restricted = restrictStatementAssociation(association({ f: 0.9 }, { af: 0.9 }), root => root !== "e");
    expect(select(roots, restricted)).toEqual(roots);
    expect(select(roots.slice(0, 5), association({}, {}))).toEqual(roots.slice(0, 5));
  });
  it("does not imply complementary evidence quality from coherent cosine dominance", () => {
    const retained = new StatementKeyRetention(meter(), () => { throw new Error("unexpected refusal"); });
    for (const root of roots) retained.consider(root, root === "e" ? 0.6 : 1,
      root === "e" ? Float32Array.of(0.6, 0.8) : Float32Array.of(1, 0));
    const result = select(roots, retained.associate(roots)!);
    const requiredEvidence = new Set(["a", "e"]);
    expect([...requiredEvidence].every(root => roots.slice(0, 5).includes(root))).toBe(true);
    expect([...requiredEvidence].every(root => result.slice(0, 5).includes(root))).toBe(false);
    expect(new Set(result)).toEqual(new Set(roots));
  });
});

describe("statement key retention and demanded pairs", () => {
  it("keeps the stable best sixteen keys and computes no pair at capture", () => {
    const retained = new StatementKeyRetention(meter(), () => { throw new Error("unexpected refusal"); });
    for (let i = 0; i < STATEMENT_ASSOCIATION_KEYS_PER_ROOT + 4; i++) retained.consider("a", i / 100, Float32Array.of(1, 0));
    retained.consider("b", 0.5, Float32Array.of(0, 1));
    retained.consider("b", 0.4, Float32Array.of(1, 1));
    const value = retained.associate(["a", "b", "c"])!;
    expect(value.question).toEqual([0.19, 0.5, -1]);
    expect(value.keys[0]).toHaveLength(16);
    expect(value.link).toEqual([[], [null], [null, null]]);
    expect(statementAssociationLink(value, 0, 1, meter())).toBeCloseTo(Math.SQRT1_2);
    expect(statementAssociationLink(value, 0, 2, meter())).toBe(-1);
    expect(value.link[2]![1]).toBeNull();
  });
  it("charges every exact comparison once and preserves prepaid cache capacity across reuse", () => {
    const retained = new StatementKeyRetention(meter(), () => { throw new Error("unexpected refusal"); });
    for (const root of roots) retained.consider(root, 0.5, Float32Array.of(1, 0, 0, 0));
    const value = retained.associate(roots)!, resource = meter();
    const before = SourceSemanticResourceLedger.measureRetain(value, resource.remaining());
    expect(preferAssociatedSlot(roots, value, resource)).toEqual(roots);
    // Four seeds times the three remaining roots, never the six seed/seed or three tail/tail pairs.
    expect(value.link.flat().filter(link => link !== null)).toHaveLength(12);
    const spent = resource.spentWork;
    preferAssociatedSlot(roots, value, resource);
    expect(resource.spentWork - spent).toBe(roots.length * 2 + 12);
    expect(SourceSemanticResourceLedger.measureRetain(value, resource.remaining())).toEqual(before);
    const restricted = restrictStatementAssociation(value, root => root !== "b");
    expect(statementAssociationLink(restricted, 0, 3, meter(1))).toBe(1);
  });
  it("rejects incompatible dimensions and never disrupts later base-vector nomination", () => {
    const refused: string[] = [], retained = new StatementKeyRetention(meter(), phase => refused.push(phase));
    retained.consider("a", 0.2, Float32Array.of(1, 0));
    retained.consider("b", 0.3, Float32Array.of(1, 0, 0));
    retained.consider("c", 0.4, Float32Array.of(1, 0));
    expect(retained.associate(roots)).toBeUndefined();
    expect(refused).toEqual(["statement key association incompatible dimensions"]);
  });
  it("reports retention refusal once, without returning partial data", () => {
    const refused: string[] = [], retained = new StatementKeyRetention(meter(1e9, 10), phase => refused.push(phase));
    retained.consider("a", 0.5, Float32Array.of(1, 0));
    retained.consider("b", 0.5, Float32Array.of(1, 0));
    expect(retained.associate(roots)).toBeUndefined();
    expect(refused).toEqual(["statement key association retention"]);
  });
  it("persists a pair refusal without free retries or a partial swap", () => {
    const retained = new StatementKeyRetention(meter(), () => { throw new Error("unexpected refusal"); });
    for (const root of roots) retained.consider(root, 0.5, Float32Array.of(1, 0, 0, 0));
    const value = retained.associate(roots)!, tight = meter(roots.length * 2 + 1);
    const before = SourceSemanticResourceLedger.measureRetain(value, meter().remaining());
    expect(preferAssociatedSlot(roots, value, tight)).toEqual(roots);
    expect(statementAssociationRefusalReason(value)).toBe("statement key association link");
    expect(value.link.flat().every(link => link === null)).toBe(true);
    const retry = meter();
    expect(preferAssociatedSlot(roots, value, retry)).toEqual(roots);
    expect(retry.spentWork).toBe(0);
    expect(SourceSemanticResourceLedger.measureRetain(value, meter().remaining())).toEqual(before);
  });
  it("quotes capture and complete explicit retained data before allocation", () => {
    const dimensions = 64, windows = 40;
    const ledger = new SourceSemanticResourceLedger(quoteStatementAssociation(roots.length, windows, dimensions));
    const retained = new StatementKeyRetention(ledger, () => { throw new Error("quote must fund capture"); });
    for (let i = 0; i < windows; i++) retained.consider(roots[i % roots.length]!, i / windows, new Float32Array(dimensions).fill(1));
    const value = retained.associate(roots)!;
    expect(value).toBeDefined();
    ledger.retain(value, "retained association");
    expect(ledger.remaining().memory_bytes).toBeGreaterThanOrEqual(0);
  });
});

describe("field association diagnostics", () => {
  const occurrences = roots.map((root, i) => ({ reference: `o-${root}`, root_key: root, native_rank: i + 1 }));
  const memory = [{ reference: "memory", root_key: "m", native_rank: 1 }];
  const lanes: NativeRouteLane[] = ["original-lexical", "original-vector", "hint-lexical", "hint-vector"].map((lane, i) => ({
    lane: lane as NativeRouteLane["lane"], scope: "q",
    ...(i === 0 ? { state: "exact-captured" as const, occurrences } : { state: "measured-empty" as const }) }));
  const input = { lanes, memory: { lane: "memory-lexical" as const, scope: "q", state: "exact-captured" as const, occurrences: memory },
    pool: [...roots, "m"].map(record_id => ({ record_id, catalog_position: null })), acquired_root_keys: [...roots, "m"],
    associations: [...occurrences, ...memory].map(row => ({ occurrence_reference: row.reference, root_key: row.root_key, record_id: row.root_key })),
    unvisited_sources: true };
  it("reports the actual mixed ranks while preserving memory positions and all original sources", () => {
    const value = association({ e: 0.1, f: 0.2 }, {}), result = orderNativeFieldAccess({ ...input, association: value }, meter());
    expect(result.status).toBe("ordered");
    if (result.status !== "ordered") throw new Error("expected total order");
    expect(result.record_ids).toEqual(["a", "m", "b", "c", "d", "f", "e", "g"]);
    expect(result).toHaveProperty("statement_association", { status: "swapped", source_slot: 5,
      replacement_global_rank: 7, replaced_global_rank: 6, mixed_at_5_changed: false, reason: "question_and_link_dominance" });
    expect(new Set(result.record_ids)).toEqual(new Set([...roots, "m"]));
  });
  it("preserves base access when even optional validation is unfunded", () => {
    const result = orderNativeFieldAccess({ ...input, association: association({ f: 0.9 }, {}) }, meter(0));
    expect(result).toMatchObject({ status: "ordered", record_ids: ["a", "m", "b", "c", "d", "e", "f", "g"],
      statement_association: { status: "resource_refused", mixed_at_5_changed: false } });
  });
  it("refuses a smaller later budget instead of undoing the selected source permutation", () => {
    const value = association({ e: 0.1, f: 0.2 }, {});
    const first = orderNativeFieldAccess({ ...input, association: value }, meter());
    expect(first).toMatchObject({ statement_association: { status: "swapped" } });
    expect(() => orderNativeFieldAccess({ ...input, association: value }, meter(0))).toThrow(/budget exhausted/u);
    expect(value.refusal.phase).toBeNull();
    const resumed = orderNativeFieldAccess({ ...input, association: value }, meter());
    expect(resumed).toEqual(first);
  });
  it("rejects malformed cache shape rather than using a fabricated association", () => {
    const value = association({}, {});
    value.link[0] = [0.9];
    expect(() => orderNativeFieldAccess({ ...input, association: value }, meter())).toThrow(/triangular link/u);
  });
});
