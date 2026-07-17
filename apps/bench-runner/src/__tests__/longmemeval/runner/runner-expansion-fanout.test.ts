import { describe, expect, it } from "vitest";
import {
  assertExactLongMemEvalShardCoverage,
  buildCredentiallessLongMemEvalWorkerEnv,
  buildLongMemEvalWorkerCliArgs,
  validateLongMemEvalConcurrency
} from "../../../longmemeval/runner/runner-concurrency.js";

describe("LongMemEval expansion fan-out contracts", () => {
  it.each([0, 33])("rejects process concurrency %s", (concurrency) => {
    expect(() => validateLongMemEvalConcurrency({
      variant: "longmemeval_s",
      historyRoot: "/history",
      concurrency
    })).toThrow(/concurrency must be an integer from 1 to 32/u);
  });

  it("passes the same promotion contract path to every child", () => {
    const args = buildLongMemEvalWorkerCliArgs({
      variant: "longmemeval_s",
      historyRoot: "/history",
      embeddingMode: "env",
      promotionContractPath: "/evidence/promotion.json"
    }, {
      shardIndex: 0,
      offset: 0,
      limit: 16,
      historyRoot: "/shards/shard-0"
    });

    expect(args).toContain("--promotion-contract");
    expect(args[args.indexOf("--promotion-contract") + 1])
      .toBe("/evidence/promotion.json");
  });

  it("accepts only an exact gap-free, overlap-free 0..500 shard plan", () => {
    const exact = [
      { shardIndex: 0, offset: 0, limit: 250, historyRoot: "/s/0" },
      { shardIndex: 1, offset: 250, limit: 250, historyRoot: "/s/1" }
    ];
    expect(() => assertExactLongMemEvalShardCoverage(exact, 500)).not.toThrow();
    expect(() => assertExactLongMemEvalShardCoverage([
      exact[0]!, { ...exact[1]!, offset: 251, limit: 249 }
    ], 500)).toThrow(/gap or overlap/u);
    expect(() => assertExactLongMemEvalShardCoverage([
      exact[0]!, { ...exact[1]!, offset: 249, limit: 251 }
    ], 500)).toThrow(/gap or overlap/u);
  });

  it("removes remote credentials while preserving local ONNX fanout state", () => {
    const env = buildCredentiallessLongMemEvalWorkerEnv({
      PATH: "/bin",
      OPENAI_API_KEY: "secret",
      QA_PROVIDER_URL: "https://qa.invalid",
      ALAYA_QA_MODEL: "remote-model",
      ALAYA_CONFLICT_LLM_API_KEY: "secret",
      ALAYA_GARDEN_PROVIDER_URL: "https://garden.invalid",
      OFFICIAL_API_GARDEN_MODEL: "remote-model",
      SOME_SECRET_REF: "vault://secret",
      ALAYA_LOCAL_EMBEDDING_MODEL:
        "Xenova/paraphrase-multilingual-MiniLM-L12-v2",
      ALAYA_LOCAL_ONNX_HOST_SINGLE_FLIGHT: "1"
    }, {
      ALAYA_LONGMEMEVAL_FANOUT_SHA256: "a".repeat(64)
    });

    expect(env).toMatchObject({
      PATH: "/bin",
      ALAYA_LOCAL_EMBEDDING_MODEL:
        "Xenova/paraphrase-multilingual-MiniLM-L12-v2",
      ALAYA_LOCAL_ONNX_HOST_SINGLE_FLIGHT: "1",
      ALAYA_LONGMEMEVAL_FANOUT_SHA256: "a".repeat(64)
    });
    expect(Object.keys(env)).not.toEqual(expect.arrayContaining([
      "OPENAI_API_KEY",
      "QA_PROVIDER_URL",
      "ALAYA_QA_MODEL",
      "ALAYA_CONFLICT_LLM_API_KEY",
      "ALAYA_GARDEN_PROVIDER_URL",
      "OFFICIAL_API_GARDEN_MODEL",
      "SOME_SECRET_REF"
    ]));
  });
});
