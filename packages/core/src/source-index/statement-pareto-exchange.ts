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
  for (let i = 0; i < size; i++) if (!posMap.has(pool[i]!)) posMap.set(pool[i]!, i);
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
  const setupAndSort = R * (2 * n + 6) + 2 * n * R * Math.ceil(Math.log2(R + 1)) + 4 * n;
  const dpWork = n >= 2
    ? R * (n + M) + 2 * n * Math.ceil(Math.log2(R + 1))
      + R * n * (1 << (n - 1)) * (R <= PACKED_POOL_LIMIT ? 3 : 2 * n + 4) + M * (n + 2)
    : 0;
  const maxH = Math.min(4, Math.max(0, R - 1));
  let domPairs = 0;
  for (let h = 1; h <= maxH; h++) domPairs += h * Math.max(0, R - 1 - h);
  const vetoPairs = maxH * Math.max(0, maxH - 1);
  const dominance = 2 * n * (2 * R + maxH * (3 * n + 4) + 2)
    + 3 * n * domPairs + n * maxH * (maxH + 1) + 4 * n * n * vetoPairs;
  const headSize = Math.min(5, R);
  const matching = maxH === 0 ? 0 : R * n + (1 + 2 * n * maxH) * headSize * (2 * n + 2);
  return {
    work_units: setupAndSort + dpWork + dominance + matching,
    memory_bytes: 2048 + R * (256 + 32 * n) + n * 384
      + (matching === 0 ? 0 : 128 + 48 * R + 64 * headSize + 16 * n)
      + (n >= 2 ? (R <= PACKED_POOL_LIMIT ? 1024 + M * 48 : 1024 + M * 32 + R * n * (1 << (n - 1)) * (160 + n * 16)) : 0)
  };
}

export function exchangeStatementParetoSecondary(input: Readonly<{
  association: StatementAssociation; pool: readonly string[]; head: string[]; tail: string[];
  agreed: readonly string[]; meter: SourceSemanticResourceLedger;
}>): Readonly<{ executed: boolean; swapped: boolean }> {
  const { association, pool, head, tail, agreed, meter } = input;
  const relations = association.relations;
  if (relations === undefined || pool.length === 0 || head.length > 5 || association.statements < 1 || association.statements > 5) {
    return { executed: false, swapped: false };
  }
  const sizedRoots = Math.max(pool.length, association.roots.length, head.length + tail.length, agreed.length);
  const quote = quoteStatementParetoExchange(sizedRoots, association.statements);
  meter.charge(quote.work_units, quote.memory_bytes, "statement relation witness exchange");
  if (relations.every(row => row.every(value => value === null))) return { executed: true, swapped: false };
  const n = association.statements;
  const rows = rankWitnessRows(association, pool);
  const { ranks, marginal, match } = rows;
  const placed = new Set((match?.roots ?? []).filter((id): id is string => id !== null && head.includes(id)));
  const tailRows = Int32Array.from(tail, id => rows.rootRow.get(id) ?? -1);
  const placement = { ...rows, head, tail, tailRows, relations, n, placed,
    coverageRows: association.coverage, agreedSet: new Set(agreed),
    marginalSet: new Set(marginal.filter((id): id is string => id !== null)),
    slotDominated: new Int8Array(head.length).fill(-1),
    preservingRank: preserveHeadMatching(head, n, rows.coverage) };
  const tryPlace: TryPlace = (incoming, column, veto = false) => {
    if (!placeWitness(placement, incoming, column, veto)) return false;
    placed.add(incoming);
    return true;
  };
  let swapped = false;
  for (const [column, id] of (match?.roots ?? []).entries()) {
    if (id !== null && !head.includes(id) && tryPlace(id, column)) swapped = true;
  }
  if (association.spans !== undefined && placeDerivedWitnesses(ranks, head, placed, tryPlace)) swapped = true;
  return { executed: true, swapped };
}

