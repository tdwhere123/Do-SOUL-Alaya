import { describe, expect, it } from "vitest";
import { parseFlags } from "../../cli/cli-options.js";

describe("parseFlags", () => {
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
      "--extraction-cache-root=/tmp/cache",
      "--concurrency=4"
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
    expect(parsed.extractionCacheRoot).toBe("/tmp/cache");
    expect(parsed.concurrency).toBe(4);
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
  });
});
