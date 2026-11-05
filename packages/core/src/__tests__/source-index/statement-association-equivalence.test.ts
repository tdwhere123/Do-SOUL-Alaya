import { describe, expect, it } from "vitest";
import { SourceSemanticResourceLedger } from "@do-soul/alaya-protocol";
import { orderNativeFieldAccess, type NativeRouteLane } from "../../recall/runtime/native-route-opportunity.js";
import { preferAssociatedSlot, quoteStatementAssociation, restrictStatementAssociation, StatementKeyRetention,
  statementAssociationLink, type StatementAssociation } from "../../source-index/statement-association.js";

type Key = { root: string; question: number; vector: Float32Array };
type Dense = { roots: string[]; question: number[]; link: number[][] };

// Independent reference: retain the stable top 16, calculate every key pair in acquisition order,
// and use the original full symmetric matrix and slot rule.
function denseOracle(roots: string[], keys: Key[]): Dense {
  const rows = roots.map(root => keys.filter(key => key.root === root).sort((a, b) => b.question - a.question).slice(0, 16));
  const question = rows.map(row => row[0]?.question ?? -1);
  const norms = rows.map(row => row.map(key => Math.sqrt(key.vector.reduce((sum, n) => sum + n * n, 0))));
  const link = roots.map(() => roots.map(() => -1));
  for (let i = 0; i < roots.length; i++) for (let j = i + 1; j < roots.length; j++) {
    let best = -1;
    for (let a = 0; a < rows[i]!.length; a++) for (let b = 0; b < rows[j]!.length; b++) {
      let dot = 0;
      const left = rows[i]![a]!.vector, right = rows[j]![b]!.vector;
      for (let d = 0; d < left.length; d++) dot += left[d]! * right[d]!;
      const an = norms[i]![a]!, bn = norms[j]![b]!;
      const value = an === 0 || bn === 0 ? -1 : dot / (an * bn);
      if (value > best) best = value;
    }
    link[i]![j] = best; link[j]![i] = best;
  }
  return { roots, question, link };
}

function oracleOrder(order: readonly string[], dense: Dense): string[] {
  const out = [...order], index = (key: string) => dense.roots.indexOf(key);
  if (out.length < 6) return out;
  const slot = index(out[4]!);
  if (slot < 0) return out;
  const first = out.slice(0, 4).map(index).filter(i => i >= 0);
  const grade = (i: number) => Math.max(-1, ...first.map(j => dense.link[i]![j]!));
  const q = dense.question[slot]!, l = grade(slot);
  for (let n = 5; n < out.length; n++) {
    const i = index(out[n]!);
    if (i < 0) continue;
    const nextQ = dense.question[i]!, nextL = grade(i);
    if (nextQ >= q && nextL >= l && (nextQ > q || nextL > l)) {
      [out[4], out[n]] = [out[n]!, out[4]!]; break;
    }
  }
  return out;
}

function associate(roots: string[], keys: Key[], dimensions: number) {
  const meter = new SourceSemanticResourceLedger(quoteStatementAssociation(roots.length, keys.length, dimensions));
  const refusal: string[] = [];
  const retention = new StatementKeyRetention(meter, phase => refusal.push(phase));
  for (const key of keys) retention.consider(key.root, key.question, key.vector);
  const before = { work: meter.spentWork, bytes: meter.spentBytes };
  const result = retention.associate(roots);
  expect(refusal).toEqual([]);
  expect(result).toBeDefined();
  return { result: result!, work: meter.spentWork - before.work, bytes: meter.spentBytes - before.bytes };
}

const navigationMeter = () => new SourceSemanticResourceLedger({ work_units: 1e9, memory_bytes: 1e9 });
function full(association: StatementAssociation): number[][] {
  const meter = navigationMeter();
  return association.roots.map((_, i) => association.roots.map((_, j) => i === j ? -1
    : statementAssociationLink(association, i, j, meter)));
}

function generator(seed: number) {
  return () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 0x100000000; };
}
function shuffled<T>(values: readonly T[], random: () => number): T[] {
  const result = [...values];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1)); [result[i], result[j]] = [result[j]!, result[i]!];
  }
  return result;
}

function fieldInput(roots: string[], preferred: string[]) {
  const occurrences = roots.map((root, i) => ({ reference: `source:${root}`, root_key: root, native_rank: i + 1 }));
  const memory = [{ reference: "memory", root_key: "memory", native_rank: 1 }];
  const lanes: NativeRouteLane[] = ["original-lexical", "original-vector", "hint-lexical", "hint-vector"].map((lane, i) => ({
    lane: lane as NativeRouteLane["lane"], scope: "query",
    ...(i === 0 ? { state: "exact-captured" as const, occurrences } : { state: "measured-empty" as const }) }));
  return { lanes, memory: { lane: "memory-lexical" as const, scope: "query", state: "exact-captured" as const, occurrences: memory },
    pool: [...roots, "memory"].map(record_id => ({ record_id, catalog_position: null })),
    acquired_root_keys: [...roots, "memory"],
    associations: [...occurrences, ...memory].map(row => ({ occurrence_reference: row.reference, root_key: row.root_key, record_id: row.root_key })),
    unvisited_sources: true, question_time: { root_order: preferred,
      capture: { lane: "question-time-lexical" as const, scope: "query", state: "measured-empty" as const } } };
}

