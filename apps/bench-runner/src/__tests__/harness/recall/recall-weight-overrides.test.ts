import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ControlPlaneObjectKind, RetentionPolicy, type RecallPolicy } from "@do-soul/alaya-protocol";
import {
  applyBenchRecallWeightOverrides,
  resolveBenchRecallWeightOverrides
} from "../../../harness/recall/recall-weight-overrides.js";
import { preflightEmbeddingProvider } from "../../../harness/embedding/embedding-provider-preflight.js";

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
  it("rejects retired selectors from both CLI and environment", () => {
    for (const key of ["fusion_weights", "activation_weights_phase4b", "additive"]) {
      const raw = JSON.stringify({ [key]: { relevance: 1 } });
      expect(() => resolveBenchRecallWeightOverrides({ cliJson: raw })).toThrow(/retired/);
      expect(() => resolveBenchRecallWeightOverrides({ envJson: raw })).toThrow(/retired/);
    }
    expect(resolveBenchRecallWeightOverrides({})).toBeUndefined();
    const policy = basePolicy();
    expect(applyBenchRecallWeightOverrides(policy, undefined)).toBe(policy);
    expect(() => applyBenchRecallWeightOverrides(policy, {
      source: "cli", summary: { source: "cli", fusion_weights: { lexical_fts: 1 } }
    })).toThrow(/retired/);
  });

  it("rejects retired weights while forwarding supported bench options", async () => {
    const script = await readFile(
      path.resolve(process.cwd(), "apps/bench-runner/scripts/run-full-public-bench.sh"),
      "utf8"
    );

    expect(script).toContain("--weights is retired");
    expect(script).toContain("--embedding-provider) EMBEDDING_PROVIDER=\"$2\"; shift 2;;");
    expect(script).toContain("EMBEDDING_PROVIDER=\"local_onnx\"");
    expect(script).toContain("--data-dir) DATA_DIR=\"$2\"; shift 2;;");
    expect(script).not.toContain("weights_args");
    expect(script).toContain("--data-dir \"$DATA_DIR\"");
    expect(script).toContain("BENCH_NODE_USE_ENV_PROXY");
    expect(script).toContain("\"${NODE_RUNNER[@]}\" apps/bench-runner/bin/embedding-provider-preflight.mjs");
    expect(script).toContain("--embedding-provider \"$EMBEDDING_PROVIDER\"");
    expect(script).toContain("\"${NODE_RUNNER[@]}\" apps/bench-runner/bin/alaya-bench-runner.mjs longmemeval");
    expect(script).toContain("BENCH_RUNNER_CLI=\"apps/bench-runner/dist/cli/index.js\"");
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
    expect(script).toContain("--embedding-provider) EMBEDDING_PROVIDER=\"$2\"; shift 2;;");
    expect(script).toContain("EMBEDDING_PROVIDER=\"local_onnx\"");
    expect(script).toContain("docs/bench-history/datasets/locomo10.meta.json");
    expect(script).toContain("apps/bench-runner/bin/alaya-bench-runner.mjs fetch-locomo --data-dir %q");
    expect(script).toContain("dataset cache missing: $DATASET_JSON");
    expect(script).toContain("dataset scratch meta missing: $SCRATCH_META");
    expect(script).toContain("dataset checksum mismatch: locomo10");
    expect(script).toContain("--data-dir \"$DATA_DIR\"");
    expect(script).toContain("BENCH_NODE_USE_ENV_PROXY");
    expect(script).toContain("ensure_bench_runner_build_fresh");
    expect(script).toContain("bench runner dist appears stale");
    expect(script).toContain("BENCH_RUNNER_CLI=\"apps/bench-runner/dist/cli/index.js\"");
    expect(script).toContain("! -path '*/__tests__/*'");
    expect(script).toContain("! -name '*.test.ts'");
    expect(script).toContain("\"${NODE_RUNNER[@]}\" apps/bench-runner/bin/embedding-provider-preflight.mjs");
    expect(script).toContain("--embedding-provider \"$EMBEDDING_PROVIDER\"");
    expect(script).toContain("\"${NODE_RUNNER[@]}\" apps/bench-runner/bin/alaya-bench-runner.mjs locomo");
  });

  it("preflights with the production secret-ref resolver before provider fetch", async () => {
    let fetchCalls = 0;
    const result = await preflightEmbeddingProvider({
      env: {
        ALAYA_EMBEDDING_PROVIDER: "openai",
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
      ALAYA_EMBEDDING_PROVIDER: "openai",
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