function rankWitnessRows(association: StatementAssociation, pool: readonly string[]) {
  const n = association.statements;
  const uniquePool: string[] = [];
  const posMap = new Map<string, number>();
  for (let i = 0; i < pool.length; i++) {
    const id = pool[i]!;
    if (!posMap.has(id)) {
      posMap.set(id, uniquePool.length);
      uniquePool.push(id);
    }
  }
  const rootRow = new Map<string, number>();
  for (let i = 0; i < association.roots.length; i++) rootRow.set(association.roots[i]!, i);
  const coverage = (id: string, column: number) => {
    const row = rootRow.get(id); return row === undefined ? null : association.coverage[row]![column]!;
  };
  const possible = (id: string, column: number) => association.possible?.[rootRow.get(id) ?? -1]?.[column] === true;
  const ranks = Array.from({ length: n }, (_, column) => uniquePool.filter(id => coverage(id, column) !== null)
    .sort((left, right) => coverage(right, column)! - coverage(left, column)! || posMap.get(left)! - posMap.get(right)!));
  const marginal = ranks.map(row => row[0] ?? null);
  const match = n >= 2 ? matchQuantileAssignment(uniquePool, posMap, ranks, marginal, n) : null;
  return { rootRow, coverage, possible, ranks, marginal, match };
}

function preserveHeadMatching(head: readonly string[], n: number, coverage: (id: string, column: number) => number | null) {
  let currentRank: number | undefined;
  const masks = new Map<string, number>();
  const coverageMask = (id: string): number => {
    const prior = masks.get(id);
    if (prior !== undefined) return prior;
    let mask = 0;
    for (let column = 0; column < n; column++) if (coverage(id, column) !== null) mask |= 1 << column;
    masks.set(id, mask);
    return mask;
  };
  return (slot: number, incoming: string): boolean => {
    currentRank ??= headMatchingRank(head, n, coverageMask);
    const next = headMatchingRank(head.map((id, index) => index === slot ? incoming : id), n, coverageMask);
    if (next < currentRank) return false;
    currentRank = next;
    return true;
  };
}

type TryPlace = (incoming: string, column: number, veto?: boolean) => boolean;
type WitnessPlacement = Pick<ReturnType<typeof rankWitnessRows>, "rootRow" | "coverage" | "possible"> & Readonly<{
  head: string[]; tail: string[]; tailRows: Int32Array; slotDominated: Int8Array; n: number;
  agreedSet: ReadonlySet<string>; marginalSet: ReadonlySet<string>; placed: ReadonlySet<string>;
  coverageRows: StatementAssociation["coverage"]; relations: NonNullable<StatementAssociation["relations"]>;
  preservingRank: ReturnType<typeof preserveHeadMatching>;
}>;

function placeWitness(placement: WitnessPlacement, incoming: string, column: number, veto: boolean): boolean {
  const { head, tail, tailRows, slotDominated, n, rootRow, coverage, coverageRows, relations, possible,
    agreedSet, marginalSet, placed, preservingRank } = placement;
  const at = tail.indexOf(incoming);
  if (at < 0) return false;
  const unprotected: SlotCandidate[] = [];
  for (let slot = head.length - 1; slot >= 1; slot--) {
    const occupant = head[slot]!;
    if (agreedSet.has(occupant) || marginalSet.has(occupant) || placed.has(occupant)) continue;
    const occRow = rootRow.get(occupant);
    if (occRow === undefined) continue;
    const occCov = coverageRows[occRow]!, occRel = relations[occRow]!;
    if (!hasAnyWitness(occCov, n) || !passesPossibleGuard(occCov, n, column,
      d => possible(occupant, d), coverage(incoming, column) !== null)) continue;
    if (slotDominated[slot]! < 0) {
      slotDominated[slot] = isSlotDominated(occCov, occRel, coverageRows, relations, tailRows, n) ? 1 : 0;
    }
    const dominated = slotDominated[slot] === 1;
    if (veto) unprotected.push({ slot, occupant, occCov, dominated });
    else if (dominated && preservingRank(slot, incoming)) {
      swapHeadTail(head, tail, tailRows, slotDominated, rootRow, slot, at);
      return true;
    }
  }
  if (!veto) return false;
  const chosen = unprotected.find(s => s.dominated
    && !unprotected.some(o => o.slot !== s.slot && vetoesVictim(o, s, n, possible))
    && preservingRank(s.slot, incoming));
  if (chosen === undefined) return false;
  swapHeadTail(head, tail, tailRows, slotDominated, rootRow, chosen.slot, at);
  return true;
}

