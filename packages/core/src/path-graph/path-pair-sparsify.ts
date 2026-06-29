// Shared pair-graph sparsification for edge producers (coherence, answers_with):
// per-node cap + cross-session gate over canonical `${low}|${high}` keys, so a
// dense cluster cannot flood the path graph. Pure set math; no DB/embedding.

export function buildSessionMap(
  objects: readonly { readonly objectId: string; readonly sessionId?: string | null }[]
): ReadonlyMap<string, string | null> {
  return new Map(objects.map((object) => [object.objectId, object.sessionId ?? null] as const));
}

export function splitPairKey(pairKey: string): readonly [string, string] {
  const separator = pairKey.indexOf("|");
  return [pairKey.slice(0, separator), pairKey.slice(separator + 1)] as const;
}

// Cap each node to its lexicographically-first `capPerNode` partners (deterministic),
// dropping same-session pairs when crossSessionOnly. Returns canonical `${low}|${high}` keys.
export function sparsifyPairs(
  pairs: ReadonlySet<string>,
  sessionById: ReadonlyMap<string, string | null>,
  capPerNode: number,
  crossSessionOnly: boolean
): ReadonlySet<string> {
  const partners = new Map<string, string[]>();
  const addPartner = (node: string, partner: string): void => {
    const list = partners.get(node);
    if (list === undefined) {
      partners.set(node, [partner]);
    } else {
      list.push(partner);
    }
  };
  for (const pairKey of pairs) {
    const sep = pairKey.indexOf("|");
    if (sep < 0) {
      continue;
    }
    const a = pairKey.slice(0, sep);
    const b = pairKey.slice(sep + 1);
    if (crossSessionOnly && sessionById.get(a) === sessionById.get(b)) {
      continue;
    }
    addPartner(a, b);
    addPartner(b, a);
  }
  const kept = new Set<string>();
  const cap = Math.max(0, capPerNode);
  for (const [node, list] of partners) {
    for (const partner of [...list].sort().slice(0, cap)) {
      const [low, high] = node < partner ? [node, partner] : [partner, node];
      kept.add(`${low}|${high}`);
    }
  }
  return kept;
}
