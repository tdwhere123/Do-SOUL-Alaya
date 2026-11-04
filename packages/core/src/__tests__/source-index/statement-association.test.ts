import { describe, expect, it } from "vitest";
import { SourceSemanticResourceLedger } from "@do-soul/alaya-protocol";
import { preferAssociatedSlot, quoteStatementAssociation, restrictStatementAssociation, StatementKeyRetention,
  STATEMENT_ASSOCIATION_KEYS_PER_ROOT, type StatementAssociation } from "../../source-index/statement-association.js";
import { orderNativeFieldAccess, type NativeRouteLane } from "../../recall/runtime/native-route-opportunity.js";

const roots = ["a", "b", "c", "d", "e", "f", "g"];
function association(question: Record<string, number>, links: Record<string, number>): StatementAssociation {
  return { roots, question: roots.map(root => question[root] ?? 0.1),
    link: roots.map((left, i) => roots.slice(0, i).map(right => links[[left, right].sort().join("")] ?? 0.1)) };
}

describe("statement association slot 5", () => {
  it("swaps slot 5 with the earliest later root that dominates it on both coordinates", () => {
    const value = association({ e: 0.3, f: 0.4, g: 0.5 }, { ae: 0.2, af: 0.2, bg: 0.6 });
    // f ties e on link and beats it on question; g dominates too but comes later.
    expect(preferAssociatedSlot(roots, value)).toEqual(["a", "b", "c", "d", "f", "e", "g"]);
  });
  it("keeps the order when a later root is better on only one coordinate", () => {
    const value = association({ e: 0.3, f: 0.9, g: 0.1 }, { ae: 0.5, af: 0.2, bg: 0.9 });
    expect(preferAssociatedSlot(roots, value)).toEqual(roots);
  });
  it("lets a keyless slot 5 yield to the earliest later keyed root, and never moves a keyless root into slot 5", () => {
    const keyless = association({ e: -1, f: -1, g: 0.2 }, { ae: -1, be: -1, ce: -1, de: -1, ef: -1, eg: -1,
      af: -1, bf: -1, cf: -1, df: -1, fg: -1 });
    expect(preferAssociatedSlot(roots, keyless)).toEqual(["a", "b", "c", "d", "g", "f", "e"]);
    expect(preferAssociatedSlot(roots, association({ f: -1 }, { af: -1, bf: -1, cf: -1, df: -1, ef: -1, fg: -1 })))
      .toEqual(roots);
  });
  it("keeps the order when slot 5 is outside the association or fewer than six roots", () => {
    const value = restrictStatementAssociation(association({ f: 0.9 }, { af: 0.9 }), root => root !== "e");
    expect(preferAssociatedSlot(roots, value)).toEqual(roots);
    expect(preferAssociatedSlot(roots.slice(0, 5), association({}, {}))).toEqual(roots.slice(0, 5));
  });
  it("restricts by membership without reindexing errors", () => {
    const value = restrictStatementAssociation(association({ a: 0.7, c: 0.2 }, { ac: 0.4 }), root => root === "a" || root === "c");
    expect(value).toEqual({ roots: ["a", "c"], question: [0.7, 0.2], link: [[], [0.4]] });
  });
});

