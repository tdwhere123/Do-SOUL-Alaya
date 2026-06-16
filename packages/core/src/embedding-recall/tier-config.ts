import { StorageTier } from "@do-soul/alaya-protocol";

const EMBEDDING_RECALL_TIERS_ENV = "ALAYA_EMBEDDING_RECALL_TIERS";
const DEFAULT_EMBEDDING_RECALL_TIERS: readonly StorageTier[] = [
  StorageTier.HOT,
  StorageTier.WARM
];
const VALID_TIERS: readonly StorageTier[] = [
  StorageTier.HOT,
  StorageTier.WARM,
  StorageTier.COLD
];

// Storage tiers the embedding recall path covers: backfill writes vectors for
// them and the coarse-injection scan reads them. Default HOT+WARM so a vocab-
// disjoint gold demoted to WARM still carries a vector and can be injected;
// override via ALAYA_EMBEDDING_RECALL_TIERS (e.g. "hot" to narrow back to the
// hot-only cascade, "hot,warm,cold" to widen). StorageTier values ARE the
// lowercase tier names the scan tierFilter expects, so one list serves both.
export function resolveEmbeddingRecallTiers(): readonly StorageTier[] {
  const raw = process.env[EMBEDDING_RECALL_TIERS_ENV];
  if (raw === undefined || raw.trim() === "") {
    return DEFAULT_EMBEDDING_RECALL_TIERS;
  }
  const parsed = raw
    .split(",")
    .map((token) => token.trim().toLowerCase())
    .filter((token): token is StorageTier =>
      VALID_TIERS.includes(token as StorageTier)
    );
  return parsed.length > 0
    ? [...new Set(parsed)]
    : DEFAULT_EMBEDDING_RECALL_TIERS;
}
