import { describe, expect, it } from "vitest";
import { materializeOpenSemanticFactorFormation } from "@do-soul/alaya-core";
import { compileRecallQueryProbes } from
  "../../../../../../../../packages/core/src/recall/query/recall-query-probes.js";
import {
  extendQueryProbesWithOpenSemanticFactors
} from
  "../../../../../../../../packages/core/src/recall/query/query-factor-expanded-terms.js";
import { materializeOpenSemanticFactorCompatibilityTrace } from
  "../../../../../../../../packages/core/src/recall/field/open-semantic-factors/compatibility-trace.js";
import { materializeOpenSemanticFactorComposition } from
  "../../../../../../../../packages/core/src/recall/field/open-semantic-factors/composition.js";
import { buildTreatmentExposureReceipts } from
  "../../../../../diagnostics/stage-attribution/exposure/build-receipts.js";
import { assertTreatmentExposureReceipt } from
  "../../../../../diagnostics/stage-attribution/exposure/contract.js";
import type { LongMemEvalQuestionDiagnostic } from
  "../../../../../diagnostics/schema/diagnostics-types.js";
import type { QuestionStageRow } from
  "../../../../../diagnostics/stage-attribution/types.js";

const QUERY = "How long is my daily commute to work?";
const EXTRA = "daily commute";

describe("treatment exposure receipt v4 FTS extras", () => {
  it("seals formed extras after a real composition no_match", () => {
    const formed = formedQuery();
    const composition = materializeOpenSemanticFactorComposition({
      trace: materializeOpenSemanticFactorCompatibilityTrace({
        query_capture: formed,
        evidence_formations: { disjoint: disjointEvidence() }
      }),
      query_capture: formed
    });
    const treatmentTerms = extendQueryProbesWithOpenSemanticFactors(
      compileRecallQueryProbes(QUERY), formed
    ).expanded_terms;
    const controlTerms = extendQueryProbesWithOpenSemanticFactors(
      compileRecallQueryProbes(QUERY), undefined
    ).expanded_terms;
    expect(formed.status).toBe("formed");
    expect(composition.status).toBe("no_match");
    expect(treatmentTerms).toEqual(expect.arrayContaining([EXTRA]));
    expect(controlTerms).not.toContain(EXTRA);

    const [receipt] = buildTreatmentExposureReceipts({
      control: [arm("q-fts-extra", controlTerms)],
      treatment: [{
        ...arm("q-fts-extra", treatmentTerms),
        query_open_semantic_factor_formation: formed,
        open_semantic_factor_composition: composition
      } as LongMemEvalQuestionDiagnostic],
      controlStages: [stage("q-fts-extra")],
      treatmentStages: [stage("q-fts-extra")]
    });

    expect(receipt).toMatchObject({
      formation: { status: "formed" },
      composition: { status: "no_match", solution_count: 0 },
      query_probe_delta: {
        observed: true,
        changed: true,
        added_expanded_terms: expect.arrayContaining([EXTRA]),
        removed_expanded_terms: []
      }
    });
    expect(receipt?.query_probe_delta.added_expanded_terms).toContain(EXTRA);
    expect(() => assertTreatmentExposureReceipt(receipt!)).not.toThrow();
  });
});

function formedQuery() {
  return materializeOpenSemanticFactorFormation({
    source_kind: "query",
    source_text: QUERY,
    proposal: {
      schema_version: 1,
      producer_operator_id: "open-factor-test-producer-v1",
      source_text: QUERY,
      graph: {
        schema_version: 2,
        source_kind: "query",
        factors: [
          { factor_id: "copula.be", surface: "is", semantic_identity: "be" },
          {
            factor_id: "subject.commute",
            surface: "my daily commute to work",
            semantic_identity: "daily commute"
          }
        ],
        variables: [{ variable_id: "answer", surface: "How" }],
        result_variable_ids: ["answer"],
        propositions: [{
          proposition_id: "query",
          predicate_factor_id: "copula.be",
          arguments: [
            {
              position: 0,
              binding_identity: "agent",
              reference_kind: "variable",
              reference_id: "answer"
            },
            {
              position: 1,
              binding_identity: "argument-1",
              reference_kind: "factor",
              reference_id: "subject.commute"
            }
          ]
        }]
      }
    }
  });
}

function disjointEvidence() {
  return materializeOpenSemanticFactorFormation({
    source_kind: "evidence",
    source_text: "Alice likes tea.",
    proposal: {
      schema_version: 1,
      producer_operator_id: "open-factor-test-producer-v1",
      source_text: "Alice likes tea.",
      graph: {
        schema_version: 2,
        source_kind: "evidence",
        factors: [
          { factor_id: "alice", surface: "Alice", semantic_identity: "alice" },
          { factor_id: "likes", surface: "likes", semantic_identity: "like" },
          { factor_id: "tea", surface: "tea", semantic_identity: "tea" }
        ],
        variables: [],
        result_variable_ids: [],
        propositions: [{
          proposition_id: "likes-tea",
          predicate_factor_id: "likes",
          arguments: [
            {
              position: 0,
              binding_identity: "agent",
              reference_kind: "factor",
              reference_id: "alice"
            },
            {
              position: 1,
              binding_identity: "object",
              reference_kind: "factor",
              reference_id: "tea"
            }
          ]
        }]
      }
    }
  });
}

function arm(questionId: string, expandedTerms: readonly string[]) {
  return {
    question_id: questionId,
    candidate_pool_complete: true,
    candidates: [{ candidate_key: "candidate:a", final_rank: 1 }],
    query_probes: { expanded_terms: expandedTerms },
    open_semantic_factor_candidate_activations: []
  } as unknown as LongMemEvalQuestionDiagnostic;
}

function stage(questionId: string): QuestionStageRow {
  return {
    question_id: questionId,
    stage: "delivered_top5",
    mechanism: null,
    opportunity_pre_budget_6_10: false,
    miss_taxonomy: null,
    best_pool_rank: null,
    hit_at_5: true,
    proof: "hit_at_5"
  };
}