describe("statement key retention", () => {
  const meter = () => new SourceSemanticResourceLedger({ work_units: 1e9, memory_bytes: 1e9 });
  it("keeps the most question-similar keys per root and links roots by their closest keys", () => {
    const retention = new StatementKeyRetention(meter(), () => { throw new Error("unexpected refusal"); });
    for (let i = 0; i < STATEMENT_ASSOCIATION_KEYS_PER_ROOT + 4; i++) retention.consider("a", i / 100, Float32Array.of(1, 0));
    retention.consider("b", 0.5, Float32Array.of(0, 1));
    retention.consider("b", 0.4, Float32Array.of(1, 1));
    const value = retention.associate(["a", "b", "c"])!;
    expect(value.question).toEqual([0.19, 0.5, -1]);
    expect(value.link[1]![0]).toBeCloseTo(Math.SQRT1_2);
    expect(value.link[2]![0]).toBe(-1);
  });
  it("abandons the association and reports the refused phase once when retention is unfunded", () => {
    const refused: string[] = [];
    const retention = new StatementKeyRetention(new SourceSemanticResourceLedger({ work_units: 1e9, memory_bytes: 10 }),
      phase => refused.push(phase));
    retention.consider("a", 0.5, Float32Array.of(1, 0));
    retention.consider("b", 0.5, Float32Array.of(1, 0));
    expect(retention.associate(["a"])).toBeUndefined();
    expect(refused).toEqual(["statement key association retention"]);
  });
  it("falls back to exact links if optional comparison scratch cannot be funded", () => {
    const dimensions = 64, bytes = 2 * (dimensions * 4 + 48) + 3 * 8;
    const ledger = new SourceSemanticResourceLedger({ work_units: dimensions * 3, memory_bytes: bytes });
    const refused: string[] = [];
    const retention = new StatementKeyRetention(ledger, phase => refused.push(phase));
    retention.consider("a", 0.2, new Float32Array(dimensions).fill(1));
    retention.consider("b", 0.3, new Float32Array(dimensions).fill(1));
    expect(retention.associate(["a", "b"])?.link).toEqual([[], [1]]);
    expect(ledger.spentWork).toBe(dimensions * 3);
    expect(ledger.spentBytes).toBe(bytes);
    expect(refused).toEqual([]);
  });
  it("reports a link refusal without returning partial associations", () => {
    const dimensions = 4, ledger = new SourceSemanticResourceLedger({ work_units: dimensions * 2,
      memory_bytes: 2 * (dimensions * 4 + 48) + 3 * 8 });
    const refused: string[] = [], retention = new StatementKeyRetention(ledger, phase => refused.push(phase));
    retention.consider("a", 0.2, Float32Array.of(1, 0, 0, 0));
    retention.consider("b", 0.3, Float32Array.of(1, 0, 0, 0));
    expect(retention.associate(["a", "b"])).toBeUndefined();
    expect(ledger.spentWork).toBe(dimensions * 2);
    expect(refused).toEqual(["statement key association link"]);
  });
  it("stays within its quote when every window is retained and every root pair linked", () => {
    const dimensions = 4, windows = 40, rootKeys = ["a", "b", "c"];
    const quote = quoteStatementAssociation(rootKeys.length, windows, dimensions);
    const retention = new StatementKeyRetention(new SourceSemanticResourceLedger(quote),
      () => { throw new Error("quote must fund the worst case"); });
    for (let i = 0; i < windows; i++) retention.consider(rootKeys[i % 3]!, i / windows, Float32Array.of(1, i, 0, 1));
    expect(retention.associate(rootKeys)?.roots).toEqual(rootKeys);
  });
});

describe("field access with association", () => {
  it("permutes source slots only and leaves memory positions in place", () => {
    const occurrences = ["a", "b", "c", "d", "e", "f"].map((root, i) => ({ reference: `o-${root}`, root_key: root, native_rank: i + 1 }));
    const memory = [{ reference: "memory", root_key: "m", native_rank: 1 }];
    const lanes: NativeRouteLane[] = ["original-lexical", "original-vector", "hint-lexical", "hint-vector"].map((lane, i) => ({
      lane: lane as NativeRouteLane["lane"], scope: "q",
      ...(i === 0 ? { state: "exact-captured" as const, occurrences } : { state: "measured-empty" as const }) }));
    const value: StatementAssociation = { roots: ["a", "b", "c", "d", "e", "f"], question: [0.5, 0.5, 0.5, 0.5, 0.1, 0.2],
      link: Array.from({ length: 6 }, (_, i) => Array<number>(i).fill(0.3)) };
    const input = { lanes, memory: { lane: "memory-lexical" as const, scope: "q", state: "exact-captured" as const, occurrences: memory },
      pool: [...occurrences.map(row => row.root_key), "m"].map(record_id => ({ record_id, catalog_position: null })),
      acquired_root_keys: [...occurrences.map(row => row.root_key), "m"],
      associations: [...occurrences, ...memory].map(row => ({ occurrence_reference: row.reference, root_key: row.root_key, record_id: row.root_key })),
      unvisited_sources: true };
    const result = orderNativeFieldAccess({ ...input, association: value });
    expect(result.status).toBe("ordered");
    if (result.status !== "ordered") throw new Error("expected total order");
    expect(result.record_ids).toEqual(["a", "m", "b", "c", "d", "f", "e"]);
    const malformed = { ...value, link: value.link.map((row, i) => i === 0 ? [0.9] : row) };
    expect(() => orderNativeFieldAccess({ ...input, association: malformed })).toThrow(/triangular link/u);
  });
});
