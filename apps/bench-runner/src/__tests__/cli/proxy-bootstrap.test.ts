import { describe, expect, it } from "vitest";
import { planBenchCliEnvProxyBootstrap } from "../../cli/proxy-bootstrap.js";

describe("bench CLI proxy bootstrap", () => {
  it.each([
    { env: { NODE_OPTIONS: "--use-env-proxy" }, execArgv: [] },
    { env: { NODE_OPTIONS: '"--use-env-proxy"' }, execArgv: [] },
    { env: { NODE_OPTIONS: "--no-use-env-proxy", NODE_USE_ENV_PROXY: "1" }, execArgv: [] },
    { env: { NODE_OPTIONS: "--use-env-proxy" }, execArgv: ["--no-use-env-proxy"] },
    { env: {}, execArgv: ["--use-env-proxy", "--no-use-env-proxy"] }
  ])("does not override an explicit native proxy decision: %j", ({ env, execArgv }) => {
    expect(planBenchCliEnvProxyBootstrap({ argv: [], env: { HTTPS_PROXY: "http://proxy.example", ...env },
      execArgv, entryPath: "/bin.mjs", supportsEnvProxy: true })).toBeNull();
  });

  it("re-execs Node with env-proxy support when a standard proxy is configured", () => {
    expect(planBenchCliEnvProxyBootstrap({
      argv: ["extraction-fill", "--limit", "100"],
      env: { HTTPS_PROXY: "http://proxy.example:8080" },
      execArgv: [],
      entryPath: "/repo/bin/alaya-bench-runner.mjs",
      supportsEnvProxy: true
    })).toEqual({
      argv: [
        "--use-env-proxy",
        "/repo/bin/alaya-bench-runner.mjs",
        "extraction-fill",
        "--limit",
        "100"
      ],
      env: expect.objectContaining({ ALAYA_BENCH_ENV_PROXY_BOOTSTRAPPED: "1" })
    });
  });

  it("does not recurse or re-exec without a configured proxy", () => {
    expect(planBenchCliEnvProxyBootstrap({
      argv: [], env: {}, execArgv: [], entryPath: "/bin.mjs", supportsEnvProxy: true
    })).toBeNull();
    expect(planBenchCliEnvProxyBootstrap({
      argv: [],
      env: { HTTPS_PROXY: "http://proxy.example", ALAYA_BENCH_ENV_PROXY_BOOTSTRAPPED: "1" },
      execArgv: [], entryPath: "/bin.mjs", supportsEnvProxy: true
    })).toBeNull();
  });

  it("fails closed when the active Node runtime cannot honor proxy variables", () => {
    expect(() => planBenchCliEnvProxyBootstrap({
      argv: [], env: { HTTP_PROXY: "http://proxy.example" }, execArgv: [],
      entryPath: "/bin.mjs", supportsEnvProxy: false
    })).toThrow(/does not support --use-env-proxy/u);
  });
});
