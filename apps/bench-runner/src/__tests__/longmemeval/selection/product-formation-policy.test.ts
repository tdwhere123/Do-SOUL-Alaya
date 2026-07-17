import { describe, expect, it } from "vitest";
import { assertProductFormationEnvironment } from "../../../longmemeval/promotion/product/product-formation-policy.js";
import { collectPairedEnvironment } from "../../../longmemeval/provenance/paired-environment.js";

describe("LongMemEval product formation policy", () => {
  it("accepts product defaults and their explicit enabled identity", () => {
    expect(() => assertProductFormationEnvironment({}, "snapshot producer"))
      .not.toThrow();
    expect(() => assertProductFormationEnvironment({
      ALAYA_INGEST_RECONCILIATION_ENABLED: "1",
      ALAYA_CONFLICT_DETECTION_ENABLED: "true",
      ALAYA_CONFLICT_RULE_ENABLED: "1",
      ALAYA_GARDEN_PROVIDER_KIND: "host_worker",
      ALAYA_RETAIN_UNROUTED_FACTS: "true",
      ALAYA_EVIDENCE_FULL_TURN: "1",
      ALAYA_MATERIALIZATION_CONF_FLOOR: "0.5",
      ALAYA_EDGE_PRODUCER_LLM_ENABLED: "false",
      ALAYA_EDGE_CLASSIFY_HOST_WORKER: "true",
      ALAYA_PATHREL_COUNTER_TTL_MS: "86400000",
      ALAYA_PATHREL_CO_USAGE_THRESHOLD: "3"
    }, "snapshot producer")).not.toThrow();
  });

  it.each([
    ["reconciliation", { ALAYA_INGEST_RECONCILIATION_ENABLED: "0" }],
    ["conflict detection", { ALAYA_CONFLICT_DETECTION_ENABLED: "false" }],
    ["conflict rule", { ALAYA_CONFLICT_RULE_ENABLED: "0" }],
    ["Garden provider", { ALAYA_GARDEN_PROVIDER_KIND: "local_heuristics" }],
    ["unrouted facts", { ALAYA_RETAIN_UNROUTED_FACTS: "false" }],
    ["evidence excerpt", { ALAYA_EVIDENCE_FULL_TURN: "0" }],
    ["confidence floor", { ALAYA_MATERIALIZATION_CONF_FLOOR: "0.9" }],
    ["edge LLM", { ALAYA_EDGE_PRODUCER_LLM_ENABLED: "true" }],
    ["edge host worker", { ALAYA_EDGE_CLASSIFY_HOST_WORKER: "false" }],
    ["path TTL", { ALAYA_PATHREL_COUNTER_TTL_MS: "1" }],
    ["path threshold", { ALAYA_PATHREL_CO_USAGE_THRESHOLD: "9" }],
    ["conflict LLM route", { ALAYA_CONFLICT_LLM_PROVIDER_URL: "https://example.invalid" }],
    ["conflict LLM key", { ALAYA_CONFLICT_LLM_API_KEY: "secret" }]
  ])("rejects the stale benchmark %s override", (_label, env) => {
    expect(() => assertProductFormationEnvironment(env, "snapshot producer"))
      .toThrow(/product formation/u);
  });

  it("records the conflict route without persisting its credential", () => {
    const paired = collectPairedEnvironment({
      ALAYA_CONFLICT_LLM_PROVIDER_URL: "https://user:token@example.invalid/v1?key=secret",
      ALAYA_CONFLICT_LLM_API_KEY: "never-persist"
    });

    expect(paired.ALAYA_CONFLICT_LLM_PROVIDER_URL).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(paired).not.toHaveProperty("ALAYA_CONFLICT_LLM_API_KEY");
    expect(JSON.stringify(paired)).not.toContain("never-persist");
  });
});
