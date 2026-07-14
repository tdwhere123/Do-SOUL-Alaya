import type { MemoryEntry } from "@do-soul/alaya-protocol";
import { recallEnvFlagEnabled } from "../../config/recall-env-access.js";
import type { RecallFusionStream } from "../runtime/recall-service-types.js";

export const RECALL_FUSION_STREAMS: readonly RecallFusionStream[] = [
  "lexical_fts", "trigram_fts", "synthesis_fts", "evidence_fts",
  "evidence_structural_agreement", "source_proximity", "source_evidence_agreement", "subject_alignment",
  "structural", "existing_score", "embedding_similarity", "graph_expansion",
  "entity_seed", "path_expansion", "temporal_recency", "workspace_activation",
  "facet_overlap"
];

// Per-lane weights are identity inside families; objectBase sums one max-vote per family
// (see fusion-delivery-families.ts). Bench-fitted embedding_similarity=12 is retired —
// the semantic family's equal vote replaces that constant, not a retuned substitute.
// temporal_recency / workspace_activation stay 0 until intent/policy enables them.
export const RECALL_FUSION_DEFAULT_WEIGHTS: Readonly<Record<RecallFusionStream, number>> = Object.freeze({
  lexical_fts: 1, trigram_fts: 1, synthesis_fts: 1, evidence_fts: 1,
  evidence_structural_agreement: 1, source_proximity: 1, source_evidence_agreement: 1, subject_alignment: 1,
  structural: 1, existing_score: 1, embedding_similarity: 1, graph_expansion: 1,
  entity_seed: 1, path_expansion: 1, temporal_recency: 0, workspace_activation: 0,
  facet_overlap: 1
});

export function facetSliceEnabled(): boolean {
  return recallEnvFlagEnabled("ALAYA_RECALL_FACET_SLICE");
}

export function activeFusionStreams(): readonly RecallFusionStream[] {
  return RECALL_FUSION_STREAMS;
}

export function facetOverlapCountFor(
  entry: Readonly<MemoryEntry>,
  querySoughtFacets: readonly string[] | undefined
): number {
  if (querySoughtFacets === undefined || querySoughtFacets.length === 0) {
    return 0;
  }
  const sought = new Set(querySoughtFacets);
  const matched = new Set<string>();
  for (const tag of entry.facet_tags ?? []) {
    if (sought.has(tag.facet)) {
      matched.add(tag.facet);
    }
  }
  return matched.size;
}