describe("exact statement association and final field order", () => {
  it("matches a dense oracle across reordered, time-preferred, filtered, keyless and tied roots", () => {
    const random = generator(91324), roots = Array.from({ length: 16 }, (_, i) => `root-${i}`);
    for (const dimensions of [4, 7, 31, 64, 257]) for (let trial = 0; trial < 12; trial++) {
      const keys: Key[] = [];
      for (let i = 0; i < roots.length; i++) {
        const count = i === trial % roots.length ? 0 : i === 0 ? 20 : 1 + Math.floor(random() * 5);
        for (let k = 0; k < count; k++) {
          const vector = Float32Array.from({ length: dimensions }, () => Math.fround(random() * 2 - 1));
          if (trial === 0 && i === 1 && k === 0) vector.fill(0);
          keys.push({ root: roots[i]!, question: k % 3 === 0 ? 0.5 : Math.floor(random() * 5) / 5, vector });
        }
      }
      const dense = denseOracle(roots, keys), actual = associate(roots, keys, dimensions).result;
      expect(actual.question).toEqual(dense.question);
      expect(actual.link.flat().every(value => value === null)).toBe(true);
      for (let n = 0; n < 4; n++) {
        const retained = roots.filter(() => random() > 0.2), restricted = restrictStatementAssociation(actual, r => retained.includes(r));
        const restrictedDense = denseOracle(retained, keys);
        const order = shuffled([...retained, "unassociated"], random);
        expect(preferAssociatedSlot(order, restricted, navigationMeter())).toEqual(oracleOrder(order, restrictedDense));
        const input = fieldInput(retained, shuffled(retained, random).slice(0, 4));
        const before = orderNativeFieldAccess(input), after = orderNativeFieldAccess({ ...input, association: restricted }, navigationMeter());
        expect(before.status).toBe("ordered"); expect(after.status).toBe("ordered");
        if (before.status !== "ordered" || after.status !== "ordered") throw new Error("expected total order");
        const sourceOrder = oracleOrder(before.record_ids.filter(id => id !== "memory"), restrictedDense);
        let cursor = 0;
        expect(after.record_ids).toEqual(before.record_ids.map(id => id === "memory" ? id : sourceOrder[cursor++]));
      }
      expect(full(actual)).toEqual(dense.link);
    }
  });

  it("preserves close comparisons and extreme finite Float32 magnitudes", () => {
    const random = generator(551), roots = Array.from({ length: 16 }, (_, i) => `r${i}`), dimensions = 129;
    const scales = [2 ** -149, 2 ** -100, 1, 2 ** 100, 3e38];
    const keys = roots.flatMap((root, i) => Array.from({ length: 4 }, (_, k) => ({ root, question: k / 5,
      vector: Float32Array.from({ length: dimensions }, (_, d) => {
        const sign = (d + i + k) % 3 ? 1 : -1;
        return Math.fround(sign * scales[(i + k) % scales.length]! * (d % 3 === 0 ? 1 : 0.5 + random() * 0.5));
      }) })));
    expect(full(associate(roots, keys, dimensions).result)).toEqual(denseOracle(roots, keys).link);
  });

  it("evaluates only demanded pairs and shares results across repeated source orders", () => {
    const random = generator(91324), count = 16, dimensions = 64;
    const roots = Array.from({ length: count }, (_, i) => `r${i}`);
    const keys = roots.flatMap(root => Array.from({ length: 16 }, (_, k) => ({ root, question: (16 - k) / 20,
      vector: Float32Array.from({ length: dimensions }, () => random() * 2 - 1) })));
    const actual = associate(roots, keys, dimensions).result, meter = navigationMeter();
    const dense = denseOracle(roots, keys);
    expect(preferAssociatedSlot(roots, actual, meter)).toEqual(oracleOrder(roots, dense));
    expect(actual.link.flat().filter(value => value !== null).length).toBeLessThanOrEqual(4 * (count - 4));
    const firstWork = meter.spentWork;
    expect(preferAssociatedSlot(roots, actual, meter)).toEqual(oracleOrder(roots, dense));
    expect(meter.spentWork - firstWork).toBeLessThanOrEqual(count * 2 + 4 * (count - 4));
    expect(full(actual)).toEqual(dense.link);
  });

  it("reports comparison reduction separately from the increased explicit retained vectors", () => {
    const dimensions = 32;
    for (const count of [6, 16, 32]) {
      const roots = Array.from({ length: count }, (_, i) => `r${i}`);
      const keys = roots.flatMap((root, i) => Array.from({ length: 4 }, (_, k) => {
        const vector = new Float32Array(dimensions);
        vector[0] = 1; vector[1 + k] = 0.5 + i / 10000;
        return { root, vector, question: (16 - k) / 20 };
      }));
      const actual = associate(roots, keys, dimensions).result, dense = denseOracle(roots, keys), meter = navigationMeter();
      expect(preferAssociatedSlot(roots, actual, meter)).toEqual(oracleOrder(roots, dense));
      const baselineWork = count * (count - 1) / 2 * 4 * 4 * dimensions;
      expect(meter.spentWork).toBeLessThan(baselineWork);
      const allowance = { work_units: 10_000_000, memory_bytes: 100_000_000 };
      const retained = SourceSemanticResourceLedger.measureRetain(actual, allowance);
      const original = SourceSemanticResourceLedger.measureRetain(dense, allowance);
      expect(retained.memory_bytes).toBeGreaterThan(original.memory_bytes);
    }
  });
});
