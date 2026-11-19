import { SourceSemanticResourceLedger, type SourceSemanticResourceBudget } from "@do-soul/alaya-protocol";
import type { StatementAssociation } from "./statement-association.js";

type Assignment = Readonly<{ roots: readonly (string | null)[]; count: number; weight: number }>;

function sourceEarlier(pool: readonly string[], left: readonly (string | null)[], right: readonly (string | null)[]): boolean {
  for (let column = 0; column < left.length; column++) {
    const a = left[column] === null ? pool.length : pool.indexOf(left[column]!);
    const b = right[column] === null ? pool.length : pool.indexOf(right[column]!);
    if (a !== b) return a < b;
  }
  return false;
}

function better(pool: readonly string[], candidate: Assignment, incumbent: Assignment | undefined): boolean {
  return incumbent === undefined || candidate.count > incumbent.count || candidate.count === incumbent.count
    && (candidate.weight > incumbent.weight || candidate.weight === incumbent.weight
      && sourceEarlier(pool, candidate.roots, incumbent.roots));
}

/** Exact bitmask assignment of distinct pool roots to conditions; n is at most 5. */
export function injectiveConditionWitnessAssignment(pool: readonly string[],
  ranks: readonly (readonly string[])[], value: (id: string, column: number) => number | null): Assignment & {
  marginal: readonly (string | null)[]; identity: "root";
} | undefined {
  const n = ranks.length;
  if (n > 5) return undefined;
  const marginal = ranks.map(row => row[0] ?? null);
  const present = marginal.filter((id): id is string => id !== null);
  if (new Set(present).size === present.length) return undefined;
  const groups = new Map<string, string[]>();
  for (const id of pool) {
    const members = groups.get(id) ?? [];
    if (!groups.has(id)) groups.set(id, members);
    members.push(id);
  }
  let dp = new Map<number, Assignment>([[0, { roots: Array(n).fill(null), weight: 0, count: 0 }]]);
  for (const ids of groups.values()) {
    const next = new Map(dp);
    for (const [mask, row] of dp) {
      for (let column = 0; column < n; column++) {
        if (mask & (1 << column)) continue;
        for (const id of ids) {
          const weight = value(id, column);
          if (weight === null) continue;
          const roots = row.roots.slice() as (string | null)[];
          roots[column] = id;
          const candidate: Assignment = { roots, count: row.count + 1, weight: row.weight + weight };
          const nextMask = mask | (1 << column);
          if (better(pool, candidate, next.get(nextMask))) next.set(nextMask, candidate);
        }
      }
    }
    dp = next;
  }
  let best: Assignment | undefined;
  for (const row of dp.values()) if (better(pool, row, best)) best = row;
  return best === undefined ? undefined : { ...best, marginal, identity: "root" };
}

/** Conservative upper bound: rank sorting, DP transitions/allocations/tie-breaks, tail dominance.
 * Zero when the caller has already established that relations are absent. */
export function quoteStatementParetoExchange(roots: number, statements: number): SourceSemanticResourceBudget {
  if (roots < 1 || statements < 1) return { work_units: 0, memory_bytes: 0 };
  const n = Math.min(statements, 5);
  return {
    work_units: roots * n + (1 << n) * n * roots + 4 * n * roots,
    memory_bytes: roots * n * 16 + (1 << n) * n * roots
  };
}

export function exchangeStatementParetoSecondary(input: Readonly<{
  association: StatementAssociation; pool: readonly string[]; head: string[]; tail: string[];
  agreed: readonly string[]; meter: SourceSemanticResourceLedger;
}>): boolean {
  const { association, pool, head, tail, agreed, meter } = input;
  const relations = association.relations;
  if (relations === undefined || relations.every(row => row.every(value => value === null))) return false;
  const n = association.statements;
  const quote = quoteStatementParetoExchange(pool.length, n);
  meter.charge(quote.work_units, quote.memory_bytes, "statement relation witness exchange");
  const index = new Map(association.roots.map((id, row) => [id, row]));
  const coverage = (id: string, column: number) => {
    const row = index.get(id); return row === undefined ? null : association.coverage[row]![column]!;
  };
  const relation = (id: string, column: number) => {
    const row = index.get(id); return row === undefined ? null : relations[row]![column]!;
  };
  const possible = (id: string, column: number) => association.possible?.[index.get(id) ?? -1]?.[column] === true;
  const ranks = Array.from({ length: n }, (_, column) => pool.filter(id => coverage(id, column) !== null)
    .sort((left, right) => coverage(right, column)! - coverage(left, column)! || pool.indexOf(left) - pool.indexOf(right)));
  const marginal = ranks.map(row => row[0] ?? null);
  const match = n >= 2 ? injectiveConditionWitnessAssignment(pool, ranks, coverage) ?? {
    roots: marginal, count: marginal.filter(Boolean).length,
    weight: marginal.reduce((sum, id, column) => sum + (id === null ? 0 : coverage(id, column)!), 0),
    marginal, identity: "root" as const
  } : null;
  const placed = new Set((match?.roots ?? []).filter((id): id is string => id !== null && head.includes(id)));
  let exchanged = false;

  const tryPlace = (incoming: string, column: number): boolean => {
    const at = tail.indexOf(incoming);
    if (at < 0) return false;
    for (let slot = head.length - 1; slot >= 1; slot--) {
      const occupant = head[slot]!;
      if (agreed.includes(occupant) || marginal.includes(occupant) || placed.has(occupant)) continue;
      const witnessColumns: number[] = [];
      for (let d = 0; d < n; d++) if (coverage(occupant, d) !== null) witnessColumns.push(d);
      if (witnessColumns.length === 0) continue;
      let possibleGuard = true;
      for (let d = 0; d < n; d++) {
        if (coverage(occupant, d) !== null || !possible(occupant, d) || d === column && coverage(incoming, column) !== null) continue;
        possibleGuard = false; break;
      }
      if (!possibleGuard) continue;
      const dominated = witnessColumns.every(d => tail.some(id => coverage(id, d) !== null && coverage(occupant, d) !== null
        && coverage(id, d)! > coverage(occupant, d)! && relation(id, d) !== null && relation(occupant, d) !== null
        && relation(id, d)! > relation(occupant, d)!));
      if (!dominated) continue;
      const displaced = head[slot]!;
      head[slot] = incoming;
      tail[at] = displaced;
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
      tryPlace(candidate, column);
    }
  }
  return exchanged;
}
