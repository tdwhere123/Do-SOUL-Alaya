import { afterEach, describe, expect, it } from "vitest";
import {
  getCoreConfig,
  installCoreConfigFromProcessEnv,
  parseRecallRuntimeConfigFromEnv,
  resetCoreConfigForTests
} from "../../config/index.js";

describe("installCoreConfigFromProcessEnv", () => {
  afterEach(() => {
    resetCoreConfigForTests();
  });

  it("defaults embed pool rescore to enabled", () => {
    installCoreConfigFromProcessEnv({});
    expect(getCoreConfig().recall.embedPoolRescore).toBe(true);
  });

  it("parses compose flag from env", () => {
    installCoreConfigFromProcessEnv({ ALAYA_RECALL_COMPOSE: "on" });
    expect(getCoreConfig().recall.compose).toBe(true);
  });

  it("merges config file env when process env is unset", () => {
    const configEnv = new Map<string, string>([["ALAYA_RECALL_COMPOSE", "1"]]);
    installCoreConfigFromProcessEnv({}, configEnv);
    expect(getCoreConfig().recall.compose).toBe(true);
  });

  it("process env wins over config file env", () => {
    const configEnv = new Map<string, string>([["ALAYA_RECALL_COMPOSE", "1"]]);
    installCoreConfigFromProcessEnv({ ALAYA_RECALL_COMPOSE: "off" }, configEnv);
    expect(getCoreConfig().recall.compose).toBe(false);
  });
});

describe("parseRecallRuntimeConfigFromEnv", () => {
  it("opt-outs embed pool rescore", () => {
    const config = parseRecallRuntimeConfigFromEnv({ ALAYA_RECALL_EMBED_POOL_RESCORE: "off" });
    expect(config.embedPoolRescore).toBe(false);
  });
});
