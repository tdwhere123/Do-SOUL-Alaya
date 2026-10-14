type DerivationNode = Readonly<{
  derivation_id: string;
  kind: string;
  children: readonly string[];
}>;

/** Expands the delivered proof grammar without a production evaluator. */
export function createDerivationAlternativeExpander<T extends DerivationNode>(
  rows: ReadonlyMap<string, T>,
  localKeys: (row: T) => Iterable<string>
): (id: string) => Set<string>[] {
  let visits = 0;
  const expand = (id: string, active = new Set<string>()): Set<string>[] => {
    if (++visits > 100000) throw new Error("independent proof expansion bound exceeded");
    if (active.has(id)) throw new Error("cyclic delivered proof");
    const row = rows.get(id);
    if (row === undefined) throw new Error("missing delivered derivation");
    const next = new Set(active).add(id);
    const local = new Set(localKeys(row));
    if (row.children.length === 0) return [local];
    const children = row.children.map((child) => expand(child, next));
    if (row.kind === "or") return children.flat().map((set) => new Set([...local, ...set]));
    return children.reduce<Set<string>[]>((acc, options) => {
      if (acc.length * options.length > 10000) throw new Error("independent proof product bound exceeded");
      return acc.flatMap((set) => options.map((option) => new Set([...set, ...option])));
    }, [local]);
  };
  return expand;
}
