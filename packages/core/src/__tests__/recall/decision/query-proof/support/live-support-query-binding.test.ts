import { describe, expect, it } from "vitest";
import {
  createCanonicalQueryV1,
  digestCanonicalQueryV1
} from "../../../../../recall/query/canonical-query/index.js";
import {
  bindLiveSupportHypothesisDigest,
  liveSupportReceiptsMatchProjection,
  projectLiveSupportCandidateReceipts,
  supportReceiptBindsCurrentQuery
} from "../../../../../recall/decision/query-proof/support/live-support-receipts.js";
import type { SupportCandidateReceiptV1 } from
  "../../../../../recall/decision/query-proof/support/index.js";
import { evidenceCandidate } from "../../../delivery/canonical-delivery-fixtures.js";
import { supplementary } from "../../../integration/shadow/live-receipt-fixtures.js";

const HYPOTHESIS = createCanonicalQueryV1({
  variables: [{ name: "x0", sort: "entity" }],
  constants: [{ name: "alice", sort: "entity", value: "person.alice" }],
  predicates: [{
    id: "prop.works-at",
    relation: "works_at",
    arguments: ["alice", "x0"]
  }],
  answer: { kind: "scalar", variable: "x0" }
});

const COMPILATION = { hypotheses: [HYPOTHESIS] };

const BOUND_RECEIPT: SupportCandidateReceiptV1 = Object.freeze({
  candidate_key: "workspace_local:memory_entry:cand-a",
  hypothesis_digest: digestCanonicalQueryV1(HYPOTHESIS),
  osf: {
    composition_status: "composed",
    truncated: false,
    bindings: [{
      variable_id: "x",
      binding_identity: "arg.person",
      semantic_identity: "person.alice",
      evidence_id: "eu-1",
      query_proposition_id: "prop.works-at"
    }]
  },
  fact_frames: [{ semantic_identity: "person.alice", role: "entity", evidence_id: "eu-1" }],
  evidence_ids: ["eu-1"]
});

describe("live support query binding", () => {
  it("binds only the current compilation hypothesis and matching live projection", () => {
    const digest = digestCanonicalQueryV1(HYPOTHESIS);
    expect(bindLiveSupportHypothesisDigest(COMPILATION, BOUND_RECEIPT)).toBe(digest);
    expect(supportReceiptBindsCurrentQuery(BOUND_RECEIPT, COMPILATION)).toBe(true);
    expect(bindLiveSupportHypothesisDigest(COMPILATION, {
      ...BOUND_RECEIPT,
      osf: {
        ...BOUND_RECEIPT.osf!,
        bindings: [{
          ...BOUND_RECEIPT.osf!.bindings![0]!,
          query_proposition_id: "prop.other"
        }]
      }
    })).toBeUndefined();
    expect(supportReceiptBindsCurrentQuery({
      ...BOUND_RECEIPT,
      hypothesis_digest: `sha256:${"1".repeat(64)}`
    }, COMPILATION)).toBe(false);
    expect(liveSupportReceiptsMatchProjection([BOUND_RECEIPT], [BOUND_RECEIPT])).toBe(true);
    expect(liveSupportReceiptsMatchProjection([BOUND_RECEIPT], [{
      ...BOUND_RECEIPT,
      evidence_ids: ["eu-forged"]
    }])).toBe(false);
    expect(liveSupportReceiptsMatchProjection([BOUND_RECEIPT], [{
      ...BOUND_RECEIPT,
      polarity: {
        status: "available",
        value: { polarity: "positive", lineage_id: "lin-forged" }
      }
    }])).toBe(false);
    expect(liveSupportReceiptsMatchProjection([BOUND_RECEIPT], [{
      ...BOUND_RECEIPT,
      path: { evidence_basis: ["eu-1"], relation_kind: "works_at" },
      f3_present: true
    }])).toBe(false);
    expect(liveSupportReceiptsMatchProjection([BOUND_RECEIPT], undefined)).toBe(false);
  });

  it("does not invent a hypothesis digest from live evidence alone", () => {
    const candidates = [evidenceCandidate("cand-a", "evidence-a")];
    expect(projectLiveSupportCandidateReceipts(
      candidates,
      supplementary(candidates),
      COMPILATION
    )).toBeUndefined();
  });

  it("projects the current hypothesis digest onto matching live OSF bindings", () => {
    const candidates = [evidenceCandidate("cand-a", "eu-1")];
    const projected = projectLiveSupportCandidateReceipts(
      candidates,
      {
        ...supplementary(candidates),
        openSemanticFactorComposition: {
          status: "composed",
          truncated: false,
          bindings: [{
            variable_id: "x",
            binding_identity: "arg.person",
            semantic_identity: "person.alice",
            evidence_id: "eu-1",
            query_proposition_id: "prop.works-at"
          }]
        }
      },
      COMPILATION
    );
    expect(projected).toEqual([expect.objectContaining({
      hypothesis_digest: digestCanonicalQueryV1(HYPOTHESIS),
      evidence_ids: ["eu-1"]
    })]);
  });
});
