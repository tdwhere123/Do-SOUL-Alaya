import { describe, expect, it } from "vitest";
import {
  assertRecallEvalProductPolicyEnvironment,
  buildEffectiveRecallConfigIdentity,
  readRecallEvalMaxResults
} from "../../../longmemeval/provenance/effective-recall-config.js";
import { prepareRecallEvalRunContext } from "../../../longmemeval/lifecycle/recall-eval-run-context.js";
import { resolveBenchRecallWeightOverrides } from "../../../harness/recall-weight-overrides.js";

describe("effective recall config identity", () => {
  it("parses recall-eval max results strictly", () => {
    expect(readRecallEvalMaxResults(undefined)).toBe(10);
    expect(readRecallEvalMaxResults("20")).toBe(20);
    for (const invalid of ["", "0", "1001", "1.5", "1e2", "ten"]) {
      expect(() => readRecallEvalMaxResults(invalid)).toThrow(/integer from 1 to 1000/u);
    }
  });

  it("hashes normalized runtime and request configuration", () => {
    const options = { maxResults: 10, conflictAwareness: true };
    const base = buildEffectiveRecallConfigIdentity({}, options);
    const equivalent = buildEffectiveRecallConfigIdentity({
      ALAYA_RECALL_CONF_SLICE_COMPATIBILITY: "off"
    }, options);
    const runtimeDrift = buildEffectiveRecallConfigIdentity({
      ALAYA_RECALL_CONF_SLICE_COMPATIBILITY: "on"
    }, options);
    const requestDrift = buildEffectiveRecallConfigIdentity({}, {
      ...options,
      maxResults: 20
    });
    const equivalentAdapter = buildEffectiveRecallConfigIdentity({
      ALAYA_RECALL_SOURCE_REF_ROBUST: "true"
    }, options);
    const adapterDrift = buildEffectiveRecallConfigIdentity({
      ALAYA_RECALL_SOURCE_REF_ROBUST: "false"
    }, options);

    expect(equivalent.effective_config_sha256).toBe(base.effective_config_sha256);
    expect(equivalentAdapter.effective_config_sha256).toBe(base.effective_config_sha256);
    expect(runtimeDrift.effective_config_sha256).not.toBe(base.effective_config_sha256);
    expect(requestDrift.effective_config_sha256).not.toBe(base.effective_config_sha256);
    expect(adapterDrift.effective_config_sha256).not.toBe(base.effective_config_sha256);
  });

  it.each([
    ["ALAYA_EMBEDDING_BACKFILL_CONCURRENCY", "2"],
    ["ALAYA_EMBEDDING_RECALL_TIERS", "hot,cold"],
    ["ALAYA_EMBEDDING_WORKSPACE_SCAN_CAP", "250"],
    ["ALAYA_PATHREL_CONTENT_STRENGTH", "true"]
  ])("hashes core runtime field %s", (name, value) => {
    const options = { maxResults: 10, conflictAwareness: true };
    const base = buildEffectiveRecallConfigIdentity({}, options);
    const drifted = buildEffectiveRecallConfigIdentity({ [name]: value }, options);

    expect(base.schema_version).toBe(2);
    expect(drifted.effective_config_sha256).not.toBe(base.effective_config_sha256);
  });

  it("normalizes core fields by their effective runtime behavior", () => {
    const options = { maxResults: 10, conflictAwareness: true };
    const base = buildEffectiveRecallConfigIdentity({}, options).effective_config_sha256;
    for (const env of [
      { ALAYA_EMBEDDING_BACKFILL_CONCURRENCY: "6" },
      { ALAYA_EMBEDDING_RECALL_TIERS: "hot,warm" },
      { ALAYA_EMBEDDING_WORKSPACE_SCAN_CAP: "5000" },
      { ALAYA_PATHREL_CONTENT_STRENGTH: "off" },
      { ALAYA_PATHREL_CONTENT_STRENGTH: "0.75" }
    ]) {
      expect(buildEffectiveRecallConfigIdentity(env, options).effective_config_sha256)
        .toBe(base);
    }
    expect(buildEffectiveRecallConfigIdentity({
      ALAYA_EMBEDDING_BACKFILL_CONCURRENCY: "100"
    }, options).effective_config_sha256).toBe(buildEffectiveRecallConfigIdentity({
      ALAYA_EMBEDDING_BACKFILL_CONCURRENCY: "32"
    }, options).effective_config_sha256);
  });

  it("hashes the normalized final RecallPolicy including weight overrides", () => {
    const options = { maxResults: 10, conflictAwareness: true };
    const base = buildEffectiveRecallConfigIdentity({}, options);
    const overrides = resolveBenchRecallWeightOverrides({
      cliJson: JSON.stringify({ fusion_weights: { lexical_fts: 2 } })
    });
    const weighted = buildEffectiveRecallConfigIdentity({}, options, overrides);

    expect(weighted.effective_config_sha256).not.toBe(base.effective_config_sha256);
  });

  it.each([
    "ALAYA_BENCH_EMBEDDING_INJECTION_CAP",
    "ALAYA_BENCH_EMBEDDING_INJECTION_FLOOR",
    "ALAYA_BENCH_RECALL_MAX_TOKENS",
    "ALAYA_RECALL_COARSE_FLOOR"
  ])("rejects legacy product-matrix policy knob %s even when blank", (name) => {
    expect(() => assertRecallEvalProductPolicyEnvironment({ [name]: "" }))
      .toThrow(new RegExp(name, "u"));
  });

  it("rejects legacy policy knobs at the recall-eval entry before reading inputs", async () => {
    await expect(prepareRecallEvalRunContext({
      snapshotDbPath: "/missing/snapshot.db",
      variant: "oracle",
      historyRoot: "/missing/history"
    }, undefined, {
      ALAYA_BENCH_EMBEDDING_INJECTION_CAP: ""
    })).rejects.toThrow(/ALAYA_BENCH_EMBEDDING_INJECTION_CAP/u);
  });
});
