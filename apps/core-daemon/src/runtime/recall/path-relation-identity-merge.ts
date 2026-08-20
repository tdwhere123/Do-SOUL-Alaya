import {
  pathRelationMatchesIdentity,
  type PathRelation
} from "@do-soul/alaya-protocol";

export function mergePathRelationsByIdentity(
  authoritative: readonly Readonly<PathRelation>[],
  associative: readonly Readonly<PathRelation>[]
): readonly Readonly<PathRelation>[] {
  const merged = [...authoritative];
  for (const candidate of associative) {
    if (!merged.some((path) => pathRelationMatchesIdentity(path, {
      sourceAnchor: candidate.anchors.source_anchor,
      targetAnchor: candidate.anchors.target_anchor,
      relationKind: candidate.constitution.relation_kind,
      recallBias: candidate.effect_vector.recall_bias
    }))) {
      merged.push(candidate);
    }
  }
  return Object.freeze(merged);
}
