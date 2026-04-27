import type { PathAnchorRef, PathRelation, TopologyEdge, TopologyNode, TopologyProjection } from "./types.js";
import { serializePathAnchorRef, validatePathRelation } from "./validation.js";

export function projectReadOnlyTopology(pathRelations: readonly PathRelation[]): TopologyProjection {
  const nodes = new Map<string, TopologyNode>();
  const edges: TopologyEdge[] = [];

  for (const relation of pathRelations.map(validatePathRelation).filter((entry) => entry.lifecycle.state === "active")) {
    const source = ensureNode(nodes, relation.anchors.source_anchor);
    const target = ensureNode(nodes, relation.anchors.target_anchor);
    edges.push({
      id: relation.path_id,
      source: source.id,
      target: target.id,
      relation_kind: relation.constitution.relation_kind,
      source_path_id: relation.path_id,
      governance_class: relation.legitimacy.governance_class
    });
  }

  return Object.freeze({
    derived_from: "active_path_relation",
    nodes: Object.freeze([...nodes.values()].sort((left, right) => left.id.localeCompare(right.id))),
    edges: Object.freeze(edges.sort((left, right) => left.id.localeCompare(right.id)))
  });
}

function ensureNode(nodes: Map<string, TopologyNode>, anchor: PathAnchorRef): TopologyNode {
  const id = serializePathAnchorRef(anchor);
  const existing = nodes.get(id);
  if (existing !== undefined) {
    return existing;
  }
  const node: TopologyNode = {
    id,
    kind: anchor.kind,
    source_ref: anchor
  };
  nodes.set(id, node);
  return node;
}
