import { createHash } from "node:crypto";

export const SHADOW_ALGORITHM_ID =
  "alaya.recall.shadow.d0.safe-dominance-capture.v1";
export const SHADOW_ALGORITHM_VERSION = "d0.safe-dominance-capture.v1.0.0";
export const D0_IDENTITY_BLOB_ID = "alaya.recall.shadow.d0.identity.v1";
export const SHADOW_PSI_OPERATOR_ID = "shadow.psi.safe_dominance.v1";
export const SHADOW_FRONTIER_OPERATOR_ID = "shadow.frontiers.peel_undominated.v1";
export const SHADOW_CAPTURE_OPERATOR_ID = "shadow.select_gamma.lexicographic_set.v1";

const D0_IDENTITY_LINES = [
  "alaya.recall.shadow.d0.identity.v1",
  "algorithm_id: alaya.recall.shadow.d0.safe-dominance-capture.v1",
  "version: d0.safe-dominance-capture.v1.0.0",
  "LexDomain: (lane_id, list_n, status, raw_key_kind)",
  "lane_id: exact | porter | trigram | object_key_porter | object_key_trigram",
  "list_n: nat",
  "status: empty | complete | truncated",
  "raw_key_kind: matched_token_count | bm25_raw_rank",
  "Cmp_lexical.skip: both states equal and both in {not_applicable, not_observed, producer_unavailable}",
  "Cmp_lexical.incomparable: mixed states, OR both observed with LexDomain(u) != LexDomain(v)",
  "Cmp_lexical.comparable: both observed AND LexDomain(u) = LexDomain(v)",
  "Cmp_lexical.numeric: higher-is-better grouped_ordinal of the merge-chosen lane; equal ordinal => channel-equal",
  "lineages: lexical | embedding | temporal | subject_preference",
  "Gamma_kinds: unscaled_remainder | Values_v | evidence_novelty_redundancy"
] as const;

export const D0_IDENTITY_BLOB = `${D0_IDENTITY_LINES.join("\n")}\n`;

export const D0_IDENTITY_DIGEST =
  "8f287df50610b28a3b40921b9bce765164794d6d4afd17c246e6807e768773fa";

export function hashD0IdentityBlob(blob: string = D0_IDENTITY_BLOB): string {
  return createHash("sha256").update(blob, "utf8").digest("hex");
}
