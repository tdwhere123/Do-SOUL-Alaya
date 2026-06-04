import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ControlPlaneObjectKind, RetentionPolicy, type RecallPolicy } from "@do-soul/alaya-protocol";
import {
  applyBenchRecallWeightOverrides,
  formatBenchRecallWeightOverrides,
  resolveBenchRecallWeightOverrides
} from "../harness/recall-weight-overrides.js";
import { preflightEmbeddingProvider } from "../harness/embedding-provider-preflight.js";

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
          lexical_fts: 0.5
        }
      })
    });

    expect(overrides?.source).toBe("cli");
    expect(overrides?.summary.activation_weights_phase4b).toMatchObject({
      scope_match: 0.08,
      relevance: 0.2
    });
    expect(formatBenchRecallWeightOverrides(overrides!)).toContain("lexical_fts=0.5");

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
      lexical_fts: 0.5
    });
  });

  it("accepts every production fusion stream incl. trigram_fts / synthesis_fts", () => {
    const overrides = resolveBenchRecallWeightOverrides({
      cliJson: JSON.stringify({
        fusion_weights: {
          trigram_fts: 2,
          synthesis_fts: 1.5
        }
      })
    });

    expect(overrides?.summary.fusion_weights).toEqual({
      trigram_fts: 2,
      synthesis_fts: 1.5
    });

    const policy = applyBenchRecallWeightOverrides(basePolicy(), overrides);
    expect(policy.scoring_weight_overrides?.fusion_weights).toEqual({
      trigram_fts: 2,
      synthesis_fts: 1.5
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
            lexical_fts: -0.5
          }
        })
      })
    ).toThrow(/fusion_weights\.lexical_fts must be >= 0/);

    expect(() =>
      resolveBenchRecallWeightOverrides({
        cliJson: JSON.stringify({
          fusion_weights: {
            lexcial_fts: 0.5
          }
        })
      })
    ).toThrow(/fusion_weights contains unknown key\(s\): lexcial_fts/);
  });

  it("lets direct CLI JSON take precedence over the env JSON", () => {
    const overrides = resolveBenchRecallWeightOverrides({
      cliJson: JSON.stringify({ fusion_weights: { lexical_fts: 1 } }),
      envJson: JSON.stringify({ fusion_weights: { evidence_fts: 1 } })
    });

    expect(overrides?.source).toBe("cli");
    expect(overrides?.summary.fusion_weights).toEqual({ lexical_fts: 1 });
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
    expect(script).toContain("--data-dir) DATA_DIR=\"$2\"; shift 2;;");
    expect(script).toContain("weights_args=(--weights \"$WEIGHTS\")");
    expect(script).toContain("\"${weights_args[@]}\"");
    expect(script).toContain("--data-dir \"$DATA_DIR\"");
    expect(script).toContain("BENCH_NODE_USE_ENV_PROXY");
    expect(script).toContain("\"${NODE_RUNNER[@]}\" apps/bench-runner/bin/embedding-provider-preflight.mjs");
    expect(script).toContain("\"${NODE_RUNNER[@]}\" apps/bench-runner/bin/alaya-bench-runner.mjs longmemeval");
    expect(script).toContain("! -path '*/__tests__/*'");
    expect(script).toContain("! -name '*.test.ts'");
    expect(script).toContain("exited 1 after writing KPI; allowing merge");
    expect(script).toContain("allowing merge to enforce release hard gates");
  });

  it("preflights and forwards --data-dir from the full LoCoMo bench script", async () => {
    const script = await readFile(
      path.resolve(process.cwd(), "apps/bench-runner/scripts/run-full-locomo-bench.sh"),
      "utf8"
    );

    expect(script).toContain("--data-dir) DATA_DIR=\"$2\"; shift 2;;");
    expect(script).toContain("docs/bench-history/datasets/locomo10.meta.json");
    expect(script).toContain("apps/bench-runner/bin/alaya-bench-runner.mjs fetch-locomo --data-dir %q");
    expect(script).toContain("dataset cache missing: $DATASET_JSON");
    expect(script).toContain("dataset scratch meta missing: $SCRATCH_META");
    expect(script).toContain("dataset checksum mismatch: locomo10");
    expect(script).toContain("--data-dir \"$DATA_DIR\"");
    expect(script).toContain("BENCH_NODE_USE_ENV_PROXY");
    expect(script).toContain("ensure_bench_runner_build_fresh");
    expect(script).toContain("bench runner dist appears stale");
    expect(script).toContain("! -path '*/__tests__/*'");
    expect(script).toContain("! -name '*.test.ts'");
    expect(script).toContain("\"${NODE_RUNNER[@]}\" apps/bench-runner/bin/embedding-provider-preflight.mjs");
    expect(script).toContain("\"${NODE_RUNNER[@]}\" apps/bench-runner/bin/alaya-bench-runner.mjs locomo");
  });

  it("preflights with the production secret-ref resolver before provider fetch", async () => {
    let fetchCalls = 0;
    const result = await preflightEmbeddingProvider({
      env: {
        ALAYA_OPENAI_SECRET_REF: "file:relative-token",
        OPENAI_EMBEDDING_PROVIDER_URL: "https://embedding.example.test/v1"
      },
      fetchImpl: (async () => {
        fetchCalls += 1;
        return new Response("{}", { status: 200 });
      }) as typeof fetch
    });

    expect(result).toEqual({
      ok: false,
      message: "embedding provider preflight failed: secret_ref is malformed"
    });
    expect(fetchCalls).toBe(0);
  });

  it("does not include the resolved embedding secret in preflight failures", async () => {
    const env = {
      ALAYA_OPENAI_SECRET_REF: "env:ALAYA_TEST_OPENAI_KEY",
      ALAYA_TEST_OPENAI_KEY: "sk-test-secret",
      OPENAI_EMBEDDING_PROVIDER_URL: "https://embedding.example.test/v1"
    };
    const transportError = new TypeError("fetch failed") as TypeError & {
      cause: { code: string };
    };
    transportError.cause = { code: "EHOSTUNREACH" };

    const result = await preflightEmbeddingProvider({
      env,
      secretRefReader: {
        readEnv: (name) => env[name as keyof typeof env],
        readFile: () => {
          throw new Error("not used");
        },
        readKeychain: (service, account) => ({
          kind: "keychain_tooling_unavailable",
          service,
          account,
          reason: "not used"
        })
      },
      fetchImpl: (async () => {
        throw transportError;
      }) as typeof fetch
    });

    expect(result.message).toBe(
      "embedding provider preflight failed: host=embedding.example.test cause=EHOSTUNREACH"
    );
    expect(result.message).not.toContain("sk-test-secret");
  });
});
