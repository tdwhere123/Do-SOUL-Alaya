import { inactiveResolution, type AdjacencyRow, type NamedKindOverlay } from "./path-matching.js";

export type RoutingDiscovery = Readonly<{
  readonly source_id: string;
  readonly subject_id: string;
  readonly predicate: string;
  readonly assertion_id: string;
}>;

export type RoutingDiscoveryEffect = Readonly<{
  readonly observation_id: string;
  readonly discovery: RoutingDiscovery;
}>;

export function overlayIsRoutingOnly(
  overlay: NamedKindOverlay,
  predicate: string
): boolean {
  const routing = overlay[predicate];
  return routing !== undefined && routing.role === "routing_only" && routing.applicable;
}

export function routingOverlayKinds(overlay: NamedKindOverlay): readonly string[] {
  const kinds: string[] = [];
  for (const [kind, spec] of Object.entries(overlay)) {
    if (spec.role === "routing_only" && spec.applicable) kinds.push(kind);
  }
  return Object.freeze(kinds);
}

export function routingDiscoveryEffect(
  row: AdjacencyRow,
  overlay: NamedKindOverlay
): readonly RoutingDiscoveryEffect[] {
  if (!overlayIsRoutingOnly(overlay, row.predicate)) return [];
  return [{
    observation_id: `routing:${row.assertionId}`,
    discovery: {
      source_id: row.sourceObjectId,
      subject_id: row.targetObjectId,
      predicate: row.predicate,
      assertion_id: row.assertionId
    }
  }];
}

export function routingFrontierEffects(
  rows: readonly AdjacencyRow[],
  overlay: NamedKindOverlay,
  origins: ReadonlySet<string>
): readonly RoutingDiscoveryEffect[] {
  // Routing-only hops have no ProductState, so later hops cannot wait for a semantic `from`.
  const frontier = new Set(origins);
  const effects: RoutingDiscoveryEffect[] = [];
  const emitted = new Set<string>();
  let grew = true;
  while (grew) {
    grew = false;
    for (const row of rows) {
      if (row.validity === undefined || inactiveResolution(row.resolutionKind)) continue;
      if (emitted.has(row.assertionId) || !frontier.has(row.sourceObjectId)) continue;
      const discovered = routingDiscoveryEffect(row, overlay);
      if (discovered.length === 0) continue;
      emitted.add(row.assertionId);
      effects.push(...discovered);
      if (frontier.has(row.targetObjectId)) continue;
      frontier.add(row.targetObjectId);
      grew = true;
    }
  }
  return Object.freeze(effects);
}

export function mergeDiscoveries(
  current: readonly RoutingDiscovery[],
  incoming: readonly RoutingDiscovery[] = []
): readonly RoutingDiscovery[] {
  const byId = new Map<string, RoutingDiscovery>();
  for (const row of current) byId.set(row.assertion_id, row);
  for (const row of incoming) {
    if (!byId.has(row.assertion_id)) byId.set(row.assertion_id, row);
  }
  return Object.freeze([...byId.values()]);
}

export function pairKey(subject: string, predicate: string): string {
  return `${subject}\0${predicate}`;
}

export function nextAdjacencyPair(
  subjects: ReadonlySet<string>,
  predicates: readonly string[],
  pairProgress: ReadonlyMap<string, string | null>,
  pairIndex: number,
  discoveries: readonly RoutingDiscovery[] = []
): Readonly<{ readonly subject: string; readonly predicate: string }> | undefined {
  const subjectList = [...new Set([...subjects, ...discoveries.map((row) => row.subject_id)])];
  if (subjectList.length === 0 || predicates.length === 0) return undefined;
  const total = subjectList.length * predicates.length;
  for (let offset = 0; offset < total; offset += 1) {
    const index = (pairIndex + offset) % total;
    const subject = subjectList[Math.floor(index / predicates.length)]!;
    const predicate = predicates[index % predicates.length]!;
    if (!pairProgress.has(`${pairKey(subject, predicate)}:done`)) {
      return { subject, predicate };
    }
  }
  return undefined;
}

export function hasOpenPairs(
  subjects: ReadonlySet<string>,
  predicates: readonly string[],
  pairProgress: ReadonlyMap<string, string | null>,
  discoveries: readonly RoutingDiscovery[] = []
): boolean {
  return nextAdjacencyPair(subjects, predicates, pairProgress, 0, discoveries) !== undefined;
}
