import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  resetExpansionFillAuthorityFixture,
  state
} from "./expansion-fill-authority-fixture/fixture.js";
import {
  completeExpansionFixture,
  recallBundle
} from "./expansion-fill-authority-fixture/recall-bundle.js";
import {
  clearFrozenReuseRoots,
  frozenReuseEnvironment
} from "./expansion-fill-authority-fixture/reuse-environment.js";
import { longMemEvalExpansionCapabilityData } from
  "../../../longmemeval/promotion/expansion/expansion-capability.js";
import { assertExpansionSnapshotAuthority } from
  "../../../longmemeval/promotion/expansion/authority/expansion-snapshot-authority.js";
import { assertExpansionRecallAuthority } from
  "../../../longmemeval/promotion/expansion/authority/expansion-recall-authority.js";

describe("500Q expansion fill authority", () => {
  beforeEach(resetExpansionFillAuthorityFixture);
  afterEach(clearFrozenReuseRoots);

  it("admits only a complete cache-authorized neutral 500Q snapshot producer", async () => {
    const fixture = await completeExpansionFixture();
    state.identity = {
      manifestSha256: "b".repeat(64),
      manifest: fixture.manifest
    };
    await expect(assertExpansionSnapshotAuthority({
      variant: "longmemeval_s",
      limit: 500,
      snapshotOut: "/snapshot/target.db",
      extractionCacheRoot: "/cache",
      embeddingMode: "disabled",
      policyShape: "stress",
      simulateReport: "none",
      expansionCapability: fixture.capability
    }, {})).resolves.toBeUndefined();

    for (const manifest of [
      { ...fixture.manifest, expected_key_set_sha256: "0".repeat(64) },
      { ...fixture.manifest, cached_turns: 499 }
    ]) {
      state.identity = { manifestSha256: "b".repeat(64), manifest };
      await expect(assertExpansionSnapshotAuthority({
        variant: "longmemeval_s",
        limit: 500,
        snapshotOut: "/snapshot/target.db",
        extractionCacheRoot: "/cache",
        expansionCapability: fixture.capability
      }, {})).rejects.toThrow(/complete closure|lineage/u);
    }

    await expect(assertExpansionSnapshotAuthority({
      variant: "longmemeval_s",
      limit: 501,
      snapshotOut: "/snapshot/target.db",
      expansionCapability: fixture.capability
    }, {})).rejects.toThrow(/neutral producer contract/u);
  });

  it("rejects full 500Q recall before restore when capability or target closure drifts", async () => {
    const fixture = await completeExpansionFixture();
    const bundle = recallBundle(fixture);
    const options = {
      snapshotDbPath: "/snapshot/target.db",
      variant: "longmemeval_s" as const,
      historyRoot: "/history",
      policyShape: "stress" as const,
      simulateReport: "none" as const
    };
    const env = await frozenReuseEnvironment(bundle);

    await expect(assertExpansionRecallAuthority({
      options,
      bundle,
      recallWeightOverrides: undefined,
      env
    })).rejects.toThrow(/requires live promotion capability/u);
    expect(state.verifyIntegrity).not.toHaveBeenCalled();

    const tampered = structuredClone(bundle);
    (tampered.manifest.extraction_provenance as {
      content_closure_sha256: string;
    }).content_closure_sha256 = "0".repeat(64);
    await expect(assertExpansionRecallAuthority({
      options: { ...options, expansionCapability: fixture.capability },
      bundle: tampered,
      recallWeightOverrides: undefined,
      env
    })).rejects.toThrow(/lineage|target cache authority/u);
    expect(state.verifyIntegrity).not.toHaveBeenCalled();
  });

  it("validates full snapshot substrate before recall restore can begin", async () => {
    const fixture = await completeExpansionFixture();
    const bundle = recallBundle(fixture);
    await assertExpansionRecallAuthority({
      options: {
        snapshotDbPath: "/snapshot/target.db",
        variant: "longmemeval_s",
        historyRoot: "/history",
        policyShape: "stress",
        simulateReport: "none",
        expansionCapability: fixture.capability
      },
      bundle,
      recallWeightOverrides: undefined,
      env: await frozenReuseEnvironment(bundle)
    });

    expect(state.verifyIntegrity).toHaveBeenCalledOnce();
    expect(state.substrateBinding).toHaveBeenCalledOnce();
    expect(state.seedLedgerBinding).toHaveBeenCalledOnce();
    expect(state.verifyIntegrity.mock.calls[0]?.[0]).toBe("/bound/target.db");
    expect(state.substrateBinding.mock.calls[0]?.[0]).toMatchObject({
      dbPath: "/bound/target.db"
    });
    expect(state.seedLedgerBinding.mock.calls[0]?.[0]).toMatchObject({
      dbPath: "/bound/target.db"
    });
  });

  it("accepts re-materialized run code that matches the live validator", async () => {
    const fixture = await completeExpansionFixture("4e16327" + "4".repeat(33));
    const data = longMemEvalExpansionCapabilityData(fixture.capability);
    const bundle = recallBundle(fixture);
    const provenance = bundle.manifest.run_provenance!;
    const validatorBundle = {
      ...bundle,
      manifest: {
        ...bundle.manifest,
        alaya_commit: data.validator.commit_sha7,
        run_provenance: {
          ...provenance,
          code: { ...provenance.code, ...data.validator }
        }
      }
    };

    expect(data.validator.commit_sha).not.toBe(data.code.commit_sha);
    const env = await frozenReuseEnvironment(validatorBundle);
    await expect(assertExpansionRecallAuthority({
      options: {
        snapshotDbPath: "/snapshot/target.db",
        variant: "longmemeval_s",
        historyRoot: "/history",
        policyShape: "stress",
        simulateReport: "none",
        expansionCapability: fixture.capability
      },
      bundle: validatorBundle,
      recallWeightOverrides: undefined,
      env
    })).resolves.toBeUndefined();
  });

  it("accepts frozen producer code when the live consumer validator differs", async () => {
    const fixture = await completeExpansionFixture("4e16327" + "4".repeat(33));
    const data = longMemEvalExpansionCapabilityData(fixture.capability);
    const bundle = recallBundle(fixture);
    const provenance = bundle.manifest.run_provenance!;
    const producerCommit = "3".repeat(40);
    const producerBundle = {
      ...bundle,
      manifest: {
        ...bundle.manifest,
        alaya_commit: producerCommit.slice(0, 7),
        run_provenance: {
          ...provenance,
          code: {
            ...provenance.code,
            commit_sha: producerCommit,
            commit_sha7: producerCommit.slice(0, 7),
            worktree_state_sha256: "4".repeat(64),
            executed_dist: {
              ...provenance.code.executed_dist!,
              sha256: "5".repeat(64)
            }
          }
        }
      }
    };

    expect(data.validator.commit_sha).not.toBe(data.code.commit_sha);
    expect(producerCommit).not.toBe(data.validator.commit_sha);
    expect(producerCommit).not.toBe(data.code.commit_sha);
    const env = await frozenReuseEnvironment(producerBundle);
    await expect(assertExpansionRecallAuthority({
      options: {
        snapshotDbPath: "/snapshot/target.db",
        variant: "longmemeval_s",
        historyRoot: "/history",
        policyShape: "stress",
        simulateReport: "none",
        expansionCapability: fixture.capability
      },
      bundle: producerBundle,
      recallWeightOverrides: undefined,
      env
    })).resolves.toBeUndefined();
  });

  it("requires a digest-pinned frozen snapshot binding", async () => {
    const fixture = await completeExpansionFixture();

    await expect(assertExpansionRecallAuthority({
      options: {
        snapshotDbPath: "/snapshot/target.db",
        variant: "longmemeval_s",
        historyRoot: "/history",
        policyShape: "stress",
        simulateReport: "none",
        expansionCapability: fixture.capability
      },
      bundle: recallBundle(fixture),
      recallWeightOverrides: undefined,
      env: { ALAYA_RECALL_EVAL_EMBEDDING: "env" }
    })).rejects.toThrow(/digest-pinned frozen consumer gate/u);
  });

  it("rejects a snapshot manifest not bound by the frozen consumer gate", async () => {
    const fixture = await completeExpansionFixture();
    const bundle = recallBundle(fixture);
    const env = await frozenReuseEnvironment(bundle);

    await expect(assertExpansionRecallAuthority({
      options: {
        snapshotDbPath: "/snapshot/target.db",
        variant: "longmemeval_s",
        historyRoot: "/history",
        policyShape: "stress",
        simulateReport: "none",
        expansionCapability: fixture.capability
      },
      bundle: { ...bundle, snapshotManifestSha256: "0".repeat(64) },
      recallWeightOverrides: undefined,
      env
    })).rejects.toThrow(/snapshot differs from frozen reuse authority/u);
  });

  it("rejects a snapshot whose release commit does not match its producer provenance", async () => {
    const fixture = await completeExpansionFixture();
    const bundle = recallBundle(fixture);
    const driftedBundle = {
      ...bundle,
      manifest: {
        ...bundle.manifest,
        alaya_commit: "0".repeat(7)
      }
    };

    await expect(assertExpansionRecallAuthority({
      options: {
        snapshotDbPath: "/snapshot/target.db",
        variant: "longmemeval_s",
        historyRoot: "/history",
        policyShape: "stress",
        simulateReport: "none",
        expansionCapability: fixture.capability
      },
      bundle: driftedBundle,
      recallWeightOverrides: undefined,
      env: { ALAYA_RECALL_EVAL_EMBEDDING: "env" }
    })).rejects.toThrow(/snapshot manifest differs from live expansion authority/u);
  });

  it("rejects an exact live validator that differs from the frozen reuse producer", async () => {
    const fixture = await completeExpansionFixture("4e16327" + "4".repeat(33));
    const data = longMemEvalExpansionCapabilityData(fixture.capability);
    const bundle = recallBundle(fixture);
    const env = await frozenReuseEnvironment(bundle);
    const provenance = bundle.manifest.run_provenance!;
    const driftedBundle = {
      ...bundle,
      manifest: {
        ...bundle.manifest,
        alaya_commit: data.validator.commit_sha7,
        run_provenance: {
          ...provenance,
          code: {
            ...provenance.code,
            ...data.validator
          }
        }
      }
    };

    expect(data.validator.commit_sha).not.toBe(provenance.code.commit_sha);

    await expect(assertExpansionRecallAuthority({
      options: {
        snapshotDbPath: "/snapshot/target.db",
        variant: "longmemeval_s",
        historyRoot: "/history",
        policyShape: "stress",
        simulateReport: "none",
        expansionCapability: fixture.capability
      },
      bundle: driftedBundle,
      recallWeightOverrides: undefined,
      env
    })).rejects.toThrow(/snapshot differs from frozen reuse authority/u);
  });

  it("rejects supplemental receipt drift in persisted 500Q run provenance", async () => {
    const fixture = await completeExpansionFixture();
    const bundle = structuredClone(recallBundle(fixture));
    const runCache = bundle.manifest.run_provenance!.extraction_cache!;
    if (runCache.schema_version !== 3 ||
        runCache.supplemental_source_receipt === undefined) {
      throw new Error("fixture requires current supplemental source provenance");
    }
    const tamperedBundle = {
      ...bundle,
      manifest: {
        ...bundle.manifest,
        run_provenance: {
          ...bundle.manifest.run_provenance!,
          extraction_cache: {
            ...runCache,
            supplemental_source_receipt: {
              ...runCache.supplemental_source_receipt,
              receipt_sha256: "0".repeat(64)
            }
          }
        }
      }
    };
    const env = await frozenReuseEnvironment(tamperedBundle);

    await expect(assertExpansionRecallAuthority({
      options: {
        snapshotDbPath: "/snapshot/target.db",
        variant: "longmemeval_s",
        historyRoot: "/history",
        policyShape: "stress",
        simulateReport: "none",
        expansionCapability: fixture.capability
      },
      bundle: tamperedBundle,
      recallWeightOverrides: undefined,
      env
    })).rejects.toThrow(/lineage|target cache authority/u);
  });

  it.each([
    ["A", "disabled"],
    ["B", "env"]
  ] as const)("allows an unsliced full 500Q recall run for cell %s", async (
    _cell,
    embedding
  ) => {
    const fixture = await completeExpansionFixture();
    const bundle = recallBundle(fixture);
    const env = await frozenReuseEnvironment(bundle);
    await assertExpansionRecallAuthority({
      options: {
        snapshotDbPath: "/snapshot/target.db",
        variant: "longmemeval_s",
        historyRoot: "/history",
        policyShape: "stress",
        simulateReport: "none",
        expansionCapability: fixture.capability
      },
      bundle,
      recallWeightOverrides: undefined,
      env: { ...env, ALAYA_RECALL_EVAL_EMBEDDING: embedding }
    });

    expect(state.verifyIntegrity).toHaveBeenCalledOnce();
    expect(state.seedLedgerBinding).toHaveBeenCalledOnce();
  });

  it.each([
    { offset: 0, limit: 500 },
    { offset: 125, limit: 125 },
    { offset: 0, limit: 499 },
    { offset: 1, limit: 499 }
  ])("rejects sliced 500Q recall-eval arguments %#", async (window) => {
    const fixture = await completeExpansionFixture();
    await expect(assertExpansionRecallAuthority({
      options: {
        snapshotDbPath: "/snapshot/target.db",
        variant: "longmemeval_s",
        historyRoot: "/history",
        policyShape: "stress",
        simulateReport: "none",
        ...window,
        expansionCapability: fixture.capability
      },
      bundle: recallBundle(fixture),
      recallWeightOverrides: undefined,
      env: { ALAYA_RECALL_EVAL_EMBEDDING: "env" }
    })).rejects.toThrow(/unsliced full snapshot/u);
    expect(state.verifyIntegrity).not.toHaveBeenCalled();
  });

  it.each([
    ["formation", { ALAYA_CONFLICT_RULE_ENABLED: "0" }],
    ["bi-encoder threads", { ALAYA_LOCAL_ONNX_THREADS: "64" }],
    ["recall policy", { ALAYA_EMBEDDING_RECALL_TIERS: "cold" }],
    ["bounded final authority", {
      ALAYA_RECALL_FINAL_AUTHORITY_MAX_HEAD_DROP: "2"
    }]
  ])("rejects 500Q %s drift before snapshot verification", async (_label, drift) => {
    const fixture = await completeExpansionFixture();
    await expect(assertExpansionRecallAuthority({
      options: {
        snapshotDbPath: "/snapshot/target.db",
        variant: "longmemeval_s",
        historyRoot: "/history",
        policyShape: "stress",
        simulateReport: "none",
        expansionCapability: fixture.capability
      },
      bundle: recallBundle(fixture),
      recallWeightOverrides: undefined,
      env: { ALAYA_RECALL_EVAL_EMBEDDING: "env", ...drift }
    })).rejects.toThrow(/product-default|product formation/u);
    expect(state.verifyIntegrity).not.toHaveBeenCalled();
  });

  it("rejects persisted non-product snapshot formation identity", async () => {
    const fixture = await completeExpansionFixture();
    const bundle = structuredClone(recallBundle(fixture));
    bundle.manifest.run_provenance!.runtime.paired_env
      .ALAYA_CONFLICT_RULE_ENABLED = "0";
    const env = await frozenReuseEnvironment(bundle);

    await expect(assertExpansionRecallAuthority({
      options: {
        snapshotDbPath: "/snapshot/target.db",
        variant: "longmemeval_s",
        historyRoot: "/history",
        policyShape: "stress",
        simulateReport: "none",
        expansionCapability: fixture.capability
      },
      bundle,
      recallWeightOverrides: undefined,
      env
    })).rejects.toThrow(/product formation/u);
    expect(state.verifyIntegrity).not.toHaveBeenCalled();
  });
});
