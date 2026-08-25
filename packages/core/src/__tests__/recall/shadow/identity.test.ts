import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  D0_IDENTITY_BLOB,
  D0_IDENTITY_BLOB_ID,
  D0_IDENTITY_DIGEST,
  hashD0IdentityBlob,
  SHADOW_ALGORITHM_ID,
  SHADOW_ALGORITHM_VERSION,
  SHADOW_CAPTURE_OPERATOR_ID,
  SHADOW_FRONTIER_OPERATOR_ID,
  SHADOW_PSI_OPERATOR_ID
} from "../../../recall/shadow/index.js";

const PLANTED_BLOB = [
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
].join("\n") + "\n";

describe("D0 identity digest", () => {
  it("hashes the §1.1 blob as UTF-8 LF with a trailing newline", () => {
    expect(D0_IDENTITY_BLOB_ID).toBe("alaya.recall.shadow.d0.identity.v1");
    expect(D0_IDENTITY_BLOB).toBe(PLANTED_BLOB);
    expect(D0_IDENTITY_BLOB.endsWith("\n")).toBe(true);
    expect(D0_IDENTITY_BLOB.includes("\r")).toBe(false);
    expect(hashD0IdentityBlob()).toBe(D0_IDENTITY_DIGEST);
    expect(createHash("sha256").update(PLANTED_BLOB, "utf8").digest("hex"))
      .toBe(D0_IDENTITY_DIGEST);
  });

  it("records algorithm, version, and operator ids from the freeze", () => {
    expect(SHADOW_ALGORITHM_ID).toBe("alaya.recall.shadow.d0.safe-dominance-capture.v1");
    expect(SHADOW_ALGORITHM_VERSION).toBe("d0.safe-dominance-capture.v1.0.0");
    expect(SHADOW_PSI_OPERATOR_ID).toBe("shadow.psi.safe_dominance.v1");
    expect(SHADOW_FRONTIER_OPERATOR_ID).toBe("shadow.frontiers.peel_undominated.v1");
    expect(SHADOW_CAPTURE_OPERATOR_ID).toBe("shadow.select_gamma.lexicographic_set.v1");
  });
});
