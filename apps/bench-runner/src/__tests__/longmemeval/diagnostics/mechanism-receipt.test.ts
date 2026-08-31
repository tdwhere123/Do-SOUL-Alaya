import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GOLD_EXCLUSION_FIRST_REASONS,
  MECHANISM_PREFIX_OPERATOR_ID,
  RECALL_MECHANISM_SPLIT_KIND,
  buildRecallMechanismSplit,
  type GoldExclusionFirstReason,
  type MechanismQuestionObservation
} from "../../../diagnostics/stage-attribution/mechanism/receipt.js";
import { readRecallMechanismSplitArtifact } from
  "../../../diagnostics/stage-attribution/mechanism/artifact.js";

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

const unchangedField = { control: true, treatment: true } as const;
const unchangedCompat = { control: true, treatment: true } as const;
const unchangedBinding = { control: ["v1"], treatment: ["v1"] } as const;

describe("recall mechanism split v1", () => {
  it("freezes schema 1 split fields without inventing a matrix count", () => {
    const built = receipt([question("q-observed", {
      delivered_hit: { control: false, treatment: true }
    })]);
    expect(built.schema_version).toBe(1);
    expect(built.kind).toBe(RECALL_MECHANISM_SPLIT_KIND);
    expect(built.prefix_operator_id).toBe(MECHANISM_PREFIX_OPERATOR_ID);
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
        field_member: { control: false, treatment: true },
        compatibility: unchangedCompat,
        binding_solutions: unchangedBinding
      }),
      question("q-compat", {
        field_member: unchangedField,
        compatibility: { control: false, treatment: true },
        binding_solutions: unchangedBinding
      }),
      question("q-binding", {
        field_member: unchangedField,
        compatibility: unchangedCompat,
        binding_solutions: { control: ["v1"], treatment: ["v1", "v2"] }
      }),
      question("q-unchanged", {
        field_member: unchangedField,
        compatibility: { control: true, treatment: false },
        binding_solutions: unchangedBinding
      })
    ]);
    expect(built.field_member_added).toEqual(["q-field"]);
    expect(built.compatibility_added).toEqual(["q-compat"]);
    expect(built.binding_solution_added).toEqual(["q-binding"]);
  });

  it("treats mixed observation presence as unavailable, not an empty census", () => {
    const built = receipt([
      question("q-seen", { field_member: { control: false, treatment: true } }),
      question("q-missing", { delivered_hit: { control: false, treatment: true } })
    ]);
    expect(built.field_member_added).toBe("unavailable");
    expect(built.delivered_hit_changed).toBe("unavailable");
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

  it("does not label a ranking-then-hit as gamma admission", () => {
    const built = receipt([question("q-rank-then-hit", {
      delivered_hit: { control: false, treatment: true },
      fused_rank: { control: 12, treatment: 3 },
      gamma_decision: {
        control: { kind: "retained" },
        treatment: { kind: "retained" }
      }
    })]);
    expect(built.fused_rank_changed).toEqual(["q-rank-then-hit"]);
    expect(built.delivered_hit_changed).toEqual(["q-rank-then-hit"]);
    expect(built.gamma_admission_changed).toEqual([]);
  });

  it("classifies gamma admission from fused top-5 on both arms plus delivered change", () => {
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
          candidate_key: "cand-scored",
          prefix_eligible: true,
          activation: { control: 0.2, treatment: 0.8 }
        }]
      }),
      question("q-unscored", {
        activation: { control: 0.1, treatment: 0.9 },
        golds: [{
          gold_key: "gold-unscored",
          candidate_key: "cand-unscored",
          prefix_eligible: false,
          activation: { control: 0.1, treatment: 0.9 },
          first_reason: "token_budget"
        }]
      })
    ]);
    expect(built.activation_changed).toEqual(["q-activated"]);
    expect(built.bounded_candidate_prefix).toEqual([
      { question_id: "q-activated", candidate_key: "cand-scored", eligible: true },
      { question_id: "q-unscored", candidate_key: "cand-unscored", eligible: false }
    ]);
  });

  it("does not license gold activation from an unrelated eligible candidate", () => {
    const built = receipt([question("q-omitted-prefix", {
      activation: { control: 0.1, treatment: 0.9 },
      candidates: [{ candidate_key: "other", prefix_eligible: true }],
      golds: [{ gold_key: "gold-a" }]
    })]);
    expect(built.activation_changed).toBe("unavailable");
    expect(built.bounded_candidate_prefix).toEqual([
      { question_id: "q-omitted-prefix", candidate_key: "other", eligible: true }
    ]);
  });

  it("omits prefix rows that lack a candidate_key", () => {
    const built = receipt([question("q-gold-only", {
      golds: [{ gold_key: "gold-a", prefix_eligible: true }]
    })]);
    expect(built.bounded_candidate_prefix).toEqual([]);
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
      question_id: "q-missing",
      gold_key: "gold-a",
      first_reason: "unavailable",
      outcome: "unavailable"
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
        question_id: "q-gold",
        gold_key: "gold-a",
        first_reason: firstReason,
        outcome: "excluded"
      }]);
    }
  );

  it("maps every Gamma exclusion kind to the gate reason", () => {
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
          fused_rank: { control: 3, treatment: 3 },
          gamma_decision: {
            control: { kind: "retained" },
            treatment: { kind: "max_entries" }
          }
        }]
      }),
      question("q-quality", {
        golds: [{
          gold_key: "g6",
          gamma_decision: {
            control: { kind: "retained" },
            treatment: {
              kind: "quality_displaced",
              reason: "last_slot"
            }
          }
        }]
      }),
      question("q-coverage", {
        golds: [{
          gold_key: "g7",
          gamma_decision: {
            control: { kind: "retained" },
            treatment: {
              kind: "coverage_displaced",
              reason: "last_slot"
            }
          }
        }]
      })
    ]);
    expect(built.gold_exclusions.map((row) => [row.first_reason, row.outcome])).toEqual([
      ["coverage_displaced", "excluded"],
      ["dimension_limit", "excluded"],
      ["duplicate_object", "excluded"],
      ["duplicate_source", "excluded"],
      ["entry_budget", "excluded"],
      ["quality_displaced", "excluded"],
      ["token_budget", "excluded"]
    ]);
  });

  it("derives coverage_displaced from fusion vs coverage-selector ranks", () => {
    const built = receipt([question("q-cover", {
      golds: [{
        gold_key: "g-cover",
        rank_after_fusion: 3,
        rank_after_coverage_selector: 8
      }]
    })]);
    expect(built.gold_exclusions).toEqual([{
      question_id: "q-cover",
      gold_key: "g-cover",
      first_reason: "coverage_displaced",
      outcome: "excluded"
    }]);
  });

  it("records admitted golds instead of calling them unknown exclusions", () => {
    const built = receipt([question("q-hit", {
      golds: [{
        gold_key: "g-hit",
        gamma_decision: {
          control: { kind: "retained" },
          treatment: { kind: "retained" }
        }
      }]
    })]);
    expect(built.gold_exclusions).toEqual([{
      question_id: "q-hit",
      gold_key: "g-hit",
      first_reason: "unavailable",
      outcome: "admitted"
    }]);
  });

  it("rejects an unknown first_reason instead of coercing it", () => {
    expect(() => receipt([question("q-bad", {
      golds: [{ gold_key: "g1", first_reason: "lineage_duplicate" as never }]
    })])).toThrow(/invalid gold first_reason/u);
  });

  it("round-trips observations and rejects a copied membership_improved list", async () => {
    const root = await mkdtemp(join(tmpdir(), "mechanism-split-"));
    const mechanismPath = join(root, "mechanism.json");
    const built = receipt([question("q1", {
      delivered_hit: { control: false, treatment: true },
      field_member: { control: true, treatment: true }
    })]);
    expect(built.delivered_hit_changed).toEqual(["q1"]);
    expect(built.field_member_added).toEqual([]);
    await writeFile(mechanismPath, JSON.stringify(built));
    await expect(readRecallMechanismSplitArtifact(mechanismPath)).resolves.toEqual(built);

    await writeFile(mechanismPath, JSON.stringify({
      ...JSON.parse(JSON.stringify(built)),
      field_member_added: ["q1"]
    }));
    await expect(readRecallMechanismSplitArtifact(mechanismPath)).rejects.toThrow(
      /do not match its observations/u
    );

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
    await writeFile(mechanismPath, JSON.stringify({
      schema_version: 5, kind: "select_gamma_capture"
    }));
    await expect(readRecallMechanismSplitArtifact(mechanismPath)).rejects.toThrow(
      /lacks the v1 contract/u
    );
  });
});
