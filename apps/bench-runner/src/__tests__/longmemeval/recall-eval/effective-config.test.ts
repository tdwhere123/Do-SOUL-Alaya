import { describe, expect, it } from "vitest";
import {
  assertRecallEvalProductPolicyEnvironment,
  buildEffectiveRecallConfigIdentity,
  readRecallEvalMaxResults
} from "../../../longmemeval/provenance/effective-recall-config.js";
import { prepareRecallEvalRunContext } from "../../../longmemeval/lifecycle/recall-eval/recall-eval-run-context.js";
import { resolveBenchRecallWeightOverrides } from "../../../harness/recall/recall-weight-overrides.js";
import { buildBenchDiagnosticRecallPolicy } from "../../../harness/daemon/runtime/daemon-recall-result.js";

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

  it("binds the policy-derived fine-evaluation budget into provenance", () => {
    const tenResultPolicy = buildBenchDiagnosticRecallPolicy("surface", 10, true);
    const twentyResultPolicy = buildBenchDiagnosticRecallPolicy("surface", 20, true);
    const tenResultIdentity = buildEffectiveRecallConfigIdentity({}, {
      maxResults: 10,
      conflictAwareness: true
    });
    const twentyResultIdentity = buildEffectiveRecallConfigIdentity({}, {
      maxResults: 20,
      conflictAwareness: true
    });

    expect(tenResultPolicy.fine_assessment.max_candidates).toBe(200);
    expect(twentyResultPolicy.fine_assessment.max_candidates).toBe(400);
    expect(twentyResultIdentity.effective_config_sha256)
      .not.toBe(tenResultIdentity.effective_config_sha256);
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

  it("allows attributed diagnostic weight overrides before reading recall inputs", async () => {
    const rawOverrides = JSON.stringify({
      fusion_weights: { evidence_fts: 3, evidence_structural_agreement: 6 }
    });
    const overrides = resolveBenchRecallWeightOverrides({ envJson: rawOverrides });

    await expect(prepareRecallEvalRunContext({
      snapshotDbPath: "/missing/snapshot.db",
      variant: "longmemeval_oracle",
      historyRoot: "/missing/history"
    }, overrides, {
      ALAYA_RECALL_WEIGHT_OVERRIDES: rawOverrides
    })).rejects.toThrow(/ENOENT|no such file|snapshot manifest/u);
  });

  it("allows the attributed bounded-final-authority treatment before reading inputs", async () => {
    const treatment = {
      ALAYA_RECALL_FINAL_AUTHORITY_MAX_HEAD_DROP: "2"
    };
    expect(buildEffectiveRecallConfigIdentity(treatment, {
      maxResults: 10,
      conflictAwareness: true
    }).effective_config_sha256).not.toBe(buildEffectiveRecallConfigIdentity({}, {
      maxResults: 10,
      conflictAwareness: true
    }).effective_config_sha256);

    await expect(prepareRecallEvalRunContext({
      snapshotDbPath: "/missing/snapshot.db",
      variant: "longmemeval_oracle",
      historyRoot: "/missing/history"
    }, undefined, treatment)).rejects.toThrow(/ENOENT|no such file|snapshot manifest/u);
  });

  it.each(["", "-1", "1.5", "9007199254740992"])(
    "rejects invalid bounded-final-authority treatment %j before reading inputs",
    async (value) => {
      await expect(prepareRecallEvalRunContext({
        snapshotDbPath: "/missing/snapshot.db",
        variant: "longmemeval_oracle",
        historyRoot: "/missing/history"
      }, undefined, {
        ALAYA_RECALL_FINAL_AUTHORITY_MAX_HEAD_DROP: value
      })).rejects.toThrow(/non-negative safe integer/u);
    }
  );

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
      variant: "longmemeval_oracle",
      historyRoot: "/missing/history"
    }, undefined, {
      ALAYA_BENCH_EMBEDDING_INJECTION_CAP: ""
    })).rejects.toThrow(/ALAYA_BENCH_EMBEDDING_INJECTION_CAP/u);
  });

  it.each([
    { ALAYA_OFFICIAL_GARDEN_SECRET_REF: "env:GARDEN_API_KEY" },
    { ALAYA_GARDEN_OPENAI_SECRET_REF: "env:LEGACY_GARDEN_API_KEY" },
    { ALAYA_CONFLICT_LLM_PROVIDER_URL: "https://example.invalid/v1" },
    { ALAYA_CONFLICT_LLM_API_KEY: "secret" },
    { ALAYA_BENCH_ALLOW_LIVE_EXTRACTION: "true" }
  ])("rejects post-fill extraction authority before reading recall inputs", async (env) => {
    await expect(prepareRecallEvalRunContext({
      snapshotDbPath: "/missing/snapshot.db",
      variant: "longmemeval_oracle",
      historyRoot: "/missing/history"
    }, undefined, env)).rejects.toThrow(
      /post-fill benchmark stages must be credentialless and cache-only/u
    );
  });

  it.each([
    { ALAYA_LOCAL_EMBEDDING_MODEL: "custom/local-model" },
    { ALAYA_RECALL_D2Q: "true" }
  ])("rejects non-product bi-encoder config before reading recall inputs", async (drift) => {
    await expect(prepareRecallEvalRunContext({
      snapshotDbPath: "/missing/snapshot.db",
      variant: "longmemeval_oracle",
      historyRoot: "/missing/history"
    }, undefined, {
      ALAYA_RECALL_EVAL_EMBEDDING: "env",
      ...drift
    })).rejects.toThrow(/product-default bi-encoder/u);
  });

  it.each([
    { ALAYA_RECALL_EVAL_MAX_RESULTS: "20" },
    { ALAYA_EMBEDDING_RECALL_TIERS: "cold" },
    { ALAYA_EMBEDDING_BACKFILL_CONCURRENCY: "2" },
    { ALAYA_RECALL_SOURCE_REF_ROBUST: "false" }
  ])("rejects effective product recall drift before reading inputs", async (drift) => {
    await expect(prepareRecallEvalRunContext({
      snapshotDbPath: "/missing/snapshot.db",
      variant: "longmemeval_oracle",
      historyRoot: "/missing/history"
    }, undefined, drift)).rejects.toThrow(/product-default recall policy/u);
  });
});