function placeDerivedWitnesses(ranks: readonly (readonly string[])[], head: readonly string[],
  placed: Set<string>, tryPlace: TryPlace): boolean {
  let swapped = false;
  const secondPassColumns: number[] = [];
  for (const [column, ranked] of ranks.entries()) {
    const top = ranked[0], candidate = ranked[1];
    if (top === undefined || candidate === undefined || !head.includes(top)) continue;
    if (head.includes(candidate)) {
      placed.add(candidate);
      secondPassColumns.push(column);
    } else if (tryPlace(candidate, column, true)) swapped = true;
  }
  for (const column of secondPassColumns) {
    const ranked = ranks[column]!;
    for (let k = 2; k < ranked.length; k++) {
      const id = ranked[k]!;
      if (head.includes(id)) {
        placed.add(id);
        continue;
      }
      if (tryPlace(id, column, true)) swapped = true;
      break;
    }
  }
  return swapped;
}

function headMatchingRank(head: readonly string[], n: number, coverageMask: (id: string) => number): number {
  const matched: (string | undefined)[] = Array(n).fill(undefined);
  let visited = 0;
  const augment = (id: string): boolean => {
    const edges = coverageMask(id);
    for (let available = edges & ~visited; available !== 0; available = edges & ~visited) {
      const bit = available & -available;
      visited |= bit;
      const column = 31 - Math.clz32(bit);
      const incumbent = matched[column];
      if (incumbent !== undefined && !augment(incumbent)) continue;
      matched[column] = id;
      return true;
    }
    return false;
  };
  let rank = 0;
  for (const id of new Set(head)) {
    visited = 0;
    if (augment(id)) rank++;
  }
  return rank;
}

type SlotCandidate = Readonly<{
  slot: number;
  occupant: string;
  occCov: readonly (number | null)[];
  dominated: boolean;
}>;

function hasAnyWitness(occCov: readonly (number | null)[], n: number): boolean {
  for (let d = 0; d < n; d++) if (occCov[d] !== null) return true;
  return false;
}

function passesPossibleGuard(occCov: readonly (number | null)[], n: number, incomingColumn: number,
  isPossible: (d: number) => boolean, incomingWitnessesColumn: boolean): boolean {
  for (let d = 0; d < n; d++) {
    if (occCov[d] !== null || !isPossible(d) || d === incomingColumn && incomingWitnessesColumn) continue;
    return false;
  }
  return true;
}

function isSlotDominated(occCov: readonly (number | null)[], occRel: readonly (number | null)[],
  coverage: StatementAssociation["coverage"], relations: NonNullable<StatementAssociation["relations"]>,
  tailRows: Int32Array, n: number): boolean {
  for (let d = 0; d < n; d++) {
    if (occCov[d] === null) continue;
    let found = false;
    for (let t = 0; t < tailRows.length; t++) {
      const tRow = tailRows[t]!;
      if (tRow < 0) continue;
      const tCov = coverage[tRow]?.[d];
      const tRel = relations[tRow]?.[d];
      if (tCov != null && tCov > occCov[d]! && tRel != null && occRel[d] != null && tRel > occRel[d]!) {
        found = true; break;
      }
    }
    if (!found) return false;
  }
  return true;
}

function vetoesVictim(other: SlotCandidate, victim: SlotCandidate, n: number,
  possible: (id: string, column: number) => boolean): boolean {
  let strictlyWeaker = false;
  for (let d = 0; d < n; d++) {
    const oVal = other.occCov[d]!, sVal = victim.occCov[d]!;
    if ((oVal !== null) !== (sVal !== null)) return false;
    if (possible(other.occupant, d) !== possible(victim.occupant, d)) return false;
    if (sVal !== null) {
      if (oVal! > sVal) return false;
      if (oVal! < sVal) strictlyWeaker = true;
    }
  }
  return strictlyWeaker;
}

function swapHeadTail(head: string[], tail: string[], tailRows: Int32Array, slotDominated: Int8Array,
  rootRow: ReadonlyMap<string, number>, slot: number, at: number): void {
  const displaced = head[slot]!;
  head[slot] = tail[at]!;
  tail[at] = displaced;
  tailRows[at] = rootRow.get(displaced) ?? -1;
  slotDominated.fill(-1);
}

function gcdBig(a: bigint, b: bigint): bigint {
  while (b !== 0n) { const t = a % b; a = b; b = t; }
  return a;
}

