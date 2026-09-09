import type { RecallFusionStream } from "../runtime/recall-service-types.js";

export const RECALL_FUSION_STREAMS: readonly RecallFusionStream[] = [
  "lexical_fts", "trigram_fts", "synthesis_fts", "evidence_fts",
  "evidence_structural_agreement", "source_proximity", "source_evidence_agreement", "subject_alignment",
  "structural", "existing_score", "embedding_similarity", "graph_expansion",
  "entity_seed", "path_expansion", "temporal_recency", "workspace_activation"
];
