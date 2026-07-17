import { beforeEach, describe, expect, it } from "vitest";
import {
  resetExpansionFillAuthorityFixture,
  state
} from "./expansion-fill-authority-fixture/fixture.js";
import {
  completeExpansionFixture,
  recallBundle
} from "./expansion-fill-authority-fixture/recall-bundle.js";
import { assertExpansionSnapshotAuthority } from
  "../../../longmemeval/promotion/expansion/authority/expansion-snapshot-authority.js";
import { assertExpansionRecallAuthority } from
  "../../../longmemeval/promotion/expansion/authority/expansion-recall-authority.js";

describe("500Q expansion fill authority", () => {
  beforeEach(resetExpansionFillAuthorityFixture);

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
    const env = { ALAYA_RECALL_EVAL_EMBEDDING: "env" };

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
    await assertExpansionRecallAuthority({
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

  it("allows an unsliced full 500Q recall run", async () => {
    const fixture = await completeExpansionFixture();
    await assertExpansionRecallAuthority({
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
    ["recall policy", { ALAYA_EMBEDDING_RECALL_TIERS: "cold" }]
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
      env: { ALAYA_RECALL_EVAL_EMBEDDING: "env" }
    })).rejects.toThrow(/product formation/u);
    expect(state.verifyIntegrity).not.toHaveBeenCalled();
  });
});
