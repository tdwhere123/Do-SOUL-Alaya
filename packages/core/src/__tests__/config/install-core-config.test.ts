import { afterEach, describe, expect, it } from "vitest";
import {
  installCoreConfigFromProcessEnv,
  parseRecallRuntimeConfigFromEnv,
  recallEnvRaw,
  resolveCoreConfigEnvironmentKeys,
  resetCoreConfigForTests
} from "../../config/index.js";

const RECALL_ENV_FIXTURE = Object.freeze({
  ALAYA_RECALL_FACET_SLICE: "slice",
  ALAYA_RECALL_CONF_RHO_PATH: "0.11",
  ALAYA_RECALL_CONF_RHO_EVIDENCE: "0.22",
  ALAYA_RECALL_CONF_W_PATH: "0.33",
  ALAYA_RECALL_CONF_EVIDENCE_BETA: "0.44",
  ALAYA_RECALL_CONF_FLOOD_CAP: "0.55",
  ALAYA_RECALL_CONF_FLOOD_CAP_TOTAL: "0.66",
  ALAYA_RECALL_CONF_SLICE_COMPATIBILITY: "true",
  ALAYA_RECALL_PATH_EMB_MODULATION: "path-emb",
  ALAYA_RECALL_PROJECTIONS: "off",
  ALAYA_RECALL_LEXICAL_DECORR: "decorr",
  ALAYA_RECALL_INTENT_V2: "yes",
  ALAYA_RECALL_EXTRA_SYNONYM_CLUSTERS: "synonyms",
  ALAYA_RECALL_SESSION_ROUTE: "yes",
  ALAYA_RECALL_SEMANTIC_CUSTOM: "semantic-custom"
});

const EXPECTED_RECALL_ENV = Object.freeze({
  ...RECALL_ENV_FIXTURE,
  ALAYA_RECALL_CONF_SLICE_COMPATIBILITY: "on",
  ALAYA_RECALL_PROJECTIONS: "off",
  ALAYA_RECALL_INTENT_V2: "on",
  ALAYA_RECALL_SESSION_ROUTE: "on"
});

const RETIRED_RECALL_ENV_NAMES = Object.freeze([
  "ALAYA_RECALL_EMBED_POOL_RESCORE",
  "ALAYA_RECALL_QUERY_HYDE_JSON",
  "ALAYA_RECALL_COMPOSE",
  "ALAYA_RECALL_COMPOSE_CUSTOM",
  "ALAYA_RECALL_S4_COVERAGE",
  "ALAYA_RECALL_COVERAGE_SELECTOR",
  "ALAYA_RECALL_COVERAGE_POOL_K",
  "ALAYA_RECALL_COVERAGE_TARGET_K",
  "ALAYA_RECALL_COVERAGE_MIN_SCORE_RATIO",
  "ALAYA_RECALL_SESSION_COVERAGE_BAND",
  "ALAYA_RECALL_STRUCTURAL_RESERVE",
  "ALAYA_RECALL_FUSION_RANK_FLOOR",
  "ALAYA_RECALL_DELIVER_FUSED_ORDER",
  "ALAYA_RECALL_DELIVERY_WINDOW",
  "ALAYA_RECALL_NOW_ISO",
  "ALAYA_RECALL_TEMPORAL_WINDOW",
  "ALAYA_RECALL_FACET_OVERLAP"
]);

describe("installCoreConfigFromProcessEnv", () => {
  afterEach(() => {
    resetCoreConfigForTests();
  });

  it("round-trips every supported recall env lookup without name or value drift", () => {
    installCoreConfigFromProcessEnv(RECALL_ENV_FIXTURE);

    for (const [name, expected] of Object.entries(EXPECTED_RECALL_ENV)) {
      expect(recallEnvRaw(name), name).toBe(expected);
    }
  });

  it("preserves lookup defaults when recall env is absent", () => {
    installCoreConfigFromProcessEnv({});

    for (const name of Object.keys(RECALL_ENV_FIXTURE)) {
      const expected =
        name === "ALAYA_RECALL_PROJECTIONS" ? "on" : undefined;
      expect(recallEnvRaw(name), name).toBe(expected);
    }
    expect(recallEnvRaw("ALAYA_RECALL_UNKNOWN")).toBeUndefined();
  });

  it("does not install retired recall controls", () => {
    installCoreConfigFromProcessEnv(Object.fromEntries(
      RETIRED_RECALL_ENV_NAMES.map((name) => [name, "on"])
    ));

    for (const name of RETIRED_RECALL_ENV_NAMES) {
      expect(recallEnvRaw(name), name).toBeUndefined();
    }
  });
});

describe("core config environment contract", () => {
  it("enumerates exact keys and discovers supported dynamic prefixes", () => {
    const keys = resolveCoreConfigEnvironmentKeys({
      ...RECALL_ENV_FIXTURE,
      ALAYA_RECALL_SEMANTIC_LATE_BOUND: "0.5",
      ALAYA_UNRELATED_RUNTIME_SETTING: "untouched"
    });

    for (const name of [
      ...Object.keys(RECALL_ENV_FIXTURE),
      "ALAYA_EMBEDDING_BACKFILL_CONCURRENCY",
      "ALAYA_EMBEDDING_RECALL_TIERS",
      "ALAYA_EMBEDDING_WORKSPACE_SCAN_CAP",
      "ALAYA_PATHREL_CONTENT_STRENGTH"
    ]) {
      expect(keys, name).toContain(name);
    }
    expect(keys).not.toContain("ALAYA_UNRELATED_RUNTIME_SETTING");
  });
});

describe("parseRecallRuntimeConfigFromEnv", () => {
  it("does not expose retired per-query embedding controls", () => {
    const config = parseRecallRuntimeConfigFromEnv({
      ALAYA_RECALL_EMBED_POOL_RESCORE: "off",
      ALAYA_RECALL_QUERY_HYDE_JSON: "{\"query\":\"hypothesis\"}"
    });
    expect(config).not.toHaveProperty("embedPoolRescore");
    expect(config).not.toHaveProperty("queryHydeJson");
  });

  it("captures slice compatibility as default off", () => {
    expect(parseRecallRuntimeConfigFromEnv({})).toMatchObject({
      confSliceCompatibility: false
    });
  });

  it("accepts only explicit true spellings for slice compatibility", () => {
    const parse = (value: string): boolean => parseRecallRuntimeConfigFromEnv({
      ALAYA_RECALL_CONF_SLICE_COMPATIBILITY: value
    }).confSliceCompatibility;

    expect(["on", "1", "true"].map(parse)).toEqual([true, true, true]);
    expect(["off", "0", "false", "yes", "unexpected"].map(parse)).toEqual([
      false, false, false, false, false
    ]);
  });
});
