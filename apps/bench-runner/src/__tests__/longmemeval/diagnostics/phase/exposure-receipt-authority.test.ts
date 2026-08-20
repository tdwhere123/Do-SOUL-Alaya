import { describe, expect, it } from "vitest";
import { buildTreatmentExposureReceipts } from
  "../../../../bench/diagnostics/stage-attribution/exposure/build-receipts.js";
import {
  assertTreatmentExposureReceipt,
  sealTreatmentExposureReceipt
} from "../../../../bench/diagnostics/stage-attribution/exposure/contract.js";
import { OpenSemanticFactorCandidateActivationsSchema } from
  "../../../../bench/diagnostics/schema/field/open-semantic-candidate-activation-schema.js";
import { compareF0F2VsCachedF3 } from
  "../../../../bench/diagnostics/stage-attribution/diagnostic-100q.js";
import {
  candidateAttribution,
  diagnostic,
  exposure,
  replaceCandidateReceipt,
  row
} from "./exposure-receipt-fixture.js";

describe("treatment exposure receipt authority", () => {
  it("requires formation through activation and records membership delta", () => {
    const receipts = buildTreatmentExposureReceipts({
      control: [diagnostic("q1", [])],
      treatment: [diagnostic("q1", ["candidate:f3"], true)],
      controlStages: [row({ question_id: "q1", stage: 5, proof: "budget_drop" })],
      treatmentStages: [row({ question_id: "q1", stage: 5, proof: "budget_drop" })]
    });

    expect(receipts[0]).toMatchObject({
      question_id: "q1",
      exposure_status: "exposed",
      formation: { status: "formed" },
      compatible_evidence: { compatible_count: 1 },
      composition: { solution_count: 1 },
      activation: { activated_evidence_count: 1 },
      membership_delta: { added_candidate_keys: ["candidate:f3"], changed: true }
    });
  });

  it("classifies formed treatment with no compatible evidence as not_exercised", () => {
    const base = diagnostic("q-no-compatible", [], true) as Record<string, unknown>;
    const compatibility = {
      ...(base.open_semantic_factor_compatibility_trace as Record<string, unknown>),
      matchable_evidence_count: 0,
      entries: []
    };
    const composition = {
      ...(base.open_semantic_factor_composition as Record<string, unknown>),
      status: "unavailable",
      solution_count: 0,
      solutions: []
    };
    const treatment = {
      ...base,
      open_semantic_factor_compatibility_trace: compatibility,
      open_semantic_factor_composition: composition,
      open_semantic_factor_activation: {
        ...(base.open_semantic_factor_activation as Record<string, unknown>),
        status: "unavailable",
        entries: []
      },
      open_semantic_factor_candidate_activations: []
    };
    const receipts = buildTreatmentExposureReceipts({
      control: [diagnostic("q-no-compatible", [])],
      treatment: [treatment as never],
      controlStages: [row({ question_id: "q-no-compatible", stage: 5, proof: "budget_drop" })],
      treatmentStages: [row({ question_id: "q-no-compatible", stage: 5, proof: "budget_drop" })]
    });
    const comparison = compareF0F2VsCachedF3({
      control: [row({ question_id: "q-no-compatible", stage: 5, proof: "budget_drop" })],
      treatment: [row({ question_id: "q-no-compatible", stage: 5, proof: "budget_drop" })],
      treatmentExposure: receipts
    });

    expect(compatibility.entries).toEqual([]);
    expect(receipts[0]).toMatchObject({
      exposure_status: "not_exercised",
      formation: { status: "formed" },
      compatible_evidence: { compatible_count: 0 },
      composition: { status: "unavailable", solution_count: 0 },
      activation: { status: "unavailable", activated_evidence_count: 0 }
    });
    expect(receipts[0]?.composition.status).not.toBe("no_match");
    expect(receipts[0]?.activation.status).not.toBe("no_match");
    expect(() => assertTreatmentExposureReceipt(receipts[0]!)).not.toThrow();
    expect(comparison.not_exercised).toEqual(["q-no-compatible"]);
    expect(comparison.still_missing).toEqual([]);
  });

  it("does not treat a zero activation entry as exercised", () => {
    const treatment = diagnostic("q-zero-activation", ["candidate:f3"], true) as Record<string, unknown>;
    treatment.open_semantic_factor_activation = {
      ...(treatment.open_semantic_factor_activation as Record<string, unknown>),
      entries: [{ evidence_id: "e1", activation: 0 }]
    };
    treatment.open_semantic_factor_candidate_activations = [];
    const [receipt] = buildTreatmentExposureReceipts({
      control: [diagnostic("q-zero-activation", [])],
      treatment: [treatment as never],
      controlStages: [row({ question_id: "q-zero-activation", stage: 5, proof: "budget_drop" })],
      treatmentStages: [row({ question_id: "q-zero-activation", stage: 5, proof: "budget_drop" })]
    });

    expect(receipt?.activation.activated_evidence_count).toBe(0);
    expect(receipt?.exposure_status).toBe("not_exercised");
    expect(() => assertTreatmentExposureReceipt(receipt!)).not.toThrow();
  });

  it("does not treat a membership delta without candidate attribution as exposure", () => {
    const treatment = diagnostic("q-no-attribution", ["candidate:f3"], true) as Record<string, unknown>;
    treatment.open_semantic_factor_candidate_activations = [];
    const [receipt] = buildTreatmentExposureReceipts({
      control: [diagnostic("q-no-attribution", [])], treatment: [treatment as never],
      controlStages: [row({ question_id: "q-no-attribution", stage: 5, proof: "budget_drop" })],
      treatmentStages: [row({ question_id: "q-no-attribution", stage: 5, proof: "budget_drop" })]
    });
    expect(receipt?.membership_delta.changed).toBe(true);
    expect(receipt?.candidate_attribution.entries).toEqual([]);
    expect(receipt?.exposure_status).toBe("not_exercised");
  });

  it("makes dual-arm F3 exposure inconclusive", () => {
    const [receipt] = buildTreatmentExposureReceipts({
      control: [diagnostic("q-dual", ["candidate:f3"], true)],
      treatment: [diagnostic("q-dual", ["candidate:f3"], true)],
      controlStages: [row({ question_id: "q-dual", stage: 5, proof: "budget_drop" })],
      treatmentStages: [row({ question_id: "q-dual", stage: 5, proof: "budget_drop" })]
    });
    expect(receipt?.control_non_exposure).toMatchObject({ observed: true, pure: false });
    expect(receipt?.exposure_status).toBe("inconclusive");
  });

  it.each([
    ["nonexistent candidate", () => diagnostic("q-cross", ["candidate:real"], true)],
    ["unrelated evidence", () => replaceCandidateReceipt(
      diagnostic("q-cross", ["candidate:f3"], true), { evidence_ids: ["other"] }
    )],
    ["mismatched score and counts", () => replaceCandidateReceipt(
      diagnostic("q-cross", ["candidate:f3"], true), {
        score: 0.5, solution_count: 2, proposition_match_count: 2
      }
    )]
  ] as const)("makes %s candidate attribution inconclusive", (_name, treatment) => {
    const [receipt] = buildTreatmentExposureReceipts({
      control: [diagnostic("q-cross", [])], treatment: [treatment()],
      controlStages: [row({ question_id: "q-cross", stage: 5, proof: "budget_drop" })],
      treatmentStages: [row({ question_id: "q-cross", stage: 5, proof: "budget_drop" })]
    });
    expect(receipt?.evidence_chain.linked).toBe(false);
    expect(receipt?.exposure_status).toBe("inconclusive");
  });

  it("uses code-unit ordering for Unicode candidate activation keys", () => {
    const zEntry = candidateAttribution(true).entries[0]!;
    const umlautEntry = { ...zEntry, candidate_key: "ä" };
    const asciiEntry = { ...zEntry, candidate_key: "z" };
    expect(OpenSemanticFactorCandidateActivationsSchema.safeParse(
      [asciiEntry, umlautEntry]
    ).success).toBe(true);
    expect(OpenSemanticFactorCandidateActivationsSchema.safeParse(
      [umlautEntry, asciiEntry]
    ).success).toBe(false);
  });

  it.each([
    ["derived status", (receipt: ReturnType<typeof exposure>) => ({
      ...receipt,
      exposure_status: "not_exercised" as const
    })],
    ["status enum", (receipt: ReturnType<typeof exposure>) => ({
      ...receipt,
      formation: { status: "invented" }
    })],
    ["count", (receipt: ReturnType<typeof exposure>) => ({
      ...receipt,
      compatible_evidence: { compatible_count: -1 }
    })],
    ["membership keys", (receipt: ReturnType<typeof exposure>) => ({
      ...receipt,
      membership_delta: {
        ...receipt.membership_delta,
        changed: true,
        added_candidate_keys: ["z", "a", "a"]
      }
    })],
    ["shape", (receipt: ReturnType<typeof exposure>) => ({
      ...receipt,
      unexpected: true
    })]
  ] as const)("rejects a re-sealed receipt with invalid %s", (_name, mutate) => {
    const original = exposure("q-invalid", "exposed", false);
    const { receipt_digest: _digest, ...body } = mutate(original);
    const resealed = sealTreatmentExposureReceipt(body as never);
    expect(() => assertTreatmentExposureReceipt(resealed)).toThrow(/treatment exposure receipt/u);
  });
});
