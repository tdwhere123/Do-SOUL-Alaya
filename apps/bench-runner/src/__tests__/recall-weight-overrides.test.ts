import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ControlPlaneObjectKind, RetentionPolicy, type RecallPolicy } from "@do-soul/alaya-protocol";
import {
  applyBenchRecallWeightOverrides,
  formatBenchRecallWeightOverrides,
  resolveBenchRecallWeightOverrides
} from "../harness/recall-weight-overrides.js";

function basePolicy(): RecallPolicy {
  return {
    runtime_id: "70a0b18b-5f8b-4fd2-a1b0-97ce48113fca",
    object_kind: ControlPlaneObjectKind.RECALL_POLICY,
    task_surface_ref: "surface://bench",
    expires_at: null,
    derived_from: null,
    retention_policy: RetentionPolicy.SESSION_ONLY,
    coarse_filter: {
      deterministic_match: {
        scope_filter: null,
        dimension_filter: null,
        domain_tag_filter: null
      },
      precomputed_rank: {
        max_candidates: 10,
        min_activation_score: null
      },
      semantic_supplement: {
        enabled: true,
        max_supplement: 10,
        embedding_enabled: true
      }
    },
    fine_assessment: {
      budgets: {
        max_total_tokens: 2000,
        max_entries: 10,
        per_dimension_limits: null
      },
      conflict_awareness: true
    }
  };
}

describe("bench recall weight overrides", () => {
  it("parses CLI JSON and applies bench-only policy fields", () => {
    const overrides = resolveBenchRecallWeightOverrides({
      cliJson: JSON.stringify({
        activation_weights_phase4b: {
          scope_match: 0.08,
          relevance: 0.2
        },
        additive: {
          NO_EMBEDDING_RELEVANCE_DIRECT_WEIGHT: 0.2,
          CONFIDENCE_DIRECT_WEIGHT: 0.1,
          PATH_PLASTICITY_WEIGHT: 0.12
        },
        fusion_weights: {
          future_signal: 0.5
        }
      })
    });

    expect(overrides?.source).toBe("cli");
    expect(overrides?.summary.activation_weights_phase4b).toMatchObject({
      scope_match: 0.08,
      relevance: 0.2
    });
    expect(formatBenchRecallWeightOverrides(overrides!)).toContain("future_signal=0.5");

    const policy = applyBenchRecallWeightOverrides(basePolicy(), overrides);
    expect(policy.domain_weight_overrides?.["bench-seed"]).toEqual({
      scope_match: 0.08,
      relevance: 0.2
    });
    expect(policy.domain_weight_overrides?.["bench-reviewed"]).toEqual({
      scope_match: 0.08,
      relevance: 0.2
    });
    expect(policy.scoring_weight_overrides?.additive).toEqual({
      NO_EMBEDDING_RELEVANCE_DIRECT_WEIGHT: 0.2,
      CONFIDENCE_DIRECT_WEIGHT: 0.1,
      PATH_PLASTICITY_WEIGHT: 0.12
    });
    expect(policy.scoring_weight_overrides?.fusion_weights).toEqual({
      future_signal: 0.5
    });
  });

  it("rejects partial activation overrides that do not resolve to sum 1", () => {
    expect(() =>
      resolveBenchRecallWeightOverrides({
        cliJson: JSON.stringify({
          activation_weights_phase4b: {
            relevance: 0.2
          }
        })
      })
    ).toThrow(/activation_weights_phase4b must sum to 1\.0/);
  });

  it("rejects invalid additive and fusion weights", () => {
    expect(() =>
      resolveBenchRecallWeightOverrides({
        cliJson: JSON.stringify({
          additive: {
            CONFIDENCE_DIRECT_WEIGHT: -0.1
          }
        })
      })
    ).toThrow(/additive\.CONFIDENCE_DIRECT_WEIGHT must be >= 0/);

    expect(() =>
      resolveBenchRecallWeightOverrides({
        cliJson: JSON.stringify({
          fusion_weights: {
            future_signal: -0.5
          }
        })
      })
    ).toThrow(/fusion_weights\.future_signal must be >= 0/);
  });

  it("lets direct CLI JSON take precedence over the env JSON", () => {
    const overrides = resolveBenchRecallWeightOverrides({
      cliJson: JSON.stringify({ fusion_weights: { cli_signal: 1 } }),
      envJson: JSON.stringify({ fusion_weights: { env_signal: 1 } })
    });

    expect(overrides?.source).toBe("cli");
    expect(overrides?.summary.fusion_weights).toEqual({ cli_signal: 1 });
  });

  it("parses env JSON when direct CLI JSON is absent", () => {
    const overrides = resolveBenchRecallWeightOverrides({
      envJson: JSON.stringify({
        additive: {
          PATH_PLASTICITY_WEIGHT: 0.12
        }
      })
    });

    expect(overrides?.source).toBe("env");
    expect(overrides?.summary.additive).toEqual({
      PATH_PLASTICITY_WEIGHT: 0.12
    });
  });

  it("exposes and forwards --weights from the sharded public bench script", async () => {
    const script = await readFile(
      path.resolve(process.cwd(), "apps/bench-runner/scripts/run-full-public-bench.sh"),
      "utf8"
    );

    expect(script).toContain("--weights) WEIGHTS=\"$2\"; shift 2;;");
    expect(script).toContain("weights_args=(--weights \"$WEIGHTS\")");
    expect(script).toContain("\"${weights_args[@]}\"");
  });
});
