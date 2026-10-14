/** Finite denotation over plain relations; no production compiler, unifier or proof evaluator. */
export type FiniteExpression =
  | Readonly<{ kind: "empty" }>
  | Readonly<{ kind: "epsilon" }>
  | Readonly<{ kind: "atom"; relation: string; source: string; target: string; inverse?: boolean;
      threshold?: number; guard?: Readonly<{ variable: string; scope: string }> }>
  | Readonly<{ kind: "sequence"; terms: readonly FiniteExpression[] }>
  | Readonly<{ kind: "alternative"; terms: readonly FiniteExpression[] }>
  | Readonly<{ kind: "and"; terms: readonly FiniteExpression[] }>;

export type FiniteRelation = Readonly<{
  id: string; source: string; target: string; predicate: string; revision: string;
  valid_from: string; valid_to?: string;
}>;
export type FiniteSource = Readonly<{ revision: string; scope?: string; valid_from?: string; valid_to?: string }>;
type FiniteSeed = Readonly<{ object: string; hypothesis: string; bindings: Readonly<Record<string, string>> }>;
export type FiniteWorld = Readonly<{
  rows: readonly FiniteRelation[]; sources: Readonly<Record<string, FiniteSource>>;
  seeds: readonly FiniteSeed[]; asOf: string; authorizedScopes: readonly string[] | null; contractId: string;
}>;
export type QualifiedResult = Readonly<{
  anchor: string | null;
  target: Readonly<{ kind: "memory_entry"; workspace_id: string; object_id: string; source_revision: string }>;
  hypothesis: string; bindings: readonly (readonly [string, string])[]; time_state: string;
  grade: number; cap_contract_id: string | undefined; supports: readonly (readonly string[])[];
}>;
type Assignment = Readonly<{ endpoint: string; bindings: Readonly<Record<string, string>>; leaves: readonly string[] }>;

export function finiteExpressionDenotation(expression: FiniteExpression, world: FiniteWorld): Readonly<{
  results: readonly QualifiedResult[]; unresolvedGuard: boolean;
}> {
  let unresolvedGuard = false, visits = 0;
  const results: QualifiedResult[] = [];
  const active = (validity: { valid_from?: string; valid_to?: string }) =>
    (validity.valid_from === undefined || validity.valid_from <= world.asOf) &&
    (validity.valid_to === undefined || world.asOf < validity.valid_to);
  const eligible = (id: string) => {
    const source = world.sources[id];
    if (source === undefined) throw new Error(`finite source metadata missing: ${id}`);
    return active(source) && (world.authorizedScopes === null ||
      (source.scope !== undefined && world.authorizedScopes.includes(source.scope)));
  };
  const evaluate = (node: FiniteExpression, entry: Assignment): Assignment[] => {
    if (++visits > 10_000) throw new Error("finite expression visit bound exceeded");
    if (node.kind === "empty") return [];
    if (node.kind === "epsilon") return [entry];
    if (node.kind === "alternative") return node.terms.flatMap((term) => evaluate(term, entry));
    if (node.kind === "sequence") return node.terms.reduce<Assignment[]>((current, term) =>
      current.flatMap((assignment) => evaluate(term, assignment)), [entry]);
    if (node.kind === "and") {
      const groups = node.terms.map((term) => evaluate(term, entry));
      if (groups.length === 0) throw new Error("empty AND is outside the finite reference fragment");
      return groups.slice(1).reduce<Assignment[]>((joined, group) => joined.flatMap((left) => group.flatMap((right) => {
        const bindings = mergeBindings(left.bindings, right.bindings);
        // This fragment declares one shared result endpoint for all conjuncts.
        return bindings === undefined || left.endpoint !== right.endpoint ? [] : [{ endpoint: left.endpoint,
          bindings, leaves: [...new Set([...left.leaves, ...right.leaves])] }];
      })), groups[0]!.slice());
    }
    const matches: Assignment[] = [];
    for (const row of world.rows) {
      const from = node.inverse ? row.target : row.source, to = node.inverse ? row.source : row.target;
      if (row.predicate !== node.relation || from !== entry.endpoint || !active(row) || !eligible(to)) continue;
      const bindings = mergeBindings(entry.bindings, { [node.source]: from });
      const output = bindings === undefined ? undefined : mergeBindings(bindings, { [node.target]: to });
      if (output === undefined || 1000 <= (node.threshold ?? 0)) continue;
      if (node.guard !== undefined) {
        const object = output[node.guard.variable], scope = object === undefined ? undefined : world.sources[object]?.scope;
        if (scope === undefined) { unresolvedGuard = true; continue; }
        if (scope !== node.guard.scope) continue;
      }
      matches.push({ endpoint: to, bindings: output,
        leaves: [...new Set([...entry.leaves, JSON.stringify([row.id, row.revision])])] });
    }
    return matches;
  };
  for (const seed of world.seeds) {
    if (!eligible(seed.object)) continue;
    for (const assignment of evaluate(expression, { endpoint: seed.object, bindings: seed.bindings, leaves: [] })) {
      results.push({ anchor: assignment.bindings.x ?? null,
        target: { kind: "memory_entry", workspace_id: "ws", object_id: assignment.endpoint,
          source_revision: world.sources[assignment.endpoint]!.revision },
        hypothesis: seed.hypothesis, bindings: Object.entries(assignment.bindings).sort(([a], [b]) => a.localeCompare(b)),
        time_state: world.asOf, grade: 1000, cap_contract_id: world.contractId,
        supports: [[...assignment.leaves].sort()] });
    }
  }
  return { results: coalesceQualifiedResults(results), unresolvedGuard };
}

function mergeBindings(left: Readonly<Record<string, string>>, right: Readonly<Record<string, string>>) {
  for (const [key, value] of Object.entries(right)) if (left[key] !== undefined && left[key] !== value) return undefined;
  return { ...left, ...right };
}

/** Canonical comparison only; never collapses a disjunction into one union of leaves. */
export function coalesceQualifiedResults(rows: readonly QualifiedResult[]): QualifiedResult[] {
  const groups = new Map<string, { row: Omit<QualifiedResult, "supports">; supports: Set<string> }>();
  for (const { supports, ...row } of rows) {
    const key = JSON.stringify(row);
    let group = groups.get(key);
    if (group === undefined) { group = { row, supports: new Set() }; groups.set(key, group); }
    for (const leaves of supports) group.supports.add(JSON.stringify([...new Set(leaves)].sort()));
  }
  return [...groups.values()].map(({ row, supports }) => ({ ...row,
    supports: [...supports].sort().map((value) => JSON.parse(value) as string[]) }))
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}
