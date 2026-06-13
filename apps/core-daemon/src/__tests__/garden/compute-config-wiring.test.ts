import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ALAYA_EDGE_CLASSIFY_HOST_WORKER_ENV,
  ALAYA_EDGE_PRODUCER_LLM_ENABLED_ENV,
  ALAYA_OFFICIAL_GARDEN_SECRET_REF_ENV,
  resolveEdgeClassifyWiring,
  readOfficialGardenSecretRef
} from "../../runtime/daemon-runtime-support.js";
import { resolveGardenOpenAiCredential } from "../../garden/index.js";

/**
 * C1 wiring tests — verify the env readers honour the new
 * Garden-compute-only env vars introduced by Codex's diagnostic finding
 * B-PL1 (Garden config previously piggy-backed on embedding's secret).
 *
 * `readOfficialGardenSecretRef` resolves env: refs against process.env, so
 * tests that pass an env: ref must seed the corresponding key.
 */
describe("Garden compute env readers (C1)", () => {
  const seededKeys = new Set<string>();
  beforeEach(() => {
    seededKeys.clear();
  });
  afterEach(() => {
    for (const key of seededKeys) {
      delete process.env[key];
    }
  });
  function seedProcessEnv(key: string, value: string): void {
    process.env[key] = value;
    seededKeys.add(key);
  }

  it("reads ALAYA_OFFICIAL_GARDEN_SECRET_REF as the dedicated Garden key source", () => {
    seedProcessEnv("GARDEN_API_KEY", "sk-test-garden");
    const env = new Map([
      [ALAYA_OFFICIAL_GARDEN_SECRET_REF_ENV, "env:GARDEN_API_KEY"]
    ]);
    // Resolved value is the secret value (not the env: ref) — the resolver
    // walks the process.env to fetch the actual key.
    expect(readOfficialGardenSecretRef(env)).toBe("sk-test-garden");
  });

  it("returns null when the dedicated Garden secret_ref env is absent", () => {
    const env = new Map([
      ["ALAYA_OPENAI_SECRET_REF", "env:OPENAI_API_KEY"]
    ]);
    expect(readOfficialGardenSecretRef(env)).toBeNull();
  });

  it("returns null for an empty/whitespace Garden secret_ref env", () => {
    const env = new Map([[ALAYA_OFFICIAL_GARDEN_SECRET_REF_ENV, "   "]]);
    expect(readOfficialGardenSecretRef(env)).toBeNull();
  });

  it("rejects malformed secret_ref values via readOptionalSecretRef shape rules", () => {
    const env = new Map([
      [ALAYA_OFFICIAL_GARDEN_SECRET_REF_ENV, "this-has-no-prefix"]
    ]);
    expect(() => readOfficialGardenSecretRef(env)).toThrow();
  });

  it("degrades Garden official API to unavailable when a dedicated env secret is missing", () => {
    const env = new Map([
      [ALAYA_OFFICIAL_GARDEN_SECRET_REF_ENV, "env:ALAYA_MISSING_GARDEN_KEY"]
    ]);

    expect(resolveGardenOpenAiCredential({ env: {}, configEnv: env })).toEqual({
      apiKey: null,
      provenance: { kind: "none" }
    });
  });

  it("degrades deprecated embedding fallback when its env secret is missing", () => {
    const env = new Map([
      ["ALAYA_OPENAI_SECRET_REF", "env:ALAYA_MISSING_OPENAI_KEY"]
    ]);

    expect(resolveGardenOpenAiCredential({ env: {}, configEnv: env })).toEqual({
      apiKey: null,
      provenance: { kind: "embedding-fallback" }
    });
  });

  it("rejects malformed Garden secret refs on the live credential resolver", () => {
    const env = new Map([
      [ALAYA_OFFICIAL_GARDEN_SECRET_REF_ENV, "this-has-no-prefix"]
    ]);

    expect(() => resolveGardenOpenAiCredential({ env: {}, configEnv: env })).toThrow(
      "ALAYA_OFFICIAL_GARDEN_SECRET_REF"
    );
  });

  it("rejects empty Garden secret values on the live credential resolver", () => {
    const env = new Map([
      [ALAYA_OFFICIAL_GARDEN_SECRET_REF_ENV, "env:ALAYA_EMPTY_GARDEN_KEY"]
    ]);

    expect(() =>
      resolveGardenOpenAiCredential({
        env: { ALAYA_EMPTY_GARDEN_KEY: "   " },
        configEnv: env
      })
    ).toThrow("secret is empty");
  });

});

