import { describe, expect, it } from "vitest";
import { buildTreatmentExposureReceipts } from
  "../../../../../bench/diagnostics/stage-attribution/exposure/build-receipts.js";
import {
  assertTreatmentExposureReceipt,
  sealTreatmentExposureReceipt
} from "../../../../../bench/diagnostics/stage-attribution/exposure/contract.js";
import type { LongMemEvalQuestionDiagnostic } from
  "../../../../../bench/diagnostics/schema/diagnostics-types.js";
import type { QuestionStageRow } from
  "../../../../../bench/diagnostics/stage-attribution/types.js";

describe("treatment exposure receipt v4", () => {
  it("observes delivered Top-5 churn when both truncated pools still have a final ranking", () => {
    const control = arm({
      questionId: "q3",
      poolComplete: false,
      topFive: ["candidate:coupon", "candidate:friend", "candidate:restaurant",
        "candidate:sunday", "candidate:grocery"],
      extra: ["candidate:noise-control"]
    });
    const treatment = arm({
      questionId: "q3",
      poolComplete: false,
      topFive: ["candidate:coupon", "candidate:friend", "candidate:restaurant",
        "candidate:sunday", "candidate:location"],
      extra: ["candidate:noise-treatment"]
    });
    const v3WouldObserve = control.candidate_pool_complete === true &&
      treatment.candidate_pool_complete === true;
    const [receipt] = buildTreatmentExposureReceipts({
      control: [control],
      treatment: [treatment],
      controlStages: [stage("q3", true)],
      treatmentStages: [stage("q3", true)]
    });

    expect(v3WouldObserve).toBe(false);
    expect(receipt).toMatchObject({
      schema_version: 4,
      membership_delta: {
        observed: true,
        changed: true,
        added_candidate_keys: ["candidate:location"],
        removed_candidate_keys: ["candidate:grocery"]
      },
      candidate_pool: { control_complete: false, treatment_complete: false },
      outcome: {
        control: { hit_at_5: true },
        treatment: { hit_at_5: true }
      }
    });
    expect(receipt?.membership_delta.added_candidate_keys)
      .not.toContain("candidate:noise-treatment");
    expect(receipt?.membership_delta.removed_candidate_keys)
      .not.toContain("candidate:noise-control");
    expect(() => assertTreatmentExposureReceipt(receipt!)).not.toThrow();
  });

  it("exposes expanded-term and retrieval-channel status/depth diffs already on the arms", () => {
    const [receipt] = buildTreatmentExposureReceipts({
      control: [arm({
        questionId: "q-probe",
        poolComplete: true,
        topFive: ["candidate:a"],
        expandedTerms: ["coupon"],
        channels: [
          { channel_id: "lexical_expanded_trigram", status: "complete", depth: 1 },
          { channel_id: "lexical_relaxed_exact", status: "complete", depth: 4 }
        ]
      })],
      treatment: [arm({
        questionId: "q-probe",
        poolComplete: true,
        topFive: ["candidate:a"],
        expandedTerms: ["coupon", "target"],
        channels: [
          { channel_id: "lexical_expanded_trigram", status: "truncated", depth: 6 },
          { channel_id: "lexical_relaxed_exact", status: "complete", depth: 4 }
        ]
      })],
      controlStages: [stage("q-probe", true)],
      treatmentStages: [stage("q-probe", true)]
    });

    expect(receipt).toMatchObject({
      schema_version: 4,
      query_probe_delta: {
        observed: true,
        changed: true,
        added_expanded_terms: ["target"],
        removed_expanded_terms: []
      },
      retrieval_channel_delta: {
        observed: true,
        changed: true,
        changed_channels: [{
          channel_id: "lexical_expanded_trigram",
          control_status: "complete",
          treatment_status: "truncated",
          control_depth: 1,
          treatment_depth: 6
        }]
      }
    });
    expect(() => assertTreatmentExposureReceipt(receipt!)).not.toThrow();
  });

  it("does not claim probe or channel observation when those diagnostics are absent", () => {
    const [receipt] = buildTreatmentExposureReceipts({
      control: [arm({ questionId: "q-absent", poolComplete: true, topFive: ["candidate:a"] })],
      treatment: [arm({ questionId: "q-absent", poolComplete: true, topFive: ["candidate:a"] })],
      controlStages: [stage("q-absent", true)],
      treatmentStages: [stage("q-absent", true)]
    });

    expect(receipt).toMatchObject({
      query_probe_delta: {
        observed: false, changed: false, added_expanded_terms: [], removed_expanded_terms: []
      },
      retrieval_channel_delta: {
        observed: false, changed: false, changed_channels: []
      }
    });
  });

  it("keeps absent control distinct from an incomplete control pool", () => {
    const incomplete = buildTreatmentExposureReceipts({
      control: [arm({
        questionId: "q-incomplete", poolComplete: false, topFive: ["candidate:a"]
      })],
      treatment: [arm({
        questionId: "q-incomplete", poolComplete: false, topFive: ["candidate:a"]
      })],
      controlStages: [stage("q-incomplete", true)],
      treatmentStages: [stage("q-incomplete", true)]
    })[0];
    const absent = buildTreatmentExposureReceipts({
      control: [],
      treatment: [arm({
        questionId: "q-absent-control", poolComplete: false, topFive: ["candidate:a"]
      })],
      controlStages: [stage("q-absent-control", true)],
      treatmentStages: [stage("q-absent-control", true)]
    })[0];

    expect(incomplete).toMatchObject({
      membership_delta: { observed: true },
      candidate_pool: { control_complete: false, treatment_complete: false }
    });
    expect(absent).toMatchObject({
      membership_delta: { observed: false, changed: false },
      candidate_pool: { control_complete: null, treatment_complete: false }
    });
    expect(() => assertTreatmentExposureReceipt(incomplete!)).not.toThrow();
    expect(() => assertTreatmentExposureReceipt(absent!)).not.toThrow();
  });

  it("does not invent a probe delta when only one arm has expanded_terms", () => {
    const [receipt] = buildTreatmentExposureReceipts({
      control: [arm({
        questionId: "q-one-arm",
        poolComplete: true,
        topFive: ["candidate:a"],
        expandedTerms: ["coupon"]
      })],
      treatment: [arm({
        questionId: "q-one-arm",
        poolComplete: true,
        topFive: ["candidate:a"],
        queryProbesWithoutTerms: true
      })],
      controlStages: [stage("q-one-arm", true)],
      treatmentStages: [stage("q-one-arm", true)]
    });

    expect(receipt).toMatchObject({
      query_probe_delta: {
        observed: false, changed: false, added_expanded_terms: [], removed_expanded_terms: []
      }
    });
  });

  it("observes a Top-5 hit flip while both truncated pools remain incomplete", () => {
    const [receipt] = buildTreatmentExposureReceipts({
      control: [arm({
        questionId: "q-hit-flip",
        poolComplete: false,
        topFive: ["candidate:coupon", "candidate:friend", "candidate:restaurant",
          "candidate:sunday", "candidate:grocery"]
      })],
      treatment: [arm({
        questionId: "q-hit-flip",
        poolComplete: false,
        topFive: ["candidate:coupon", "candidate:friend", "candidate:restaurant",
          "candidate:sunday", "candidate:location"]
      })],
      controlStages: [stage("q-hit-flip", true)],
      treatmentStages: [stage("q-hit-flip", false)]
    });

    expect(receipt).toMatchObject({
      candidate_pool: { control_complete: false, treatment_complete: false },
      membership_delta: { observed: true, changed: true },
      outcome: {
        control: { hit_at_5: true },
        treatment: { hit_at_5: false }
      }
    });
  });

  it("fails closed on duplicate retrieval channel_id rows", () => {
    const channel = {
      channel_id: "lexical_expanded_trigram",
      status: "complete" as const,
      depth: 1
    };
    expect(() => buildTreatmentExposureReceipts({
      control: [arm({
        questionId: "q-dup",
        poolComplete: true,
        topFive: ["candidate:a"],
        channels: [channel, channel]
      })],
      treatment: [arm({
        questionId: "q-dup",
        poolComplete: true,
        topFive: ["candidate:a"],
        channels: [channel]
      })],
      controlStages: [stage("q-dup", true)],
      treatmentStages: [stage("q-dup", true)]
    })).toThrow(/duplicate retrieval channel_id/u);
  });

  it("rejects a re-sealed v4 receipt that marks absent control as complete", () => {
    const [original] = buildTreatmentExposureReceipts({
      control: [],
      treatment: [arm({
        questionId: "q-absent-complete", poolComplete: true, topFive: ["candidate:a"]
      })],
      controlStages: [stage("q-absent-complete", true)],
      treatmentStages: [stage("q-absent-complete", true)]
    });
    const { receipt_digest: _digest, ...body } = original!;
    const resealed = sealTreatmentExposureReceipt({
      ...body,
      candidate_pool: { control_complete: true, treatment_complete: true }
    } as never);

    expect(() => assertTreatmentExposureReceipt(resealed))
      .toThrow(/treatment exposure receipt/u);
  });

  it("rejects a re-sealed v4 receipt whose membership keys are unsorted", () => {
    const [original] = buildTreatmentExposureReceipts({
      control: [arm({
        questionId: "q-sort", poolComplete: false, topFive: ["candidate:b"]
      })],
      treatment: [arm({
        questionId: "q-sort", poolComplete: false, topFive: ["candidate:a", "candidate:c"]
      })],
      controlStages: [stage("q-sort", true)],
      treatmentStages: [stage("q-sort", true)]
    });
    const { receipt_digest: _digest, ...body } = original!;
    const resealed = sealTreatmentExposureReceipt({
      ...body,
      membership_delta: {
        ...body.membership_delta,
        added_candidate_keys: ["candidate:c", "candidate:a"]
      }
    } as never);

    expect(() => assertTreatmentExposureReceipt(resealed))
      .toThrow(/treatment exposure receipt/u);
  });
});

