import { SourceSemanticResourceLedger, type SourceSemanticResourceBudget } from "@do-soul/alaya-protocol";
import type { StatementAssociation } from "./statement-association.js";

type Assignment = Readonly<{ roots: readonly (string | null)[]; count: number; weight: number }>;

const PACKED_POOL_LIMIT = 1024;

function sourceEarlier(pos: ReadonlyMap<string, number>, size: number,
  left: readonly (string | null)[], right: readonly (string | null)[]): boolean {
  for (let column = 0; column < left.length; column++) {
    const a = left[column] === null ? size : pos.get(left[column]!)!;
    const b = right[column] === null ? size : pos.get(right[column]!)!;
    if (a !== b) return a < b;
  }
  return false;
}

function better(pos: ReadonlyMap<string, number>, size: number, candidate: Assignment, incumbent: Assignment | undefined): boolean {
  return incumbent === undefined || candidate.count > incumbent.count || candidate.count === incumbent.count
    && (candidate.weight > incumbent.weight || candidate.weight === incumbent.weight
      && sourceEarlier(pos, size, candidate.roots, incumbent.roots));
}

function decodePosKey(posKey: number, pool: readonly string[], n: number, size: number): (string | null)[] {
  const base = size + 1;
  const roots: (string | null)[] = Array.from({ length: n }, () => null);
  let key = posKey;
  for (let column = n - 1; column >= 0; column--) {
    const digit = key % base;
    key = (key - digit) / base;
    roots[column] = digit === size ? null : pool[digit]!;
  }
  return roots;
}

/** Exact bitmask assignment of distinct pool roots to conditions; n is at most 5. */
export function injectiveConditionWitnessAssignment(pool: readonly string[],
  ranks: readonly (readonly string[])[], value: (id: string, column: number) => number | null): Assignment & {
  marginal: readonly (string | null)[]; identity: "root";
} | undefined {
  const n = ranks.length;
  if (n > 5) return undefined;
  const posMap = new Map<string, number>(), size = pool.length;
  for (let i = 0; i < size; i++) posMap.set(pool[i]!, i);
  const marginal = ranks.map(row => row[0] ?? null);
  const present = marginal.filter((id): id is string => id !== null);
  if (new Set(present).size === present.length) return undefined;
  const assigned = size <= PACKED_POOL_LIMIT
    ? packedAssignment(pool, posMap, n, size, value)
    : copiedAssignment(posMap, n, size, value);
  return assigned === undefined ? undefined : { ...assigned, marginal, identity: "root" };
}

function packedAssignment(pool: readonly string[], posMap: ReadonlyMap<string, number>, n: number, size: number,
  value: (id: string, column: number) => number | null): Assignment | undefined {
  const masks = 1 << n, base = size + 1;
  const counts = new Int32Array(masks).fill(-1);
  const weights = new Float64Array(masks);
  const posKeys = new Float64Array(masks);
  const placeValue = new Float64Array(n);
  for (let column = 0; column < n; column++) placeValue[column] = base ** (n - 1 - column);
  counts[0] = 0;
  posKeys[0] = base ** n - 1;
  for (const [id, itemPos] of posMap) {
    for (let mask = masks - 2; mask >= 0; mask--) {
      const count = counts[mask]!;
      if (count < 0) continue;
      for (let column = 0; column < n; column++) {
        if ((mask & (1 << column)) !== 0) continue;
        const weight = value(id, column);
        if (weight === null) continue;
        const nextMask = mask | (1 << column);
        const candCount = count + 1;
        const candWeight = weights[mask]! + weight;
        const candKey = posKeys[mask]! - (size - itemPos) * placeValue[column]!;
        const incCount = counts[nextMask]!;
        if (incCount < 0 || candCount > incCount || candCount === incCount
          && (candWeight > weights[nextMask]! || candWeight === weights[nextMask]! && candKey < posKeys[nextMask]!)) {
          counts[nextMask] = candCount;
          weights[nextMask] = candWeight;
          posKeys[nextMask] = candKey;
        }
      }
    }
  }
  let bestMask = -1;
  for (let mask = 0; mask < masks; mask++) {
    const count = counts[mask]!;
    if (count < 0) continue;
    if (bestMask < 0 || count > counts[bestMask]!
      || count === counts[bestMask]! && (weights[mask]! > weights[bestMask]!
        || weights[mask]! === weights[bestMask]! && posKeys[mask]! < posKeys[bestMask]!)) {
      bestMask = mask;
    }
  }
  return bestMask < 0 ? undefined : {
    roots: decodePosKey(posKeys[bestMask]!, pool, n, size), count: counts[bestMask]!, weight: weights[bestMask]!
  };
}