// K4.5 zero-cloud-by-default regression: resolveEdgeClassifyWiring is the PURE
// decision index.ts uses to choose cloud llmPort vs the host-worker EDGE_CLASSIFY
// defer queue vs heuristic-only. A regression that flips the default back to a
// synchronous cloud call changes this function's output and is caught here.
// see also: apps/core-daemon/src/runtime/daemon-runtime-support.ts:resolveEdgeClassifyWiring
// see also: apps/core-daemon/src/index.ts:edgeClassifyWiring
describe("resolveEdgeClassifyWiring (K4.5 zero-cloud default)", () => {
  it("DEFAULT (no opt-in env, provider_kind=host_worker) -> host_worker_defer, no cloud llm", () => {
    const wiring = resolveEdgeClassifyWiring(
      {},
      { provider_kind: "host_worker" }
    );
    expect(wiring.mode).toBe("host_worker_defer");
    // The cloud edge-LLM is NOT enabled — no synchronous cloud port intent.
    expect(wiring.llmEnabled).toBe(false);
    expect(wiring.hostWorkerEnabled).toBe(true);
  });

  it("explicit cloud opt-in only (provider_kind=official_api) -> cloud_llm", () => {
    const wiring = resolveEdgeClassifyWiring(
      { [ALAYA_EDGE_PRODUCER_LLM_ENABLED_ENV]: "1" },
      { provider_kind: "official_api" }
    );
    expect(wiring.mode).toBe("cloud_llm");
    expect(wiring.llmEnabled).toBe(true);
    expect(wiring.hostWorkerEnabled).toBe(false);
  });

  it("host-worker defer WINS over a simultaneous cloud opt-in (mutual exclusion)", () => {
    const wiring = resolveEdgeClassifyWiring(
      { [ALAYA_EDGE_PRODUCER_LLM_ENABLED_ENV]: "true" },
      { provider_kind: "host_worker" }
    );
    // Even with the cloud opt-in flag set, host_worker routing takes the pair
    // verdict to the agent, never a cloud call.
    expect(wiring.mode).toBe("host_worker_defer");
    expect(wiring.hostWorkerEnabled).toBe(true);
  });

  it("neither opt-in nor host_worker -> heuristic_only (zero external call)", () => {
    const wiring = resolveEdgeClassifyWiring(
      {},
      { provider_kind: "official_api" }
    );
    expect(wiring.mode).toBe("heuristic_only");
    expect(wiring.llmEnabled).toBe(false);
    expect(wiring.hostWorkerEnabled).toBe(false);
  });

  it("ALAYA_EDGE_CLASSIFY_HOST_WORKER=0 forces defer OFF even under provider_kind=host_worker", () => {
    const wiring = resolveEdgeClassifyWiring(
      { [ALAYA_EDGE_CLASSIFY_HOST_WORKER_ENV]: "0" },
      { provider_kind: "host_worker" }
    );
    expect(wiring.hostWorkerEnabled).toBe(false);
    // With defer forced off and no cloud opt-in, it falls to heuristic_only.
    expect(wiring.mode).toBe("heuristic_only");
  });

  it("ALAYA_EDGE_CLASSIFY_HOST_WORKER=1 forces defer ON even under provider_kind=official_api", () => {
    const wiring = resolveEdgeClassifyWiring(
      { [ALAYA_EDGE_CLASSIFY_HOST_WORKER_ENV]: "1" },
      { provider_kind: "official_api" }
    );
    expect(wiring.mode).toBe("host_worker_defer");
    expect(wiring.hostWorkerEnabled).toBe(true);
  });
});
