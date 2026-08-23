import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GOLD_EXCLUSION_FIRST_REASONS,
  RECALL_MECHANISM_SPLIT_KIND,
  buildRecallMechanismSplit,
  type GoldExclusionFirstReason,
  type MechanismQuestionObservation
} from "../../../bench/diagnostics/stage-attribution/mechanism-receipt.js";
import { readRecallMechanismSplitArtifact } from
  "../../../bench/diagnostics/stage-attribution/mechanism-receipt-artifact.js";
import { compareF0F2VsCachedF3 } from
  "../../../bench/diagnostics/stage-attribution/diagnostic-100q.js";
import { readDiagnostic100QComparisonArtifact } from
  "../../../bench/diagnostics/stage-attribution/exposure/comparison-artifact.js";
import { exposure, row } from "./phase/exposure-receipt-fixture.js";

function question(
  questionId: string,
  observation: Omit<MechanismQuestionObservation, "question_id"> = {}
): MechanismQuestionObservation {
  return { question_id: questionId, ...observation };
}

function receipt(questions: readonly MechanismQuestionObservation[]) {
  return buildRecallMechanismSplit({ questions });
}

function legacyMembershipImproved(
  deliveredHit: { readonly control: boolean; readonly treatment: boolean }
): boolean {
  return !deliveredHit.control && deliveredHit.treatment;
}

