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
import {
  OPEN_SEMANTIC_FACTOR_COMPOSITION_OPERATOR_ID,
  type OpenSemanticFactorCompositionReceipt
} from "../../../../../recall/field/open-semantic-factors/composition.js";
import type { RecallFieldDigest } from
  "../../../../../recall/field/field-identity.js";

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

const BOUND_RECEIPT = Object.freeze({
  candidate_key: "workspace_local:memory_entry:cand-a",
  hypothesis_digest: digestCanonicalQueryV1(HYPOTHESIS),
  osf: {
    composition_status: "composed" as const,
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
}) satisfies SupportCandidateReceiptV1;

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
        openSemanticFactorComposition: osfComposition()
      },
      COMPILATION
    );
    expect(projected).toEqual([expect.objectContaining({
      hypothesis_digest: digestCanonicalQueryV1(HYPOTHESIS),
      evidence_ids: ["eu-1"]
    })]);
  });
});

const OSF_DIGEST = `sha256:${"a".repeat(64)}` as RecallFieldDigest;

function osfComposition(): OpenSemanticFactorCompositionReceipt {
  return Object.freeze({
    schema_version: 2,
    operator_id: OPEN_SEMANTIC_FACTOR_COMPOSITION_OPERATOR_ID,
    status: "composed",
    compatibility_trace_digest: OSF_DIGEST,
    query_capture_digest: OSF_DIGEST,
    result_variable_ids: Object.freeze(["x"]),
    search_step_count: 1,
    solution_count: 1,
    observed_binding_count: 1,
    binding_observation_count: 1,
    truncated: false,
    bindings: Object.freeze([{
      variable_id: "x",
      binding_identity: "arg.person",
      evidence_id: "eu-1",
      evidence_factor_id: "factor.person",
      semantic_identity: "person.alice",
      surface: "alice",
      source_span: Object.freeze([0, 5] as const),
      query_proposition_id: "prop.works-at",
      evidence_proposition_id: "ev.prop.works-at"
    }]),
    solutions: Object.freeze([]),
    variable_collections: Object.freeze([]),
    receipt_digest: OSF_DIGEST
  });
}