function arm(input: {
  readonly questionId: string;
  readonly poolComplete: boolean;
  readonly topFive: readonly string[];
  readonly extra?: readonly string[];
  readonly expandedTerms?: readonly string[];
  readonly queryProbesWithoutTerms?: boolean;
  readonly channels?: readonly {
    readonly channel_id: string;
    readonly status: "complete" | "truncated" | "unavailable" | "ineligible";
    readonly depth: number;
  }[];
}) {
  return {
    question_id: input.questionId,
    candidate_pool_complete: input.poolComplete,
    candidates: [
      ...input.topFive.map((candidate_key, index) => ({
        candidate_key, final_rank: index + 1
      })),
      ...(input.extra ?? []).map((candidate_key, index) => ({
        candidate_key, final_rank: 6 + index
      }))
    ],
    query_probes: input.queryProbesWithoutTerms === true
      ? {}
      : input.expandedTerms === undefined
        ? undefined
        : { expanded_terms: input.expandedTerms },
    retrieval_field_captures: input.channels === undefined
      ? undefined
      : input.channels.map((channel) => ({ channel })),
    open_semantic_factor_candidate_activations: []
  } as unknown as LongMemEvalQuestionDiagnostic;
}

function stage(questionId: string, hitAt5: boolean): QuestionStageRow {
  return {
    question_id: questionId,
    stage: 7,
    mechanism: null,
    opportunity_pre_budget_6_10: false,
    miss_taxonomy: null,
    best_pool_rank: null,
    hit_at_5: hitAt5,
    proof: hitAt5 ? "hit_at_5" : "budget_drop"
  };
}
