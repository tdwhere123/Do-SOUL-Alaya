import { type AdjacencyRow, type NamedKindOverlay } from "./path-matching.js";

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
  return scanAdjacencyPairs({ size: subjectList.length, at: (index) => subjectList[index] }, predicates, pairProgress,
    pairIndex, subjectList.length * predicates.length).pair;
}

export function scanAdjacencyPairs(subjects: Readonly<{ size: number; at(index: number): string | undefined }>,
  predicates: readonly string[], pairProgress: Readonly<{ has(id: string): boolean }>, start: number, allowance: number): Readonly<{
    pair?: Readonly<{ subject: string; predicate: string }>; next: number; work: number;
  }> {
  const total = subjects.size * predicates.length;
  let work = 0;
  for (; work < Math.min(total, allowance);) {
    const index = (start + work) % total;
    const subject = subjects.at(Math.floor(index / predicates.length))!;
    const predicate = predicates[index % predicates.length]!;
    work += 1;
    if (!pairProgress.has(`${pairKey(subject, predicate)}:done`)) {
      return { pair: { subject, predicate }, next: index + 1, work };
    }
  }
  return { next: total === 0 ? 0 : (start + work) % total, work };
}

export function hasOpenPairs(
  subjects: ReadonlySet<string>,
  predicates: readonly string[],
  pairProgress: ReadonlyMap<string, string | null>,
  discoveries: readonly RoutingDiscovery[] = [],
  completedPairs?: number
): boolean {
  if (completedPairs !== undefined) return completedPairs < subjects.size * predicates.length;
  return nextAdjacencyPair(subjects, predicates, pairProgress, 0, discoveries) !== undefined;
}
