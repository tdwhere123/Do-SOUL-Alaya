import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  CAPTURE_IDENTITY_BLOB,
  CAPTURE_IDENTITY_BLOB_ID,
  CAPTURE_IDENTITY_DIGEST,
  hashCaptureIdentityBlob,
  SHADOW_ALGORITHM_ID,
  SHADOW_ALGORITHM_VERSION,
  SHADOW_CAPTURE_OPERATOR_ID,
  SHADOW_DETERMINISTIC_TAIL
} from "../../../../recall/decision/prefix-capture/identity.js";

const PLANTED_BLOB = [
  "alaya.recall.shadow.identity.v1",
  "algorithm_id: alaya.recall.shadow.safe-dominance-capture.v1",
  "version: safe-dominance-capture.v1.0.1",
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
  "Gamma_kinds: unscaled_remainder | Values_v | evidence_novelty_redundancy",
  "deterministic_tail: origin_plane_object_id_code_unit_ascending"
].join("\n") + "\n";

describe("capture identity digest", () => {
  it("hashes the §1.1 blob as UTF-8 LF with a trailing newline", () => {
    expect(CAPTURE_IDENTITY_BLOB_ID).toBe("alaya.recall.shadow.identity.v1");
    expect(CAPTURE_IDENTITY_BLOB).toBe(PLANTED_BLOB);
    expect(CAPTURE_IDENTITY_BLOB.endsWith("\n")).toBe(true);
    expect(CAPTURE_IDENTITY_BLOB.includes("\r")).toBe(false);
    expect(hashCaptureIdentityBlob()).toBe(CAPTURE_IDENTITY_DIGEST);
    expect(createHash("sha256").update(PLANTED_BLOB, "utf8").digest("hex"))
      .toBe(CAPTURE_IDENTITY_DIGEST);
  });

  it("records algorithm, version, and capture operator id from the freeze", () => {
    expect(SHADOW_ALGORITHM_ID).toBe("alaya.recall.shadow.safe-dominance-capture.v1");
    expect(SHADOW_ALGORITHM_VERSION).toBe("safe-dominance-capture.v1.0.1");
    expect(SHADOW_DETERMINISTIC_TAIL).toBe("origin_plane_object_id_code_unit_ascending");
    expect(SHADOW_CAPTURE_OPERATOR_ID).toBe("shadow.select_gamma.lexicographic_set.v1");
  });
});
