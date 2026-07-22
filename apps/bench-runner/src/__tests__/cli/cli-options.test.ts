import { describe, expect, it } from "vitest";
import { parseFlags } from "../../cli/cli-options.js";

describe("parseFlags", () => {
  it("defaults the benchmark embedding provider to local ONNX", () => {
    expect(parseFlags([]).embeddingProviderKind).toBe("local_onnx");
  });

  it("collects shard paths until the next flag and resolves variant aliases", () => {
    const parsed = parseFlags([
      "--variant",
      "s",
      "--shards",
      "shard-a",
      "shard-b",
      "--limit",
      "2",
      "--edge-plane"
    ]);

    expect(parsed.variant).toBe("longmemeval_s");
    expect(parsed.shards).toEqual(["shard-a", "shard-b"]);
    expect(parsed.limit).toBe(2);
    expect(parsed.edgePlane).toBe(true);
  });

  it("parses inline long flags for provider, policy, weights, snapshot, and concurrency", () => {
    const parsed = parseFlags([
      "--embedding",
      "env",
      "--embedding-provider=local_onnx",
      "--policy-shape=chat",
      "--simulate-report=mixed",
      "--weights={\"foo\":1}",
      "--snapshot=/tmp/snapshot.db",
      "--snapshot-out=/tmp/out.db",
      "--data-dir-root=/tmp/data-dir",
      "--pinned-meta-root=/tmp/pinned",
      "--question-manifest=/tmp/questions.json",
      "--extraction-cache-root=/tmp/cache",
      "--promotion-contract=/tmp/promotion.json",
      "--r3-spend-approval=/tmp/r3-spend-approval.json",
      "--legacy-snapshot",
      `--legacy-manifest-sha256=${"a".repeat(64)}`,
      `--legacy-dataset-sha256=${"b".repeat(64)}`,
      "--concurrency=4",
      "--extraction-initial-concurrency=8",
      "--question-batch-limit=100"
    ]);

    expect(parsed.embeddingMode).toBe("env");
    expect(parsed.embeddingProviderKind).toBe("local_onnx");
    expect(parsed.policyShape).toBe("chat");
    expect(parsed.simulateReport).toBe("mixed");
    expect(parsed.weightOverridesJson).toBe("{\"foo\":1}");
    expect(parsed.snapshot).toBe("/tmp/snapshot.db");
    expect(parsed.snapshotOut).toBe("/tmp/out.db");
    expect(parsed.dataDirRoot).toBe("/tmp/data-dir");
    expect(parsed.pinnedMetaRoot).toBe("/tmp/pinned");
    expect(parsed.questionManifest).toBe("/tmp/questions.json");
    expect(parsed.extractionCacheRoot).toBe("/tmp/cache");
    expect(parsed.promotionContract).toBe("/tmp/promotion.json");
    expect(parsed.r3SpendApproval).toBe("/tmp/r3-spend-approval.json");
    expect(parsed.legacySnapshot).toBe(true);
    expect(parsed.legacyManifestSha256).toBe("a".repeat(64));
    expect(parsed.legacyDatasetSha256).toBe("b".repeat(64));
    expect(parsed.concurrency).toBe(4);
    expect(parsed.extractionInitialConcurrency).toBe(8);
    expect(parsed.questionBatchLimit).toBe(100);
  });

  it("rejects invalid enumerated options", () => {
    expect(() => parseFlags(["--embedding-provider", "bogus"])).toThrow(
      "--embedding-provider must be one of: openai, local_onnx"
    );
    expect(() => parseFlags(["--policy-shape", "wide"])).toThrow(
      "--policy-shape must be one of: stress, chat"
    );
    expect(() => parseFlags(["--simulate-report", "goldish"])).toThrow(
      "--simulate-report must be one of: none, always-used, gold-only, mixed"
    );
    expect(() => parseFlags(["--question-manifest"])).toThrow(
      "--question-manifest requires a path"
    );
    expect(() => parseFlags(["--promotion-contract", "--limit", "500"])).toThrow(
      "--promotion-contract requires a path"
    );
    expect(() => parseFlags(["--r3-spend-approval", "--limit", "500"])).toThrow(
      "--r3-spend-approval requires a path"
    );
    expect(() => parseFlags([
      "--extraction-predecessor-authority", "/tmp/a.json",
      "--extraction-predecessor-authority=/tmp/b.json"
    ])).toThrow("--extraction-predecessor-authority may be provided only once");
  });
});