function copiedAssignment(posMap: ReadonlyMap<string, number>, n: number, size: number,
  value: (id: string, column: number) => number | null): Assignment | undefined {
  const masks = 1 << n;
  const dp: Array<Assignment | undefined> = Array.from({ length: masks }, () => undefined);
  dp[0] = { roots: Array.from({ length: n }, () => null), weight: 0, count: 0 };
  for (const [id] of posMap) {
    for (let mask = masks - 2; mask >= 0; mask--) {
      const row = dp[mask];
      if (row === undefined) continue;
      for (let column = 0; column < n; column++) {
        if ((mask & (1 << column)) !== 0) continue;
        const weight = value(id, column);
        if (weight === null) continue;
        const nextMask = mask | (1 << column);
        const incumbent = dp[nextMask];
        if (!(incumbent === undefined || row.count + 1 >= incumbent.count)) continue;
        const roots = row.roots.slice() as (string | null)[];
        roots[column] = id;
        const candidate: Assignment = { roots, count: row.count + 1, weight: row.weight + weight };
        if (better(posMap, size, candidate, incumbent)) dp[nextMask] = candidate;
      }
    }
  }
  let best: Assignment | undefined;
  for (const row of dp) {
    if (row === undefined) continue;
    if (better(posMap, size, row, best)) best = row;
  }
  return best;
}

/** Conservative upper bound on elementary operations and container bytes. n is 1..5. */
export function quoteStatementParetoExchange(roots: number, statements: number): SourceSemanticResourceBudget {
  if (roots < 1 || statements < 1 || statements > 5) return { work_units: 0, memory_bytes: 0 };
  const R = roots, n = statements, M = 1 << n;
  const setupAndSort = R * (n + 6) + n * R * (2 * Math.ceil(Math.log2(R + 1)) + 2) + 4 * n;
  const dpWork = n >= 2
    ? 3 * R + R * M + R * n * (1 << (n - 1)) * (R <= PACKED_POOL_LIMIT ? 4 : 2 * n + 4) + M * (n + 2)
    : 0;
  const pairs = Math.floor(((R - 1) * (R - 1)) / 4);
  const dominance = 2 * n * (R * (2 * n + 5) + n * 2 * pairs);
  return {
    work_units: setupAndSort + dpWork + dominance,
    memory_bytes: 2048 + R * (256 + 32 * n) + n * 384
      + (n >= 2 ? (R <= PACKED_POOL_LIMIT ? 1024 + M * 48 : 1024 + M * 32 + R * n * (1 << (n - 1)) * (160 + n * 16)) : 0)
  };
}