describe("recall mechanism split v1", () => {
  it("freezes schema 1 split fields without inventing a matrix count", () => {
    const built = receipt([question("q-observed", {
      delivered_hit: { control: false, treatment: true }
    })]);
    expect(built.schema_version).toBe(1);
    expect(built.kind).toBe(RECALL_MECHANISM_SPLIT_KIND);
    expect(Object.isFrozen(built)).toBe(true);
    expect(JSON.stringify(built)).not.toMatch(/\b81\b|\b94\b/u);
  });

  it("records delivered_hit_changed as XOR and keeps membership_improved separate", () => {
    const improved = { control: false, treatment: true } as const;
    const regressed = { control: true, treatment: false } as const;
    const built = receipt([
      question("q-improved", { delivered_hit: improved }),
      question("q-regressed", { delivered_hit: regressed }),
      question("q-still-miss", { delivered_hit: { control: false, treatment: false } }),
      question("q-still-hit", { delivered_hit: { control: true, treatment: true } })
    ]);
    expect(legacyMembershipImproved(improved)).toBe(true);
    expect(legacyMembershipImproved(regressed)).toBe(false);
    expect(built.delivered_hit_changed).toEqual(["q-improved", "q-regressed"]);
    expect(built.field_member_added).toBe("unavailable");
  });

  it("classifies directional field, compatibility, and binding additions", () => {
    const built = receipt([
      question("q-field", {
        field_member: { control: false, treatment: true }
      }),
      question("q-compat", {
        compatibility: { control: false, treatment: true }
      }),
      question("q-binding", {
        binding_solutions: { control: ["v1"], treatment: ["v1", "v2"] }
      }),
      question("q-unchanged", {
        field_member: { control: true, treatment: true },
        compatibility: { control: true, treatment: false },
        binding_solutions: { control: ["v1"], treatment: ["v1"] }
      })
    ]);
    expect(built.field_member_added).toEqual(["q-field"]);
    expect(built.compatibility_added).toEqual(["q-compat"]);
    expect(built.binding_solution_added).toEqual(["q-binding"]);
  });

  it("classifies fused rank without requiring a delivered hit change", () => {
    const built = receipt([question("q-rank", {
      delivered_hit: { control: false, treatment: false },
      fused_rank: { control: 12, treatment: 6 },
      gamma_decision: {
        control: { kind: "duplicate", identity_channel: "source" },
        treatment: { kind: "duplicate", identity_channel: "source" }
      }
    })]);
    expect(built.fused_rank_changed).toEqual(["q-rank"]);
    expect(built.delivered_hit_changed).toEqual([]);
    expect(built.gamma_admission_changed).toEqual([]);
  });

  it("classifies gamma admission from fused top-5 plus delivered change", () => {
    const built = receipt([question("q-gamma-fused", {
      delivered_hit: { control: false, treatment: true },
      fused_rank: { control: 3, treatment: 3 }
    })]);
    expect(built.gamma_admission_changed).toEqual(["q-gamma-fused"]);
    expect(built.delivered_hit_changed).toEqual(["q-gamma-fused"]);
    expect(built.fused_rank_changed).toEqual([]);
  });

  it("classifies gamma admission from Select_Gamma decision kind or reason change", () => {
    const built = receipt([question("q-gamma-decision", {
      delivered_hit: { control: false, treatment: false },
      gamma_decision: {
        control: { kind: "duplicate", identity_channel: "source" },
        treatment: { kind: "retained" }
      }
    })]);
    expect(built.gamma_admission_changed).toEqual(["q-gamma-decision"]);
    expect(built.delivered_hit_changed).toEqual([]);
  });

  it("records activation change only for prefix-eligible golds", () => {
    const built = receipt([
      question("q-activated", {
        golds: [{
          gold_key: "gold-scored",
          prefix_eligible: true,
          activation: { control: 0.2, treatment: 0.8 }
        }]
      }),
      question("q-unscored", {
        activation: { control: 0.1, treatment: 0.9 },
        golds: [{
          gold_key: "gold-unscored",
          prefix_eligible: false,
          activation: { control: 0.1, treatment: 0.9 },
          first_reason: "token_budget"
        }]
      })
    ]);
    expect(built.activation_changed).toEqual(["q-activated"]);
    expect(built.bounded_candidate_prefix).toEqual([
      { question_id: "q-activated", candidate_key: "gold-scored", eligible: true },
      { question_id: "q-unscored", candidate_key: "gold-unscored", eligible: false }
    ]);
  });

  it("emits unavailable when an observation is missing rather than guessing", () => {
    const built = receipt([question("q-missing", {
      delivered_hit: { control: false, treatment: true },
      golds: [{ gold_key: "gold-a", candidate_key: "cand-a" }]
    })]);
    expect(built.activation_changed).toBe("unavailable");
    expect(built.field_member_added).toBe("unavailable");
    expect(built.compatibility_added).toBe("unavailable");
    expect(built.binding_solution_added).toBe("unavailable");
    expect(built.fused_rank_changed).toBe("unavailable");
    expect(built.gamma_admission_changed).toBe("unavailable");
    expect(built.gold_exclusions).toEqual([{
      question_id: "q-missing", gold_key: "gold-a", first_reason: "unavailable"
    }]);
    expect(built.bounded_candidate_prefix).toEqual([{
      question_id: "q-missing", candidate_key: "cand-a", eligible: "unavailable"
    }]);
  });

  it.each([...GOLD_EXCLUSION_FIRST_REASONS] as GoldExclusionFirstReason[])(
    "records first exclusion reason %s",
    (firstReason) => {
      const built = receipt([question("q-gold", {
        golds: [{ gold_key: "gold-a", first_reason: firstReason, prefix_eligible: true }]
      })]);
      expect(built.gold_exclusions).toEqual([{
        question_id: "q-gold", gold_key: "gold-a", first_reason: firstReason
      }]);
    }
  );

  it("maps structural Gamma decisions onto the first-reason enum", () => {
    const built = receipt([
      question("q-dup-source", {
        golds: [{
          gold_key: "g1",
          gamma_decision: {
            control: { kind: "retained" },
            treatment: { kind: "duplicate", identity_channel: "source" }
          }
        }]
      }),
      question("q-dup-object", {
        golds: [{
          gold_key: "g2",
          gamma_decision: {
            control: { kind: "retained" },
            treatment: { kind: "duplicate", identity_channel: "object" }
          }
        }]
      }),
      question("q-dim", {
        golds: [{
          gold_key: "g3",
          gamma_decision: {
            control: { kind: "retained" },
            treatment: { kind: "dimension_limit" }
          }
        }]
      }),
      question("q-token", {
        golds: [{
          gold_key: "g4",
          gamma_decision: {
            control: { kind: "retained" },
            treatment: { kind: "max_total_tokens" }
          }
        }]
      }),
      question("q-entry", {
        golds: [{
          gold_key: "g5",
          gamma_decision: {
            control: { kind: "retained" },
            treatment: { kind: "max_entries" }
          }
        }]
      })
    ]);
    expect(built.gold_exclusions.map((row) => row.first_reason)).toEqual([
      "dimension_limit",
      "duplicate_object",
      "duplicate_source",
      "entry_budget",
      "token_budget"
    ]);
  });

  it("rejects an unknown first_reason instead of coercing it", () => {
    expect(() => receipt([question("q-bad", {
      golds: [{ gold_key: "g1", first_reason: "lineage_duplicate" as never }]
    })])).toThrow(/invalid gold first_reason/u);
  });

  it("round-trips a frozen receipt and rejects schema-6 comparison files", async () => {
    const root = await mkdtemp(join(tmpdir(), "mechanism-split-"));
    const mechanismPath = join(root, "mechanism.json");
    const comparisonPath = join(root, "comparison.json");
    const built = receipt([question("q1", {
      delivered_hit: { control: false, treatment: true },
      field_member: { control: false, treatment: true }
    })]);
    await writeFile(mechanismPath, JSON.stringify(built));
    await expect(readRecallMechanismSplitArtifact(mechanismPath)).resolves.toEqual(built);
    await writeFile(mechanismPath, JSON.stringify({ ...built, extra: true }));
    await expect(readRecallMechanismSplitArtifact(mechanismPath)).rejects.toThrow(
      /lacks the v1 contract/u
    );
    await writeFile(mechanismPath, JSON.stringify({
      schema_version: 5, kind: "diagnostic_100q_f0f2_vs_cached_f3"
    }));
    await expect(readRecallMechanismSplitArtifact(mechanismPath)).rejects.toThrow(
      /cannot be reinterpreted as a recall mechanism split/u
    );

    const comparison = compareF0F2VsCachedF3({
      control: [row({ question_id: "q1", stage: 5, proof: "budget_drop" })],
      treatment: [row({ question_id: "q1", stage: 5, proof: "budget_drop" })],
      treatmentExposure: [exposure("q1", "exposed", false)]
    });
    expect(comparison.schema_version).toBe(6);
    expect(comparison.kind).toBe("diagnostic_100q_f0f2_vs_cached_f3");
    await writeFile(comparisonPath, JSON.stringify(comparison));
    await expect(readDiagnostic100QComparisonArtifact(comparisonPath)).resolves.toEqual(
      comparison
    );
    await expect(readRecallMechanismSplitArtifact(comparisonPath)).rejects.toThrow(
      /cannot be reinterpreted as a recall mechanism split/u
    );

    await writeFile(comparisonPath, JSON.stringify({
      ...comparison,
      delivered_hit_changed: ["q1"]
    }));
    await expect(readDiagnostic100QComparisonArtifact(comparisonPath)).rejects.toThrow(
      /lacks the cached F3 exposure contract/u
    );
  });
});
