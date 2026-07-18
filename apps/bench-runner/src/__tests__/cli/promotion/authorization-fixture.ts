import { createLongMemEvalSelectionContractIdentity } from "@do-soul/alaya-eval";
import { buildLongMemEvalMatrixPromotionAuthorization } from
  "../../../longmemeval/promotion/schema/authorization.js";
import { expansionMaterialEffectFixture } from
  "../../longmemeval/expansion/expansion-promotion-contract-fixture.js";

export function promotionAuthorizationFixture() {
  const datasetSha256 = "d".repeat(64);
  const sourceSelection = createLongMemEvalSelectionContractIdentity({
    datasetSha256,
    assignments: [{ question_id: "q-1", dataset_cohort: "answerable" }]
  });
  const nextSelection = createLongMemEvalSelectionContractIdentity({
    datasetSha256,
    assignments: [
      { question_id: "q-1", dataset_cohort: "answerable" },
      { question_id: "q-2", dataset_cohort: "abstention" }
    ]
  });
  const cells = [
    cell("A", false, false, "1"),
    cell("B", true, false, "2"),
    cell("C", false, true, "3"),
    cell("D", true, true, "4")
  ] as const;
  const gate = {
    id: "longmemeval_s_r_at_5",
    label: "LongMemEval-S R@5",
    current: 0.95,
    target: 0.9,
    direction: "min" as const,
    unit: "ratio" as const,
    passed: true as const,
    missing: false as const
  };
  return buildLongMemEvalMatrixPromotionAuthorization({
    schema_version: 1,
    kind: "longmemeval_matrix_promotion_authorization",
    status: "authorized",
    contract_sha256: "a".repeat(64),
    policy_version: "longmemeval-product-default-v1",
    source_selection: sourceSelection,
    next_selection: nextSelection,
    matrix: { sha256: "b".repeat(64), cells: [...cells] },
    product_default: {
      cell: "B",
      treatment: cells[1].treatment,
      bundle_sha256: cells[1].bundle_sha256
    },
    hard_gates: [gate],
    product_default_replication: {
      cell: "B2",
      treatment: cells[1].treatment,
      evidence_root: "cell-b2",
      bundle_sha256: "5".repeat(64),
      hard_gates: [gate]
    },
    material_effect: expansionMaterialEffectFixture()
  });
}

function cell(
  label: "A" | "B" | "C" | "D",
  embeddingSupplement: boolean,
  answerRerank: boolean,
  digestPrefix: string
) {
  return {
    cell: label,
    treatment: {
      embedding_supplement: embeddingSupplement,
      answer_rerank: answerRerank
    },
    evidence_root: `cell-${label.toLowerCase()}`,
    bundle_sha256: digestPrefix.repeat(64)
  } as const;
}