function matchQuantileAssignment(uniquePool: readonly string[], posMap: ReadonlyMap<string, number>,
  ranks: readonly (readonly string[])[], marginal: readonly (string | null)[], n: number) {
  const rankTable = new Int32Array(uniquePool.length * n).fill(-1);
  let commonDenomBig = 1n;
  for (let column = 0; column < n; column++) {
    const ranked = ranks[column]!, len = BigInt(ranked.length);
    if (len > 0n) commonDenomBig = (commonDenomBig / gcdBig(commonDenomBig, len)) * len;
    for (let rank = 0; rank < ranked.length; rank++) {
      const cell = posMap.get(ranked[rank]!)! * n + column;
      if (rankTable[cell]! < 0) rankTable[cell] = rank;
    }
  }
  if (BigInt(n) * commonDenomBig <= BigInt(Number.MAX_SAFE_INTEGER)) {
    const scale = Number(commonDenomBig);
    const scaledQuantile = (id: string, column: number): number | null => {
      const pos = posMap.get(id);
      if (pos === undefined) return null;
      const rank = rankTable[pos * n + column]!;
      const m = ranks[column]!.length;
      return rank < 0 ? null : (m - rank) * (scale / m);
    };
    return injectiveConditionWitnessAssignment(uniquePool, ranks, scaledQuantile) ?? {
      roots: marginal, count: marginal.filter(Boolean).length,
      weight: marginal.reduce((sum, id, column) => sum + (id === null ? 0 : scaledQuantile(id, column)!), 0),
      marginal, identity: "root" as const
    };
  }
  return exactBigIntAssignment(uniquePool, ranks, posMap, rankTable, marginal, commonDenomBig, n);
}

function exactBigIntAssignment(uniquePool: readonly string[], ranks: readonly (readonly string[])[],
  posMap: ReadonlyMap<string, number>, rankTable: Int32Array, marginal: readonly (string | null)[],
  commonDenomBig: bigint, n: number) {
  const present = marginal.filter((id): id is string => id !== null);
  const units = ranks.map(row => row.length > 0 ? commonDenomBig / BigInt(row.length) : 0n);
  if (new Set(present).size === present.length) {
    const weight = marginal.reduce((sum, id, column) =>
      sum + (id === null ? 0n : BigInt(ranks[column]!.length) * units[column]!), 0n);
    return { roots: marginal, count: present.length, weight: Number(weight), marginal, identity: "root" as const };
  }
  const masks = 1 << n, size = uniquePool.length;
  const counts = new Int32Array(masks).fill(-1);
  const weights: bigint[] = Array.from({ length: masks }, () => 0n);
  const assigned: Array<(string | null)[] | undefined> = Array.from({ length: masks }, () => undefined);
  counts[0] = 0;
  assigned[0] = Array.from({ length: n }, () => null);
  for (let itemPos = 0; itemPos < size; itemPos++) {
    const id = uniquePool[itemPos]!;
    for (let mask = masks - 2; mask >= 0; mask--) {
      const count = counts[mask]!;
      if (count < 0) continue;
      for (let column = 0; column < n; column++) {
        if ((mask & (1 << column)) !== 0) continue;
        const rank = rankTable[itemPos * n + column]!;
        if (rank < 0) continue;
        const nextMask = mask | (1 << column);
        const candCount = count + 1, incCount = counts[nextMask]!;
        const candWeight = weights[mask]! + BigInt(ranks[column]!.length - rank) * units[column]!;
        if (incCount < 0 || candCount > incCount || candCount === incCount && candWeight >= weights[nextMask]!) {
          const candRoots = assigned[mask]!.slice();
          candRoots[column] = id;
          if (candCount > incCount || candWeight > weights[nextMask]!
              || sourceEarlier(posMap, size, candRoots, assigned[nextMask]!)) {
            counts[nextMask] = candCount; weights[nextMask] = candWeight; assigned[nextMask] = candRoots;
          }
        }
      }
    }
  }
  let bestMask = 0;
  for (let mask = 1; mask < masks; mask++) {
    const count = counts[mask]!;
    if (count < 0) continue;
    if (count > counts[bestMask]! || count === counts[bestMask]! && (weights[mask]! > weights[bestMask]!
        || weights[mask]! === weights[bestMask]! && sourceEarlier(posMap, size, assigned[mask]!, assigned[bestMask]!))) {
      bestMask = mask;
    }
  }
  return {
    roots: assigned[bestMask]!, count: counts[bestMask]!, weight: Number(weights[bestMask]!),
    marginal, identity: "root" as const
  };
}
