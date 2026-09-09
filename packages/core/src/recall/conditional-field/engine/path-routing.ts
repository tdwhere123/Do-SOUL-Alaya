import type { AdjacencyRow, NamedKindOverlay } from "./path-matching.js";

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
