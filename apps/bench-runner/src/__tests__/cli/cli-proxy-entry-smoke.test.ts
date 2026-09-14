import { describe, expect, it } from "vitest";
import { parseFlags } from "../../cli/cli-options.js";
import { planBenchCliEnvProxyBootstrap } from "../../cli/proxy-bootstrap.js";
import { resolveBenchCommitInfo, resolveBenchRunnerVersion } from "../../shared/version.js";

describe("bench-runner entry smoke", () => {
  it("plans proxy bootstrap without spawning when argv is empty", () => {
    const plan = planBenchCliEnvProxyBootstrap({
      argv: [],
      env: {},
      execArgv: [],
      entryPath: "/tmp/alaya-bench-runner.mjs",
      supportsEnvProxy: false
    });
    expect(plan).toBeNull();
  });

  it("resolves package version and commit metadata from the live tree", () => {
    expect(resolveBenchRunnerVersion()).toMatch(/^\d+\.\d+\.\d+/u);
    const commit = resolveBenchCommitInfo({ BENCH_COMMIT_SHA7: "abcdef1234567890" });
    expect(commit.sha7).toBe("abcdef1");
    expect(commit.source).toBe("env");
  });

  it("parses default CLI flags without invoking daemon-backed commands", () => {
    const parsed = parseFlags([]);
    expect(parsed.embeddingProviderKind).toBe("local_onnx");
  });
});
