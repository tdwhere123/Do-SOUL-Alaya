import { StorageTier } from "@do-soul/alaya-protocol";
import {
  resolveEmbeddingRecallTiersFromConfig
} from "../config/core-config.js";
import { getCoreConfig } from "../config/install-core-config.js";

const DEFAULT_EMBEDDING_RECALL_TIERS: readonly StorageTier[] = [
  StorageTier.HOT,
  StorageTier.WARM
];

// Storage tiers the embedding recall path covers: backfill writes vectors for
// them and the coarse-injection scan reads them. Default HOT+WARM so a vocab-
// disjoint gold demoted to WARM still carries a vector and can be injected;
// override via ALAYA_EMBEDDING_RECALL_TIERS (e.g. "hot" to narrow back to the
// hot-only cascade, "hot,warm,cold" to widen). StorageTier values ARE the
// lowercase tier names the scan tierFilter expects, so one list serves both.
export function resolveEmbeddingRecallTiers(): readonly StorageTier[] {
  return resolveEmbeddingRecallTiersFromConfig(getCoreConfig().embedding);
}

export { DEFAULT_EMBEDDING_RECALL_TIERS };