export function exchangeStatementParetoSecondary(input: Readonly<{
  association: StatementAssociation; pool: readonly string[]; head: string[]; tail: string[];
  agreed: readonly string[]; meter: SourceSemanticResourceLedger;
}>): Readonly<{ executed: boolean; swapped: boolean }> {
  const { association, pool, head, tail, agreed, meter } = input;
  const relations = association.relations;
  if (relations === undefined || pool.length === 0 || association.statements < 1 || association.statements > 5) {
    return { executed: false, swapped: false };
  }
  const sizedRoots = Math.max(pool.length, association.roots.length, head.length + tail.length, agreed.length);
  const quote = quoteStatementParetoExchange(sizedRoots, association.statements);
  meter.charge(quote.work_units, quote.memory_bytes, "statement relation witness exchange");
  if (relations.every(row => row.every(value => value === null))) return { executed: true, swapped: false };
  const n = association.statements;
  const posMap = new Map<string, number>();
  for (let i = 0; i < pool.length; i++) posMap.set(pool[i]!, i);
  const rootRow = new Map<string, number>();
  for (let i = 0; i < association.roots.length; i++) rootRow.set(association.roots[i]!, i);
  const coverage = (id: string, column: number) => {
    const row = rootRow.get(id); return row === undefined ? null : association.coverage[row]![column]!;
  };
  const possible = (id: string, column: number) => association.possible?.[rootRow.get(id) ?? -1]?.[column] === true;
  const ranks = Array.from({ length: n }, (_, column) => pool.filter(id => coverage(id, column) !== null)
    .sort((left, right) => coverage(right, column)! - coverage(left, column)! || posMap.get(left)! - posMap.get(right)!));
  const marginal = ranks.map(row => row[0] ?? null);
  let match: ReturnType<typeof injectiveConditionWitnessAssignment> | null = null;
  if (n >= 2) {
    const rankTable = new Int32Array(pool.length * n).fill(-1);
    for (let column = 0; column < n; column++) {
      const ranked = ranks[column]!;
      for (let rank = 0; rank < ranked.length; rank++) {
        const cell = posMap.get(ranked[rank]!)! * n + column;
        if (rankTable[cell]! < 0) rankTable[cell] = rank;
      }
    }
    const quantile = (id: string, column: number): number | null => {
      const pos = posMap.get(id);
      if (pos === undefined) return null;
      const rank = rankTable[pos * n + column]!;
      return rank < 0 ? null : (ranks[column]!.length - rank) / ranks[column]!.length;
    };
    match = injectiveConditionWitnessAssignment(pool, ranks, quantile) ?? {
      roots: marginal, count: marginal.filter(Boolean).length,
      weight: marginal.reduce((sum, id, column) => sum + (id === null ? 0 : quantile(id, column)!), 0),
      marginal, identity: "root" as const
    };
  }
  const placed = new Set((match?.roots ?? []).filter((id): id is string => id !== null && head.includes(id)));
  const agreedSet = new Set(agreed);
  const marginalSet = new Set(marginal.filter((id): id is string => id !== null));
  const tailRows = new Int32Array(tail.length);
  for (let i = 0; i < tail.length; i++) tailRows[i] = rootRow.get(tail[i]!) ?? -1;
  let exchanged = false;

  const tryPlace = (incoming: string, column: number): boolean => {
    const at = tail.indexOf(incoming);
    if (at < 0) return false;
    for (let slot = head.length - 1; slot >= 1; slot--) {
      const occupant = head[slot]!;
      if (agreedSet.has(occupant) || marginalSet.has(occupant) || placed.has(occupant)) continue;
      const occRow = rootRow.get(occupant);
      if (occRow === undefined) continue;
      const occCov = association.coverage[occRow]!;
      const occRel = relations[occRow]!;
      let hasWitness = false;
      for (let d = 0; d < n; d++) {
        if (occCov[d] !== null) { hasWitness = true; break; }
      }
      if (!hasWitness) continue;
      let possibleGuard = true;
      for (let d = 0; d < n; d++) {
        if (occCov[d] !== null || !possible(occupant, d) || d === column && coverage(incoming, column) !== null) continue;
        possibleGuard = false; break;
      }
      if (!possibleGuard) continue;
      let dominated = true;
      for (let d = 0; d < n; d++) {
        if (occCov[d] === null) continue;
        let found = false;
        for (let t = 0; t < tailRows.length; t++) {
          const tRow = tailRows[t]!;
          if (tRow < 0) continue;
          const tCov = association.coverage[tRow]?.[d];
          const tRel = relations[tRow]?.[d];
          if (tCov != null && tCov > occCov[d]! && tRel != null && occRel[d] != null && tRel > occRel[d]!) {
            found = true; break;
          }
        }
        if (!found) { dominated = false; break; }
      }
      if (!dominated) continue;
      const displaced = head[slot]!;
      head[slot] = incoming;
      tail[at] = displaced;
      tailRows[at] = rootRow.get(displaced) ?? -1;
      exchanged = true;
      return true;
    }
    return false;
  };

  if (match !== null) {
    for (const [column, id] of match.roots.entries()) {
      if (id !== null && !head.includes(id) && tryPlace(id, column)) placed.add(id);
    }
  }
  if (association.spans !== undefined) {
    for (const [column, ranked] of ranks.entries()) {
      const top = ranked[0], candidate = ranked[1];
      if (top === undefined || candidate === undefined || !head.includes(top) || head.includes(candidate)) continue;
      if (tryPlace(candidate, column)) placed.add(candidate);
    }
  }
  return { executed: true, swapped: exchanged };
}
