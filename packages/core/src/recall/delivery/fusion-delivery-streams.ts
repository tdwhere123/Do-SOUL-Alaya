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

export const RECALL_FUSION_DEFAULT_WEIGHTS: Readonly<Record<RecallFusionStream, number>> = Object.freeze({
  lexical_fts: 3, trigram_fts: 1, synthesis_fts: 1, evidence_fts: 3,
  evidence_structural_agreement: 6, source_proximity: 1, source_evidence_agreement: 1, subject_alignment: 1,
  structural: 1, existing_score: 1, embedding_similarity: 12, graph_expansion: 3,
  entity_seed: 1, path_expansion: 3, temporal_recency: 0, workspace_activation: 0,
  facet_overlap: 4
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
