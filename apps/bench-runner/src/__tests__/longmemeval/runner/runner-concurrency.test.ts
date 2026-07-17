import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildLongMemEvalWorkerEnvOverrides,
  buildLongMemEvalWorkerShardPlans,
  freezeProcessEnvForWorkers,
  validateLongMemEvalConcurrency
} from "../../../longmemeval/runner/runner-concurrency.js";

describe("buildLongMemEvalWorkerEnvOverrides", () => {
  it("adds shared ONNX single-flight env when concurrency>1 and embeddingMode=env", () => {
    const shardRoot = "/tmp/lme-shards";
    const historyRoot = join(shardRoot, "shard-0");
    const env = freezeProcessEnvForWorkers(
      {},
      buildLongMemEvalWorkerEnvOverrides({
        concurrency: 2,
        embeddingMode: "env",
        shardRoot,
        historyRoot
      })
    );
    expect(env.ALAYA_BENCH_ARTIFACT_ROOT).toBe(
      join(historyRoot, ".bench-artifacts")
    );
    expect(env.ALAYA_LOCAL_ONNX_HOST_SINGLE_FLIGHT).toBe("1");
    expect(env.ALAYA_LOCAL_ONNX_LOCK_PATH).toBe(
      join(shardRoot, "local-onnx-inference.lock")
    );
  });

  it("preserves artifact root only when embedding is disabled", () => {
    const shardRoot = "/tmp/lme-shards";
    const historyRoot = join(shardRoot, "shard-0");
    const env = buildLongMemEvalWorkerEnvOverrides({
      concurrency: 2,
      embeddingMode: "disabled",
      shardRoot,
      historyRoot
    });
    expect(env.ALAYA_BENCH_ARTIFACT_ROOT).toBe(
      join(historyRoot, ".bench-artifacts")
    );
    expect(env.ALAYA_LOCAL_ONNX_HOST_SINGLE_FLIGHT).toBeUndefined();
    expect(env.ALAYA_LOCAL_ONNX_LOCK_PATH).toBeUndefined();
  });

  it("adds shared ONNX single-flight env for a cross-only parallel arm", () => {
    const env = buildLongMemEvalWorkerEnvOverrides({
      concurrency: 2,
      embeddingMode: "disabled",
      crossEncoderEnabled: true,
      shardRoot: "/tmp/lme-shards",
      historyRoot: "/tmp/lme-shards/shard-0"
    });
    expect(env.ALAYA_LOCAL_ONNX_HOST_SINGLE_FLIGHT).toBe("1");
    expect(env.ALAYA_LOCAL_ONNX_LOCK_PATH).toContain("local-onnx-inference.lock");
  });
});

describe("buildLongMemEvalWorkerShardPlans", () => {
  it("splits the window evenly across process-backed workers", () => {
    const shardRoot = join(tmpdir(), "lme-shards");
    const plans = buildLongMemEvalWorkerShardPlans({
      windowLength: 10,
      baseOffset: 5,
      concurrency: 3,
      shardRoot
    });

    expect(plans).toEqual([
      {
        shardIndex: 0,
        offset: 5,
        limit: 4,
        historyRoot: join(shardRoot, "shard-0")
      },
      {
        shardIndex: 1,
        offset: 9,
        limit: 4,
        historyRoot: join(shardRoot, "shard-1")
      },
      {
        shardIndex: 2,
        offset: 13,
        limit: 2,
        historyRoot: join(shardRoot, "shard-2")
      }
    ]);
  });
});

describe("validateLongMemEvalConcurrency", () => {
  it("refuses unsupported flag combinations loudly", () => {
    expect(() =>
      validateLongMemEvalConcurrency({
        variant: "longmemeval_s",
        historyRoot: "/tmp/history",
        concurrency: 2,
        snapshotOut: "/tmp/snapshot.db"
      })
    ).toThrow(/--concurrency > 1 is incompatible with --snapshot-out/);

    expect(() =>
      validateLongMemEvalConcurrency({
        variant: "longmemeval_s",
        historyRoot: "/tmp/history",
        concurrency: 2,
        dataDirRoot: "/tmp/db"
      })
    ).toThrow(/--concurrency > 1 is incompatible with --data-dir-root/);

    expect(() =>
      validateLongMemEvalConcurrency({
        variant: "longmemeval_s",
        historyRoot: "/tmp/history",
        concurrency: 2,
        qa: {
          chat: async () => "answer",
          answerModel: "test",
          judgeModel: "test"
        }
      })
    ).toThrow(/--concurrency > 1 is incompatible with --qa/);
  });

  it("rejects question manifests instead of silently sharding a different sample", () => {
    expect(() =>
      validateLongMemEvalConcurrency({
        variant: "longmemeval_s",
        historyRoot: "/tmp/history",
        concurrency: 2,
        questionManifest: "/tmp/questions.json"
      })
    ).toThrow(/question-manifest.*concurrency/u);
  });
});
