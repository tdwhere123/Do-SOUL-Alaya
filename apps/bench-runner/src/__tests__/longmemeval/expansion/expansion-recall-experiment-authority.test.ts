import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  resetExpansionFillAuthorityFixture,
  state
} from "./expansion-fill-authority-fixture/fixture.js";
import {
  completeExpansionFixture,
  recallBundle
} from "./expansion-fill-authority-fixture/recall-bundle.js";
import { clearFrozenReuseRoots } from
  "./expansion-fill-authority-fixture/reuse-environment.js";
import { assertExpansionRecallAuthority } from
  "../../../longmemeval/promotion/expansion/authority/expansion-recall-authority.js";

const BASE_OPTIONS = {
  snapshotDbPath: "/snapshot/target.db",
  variant: "longmemeval_s" as const,
  historyRoot: "/history",
  policyShape: "stress" as const,
  simulateReport: "none" as const
};
const BASE_ENV = {
  ALAYA_BENCH_ALLOW_LIVE_EXTRACTION: "0",
  ALAYA_RECALL_EVAL_EMBEDDING: "env",
  ALAYA_ENABLE_LOCAL_CROSS_ENCODER_RERANK: "false"
};

describe("local expansion recall experiment authority", () => {
  beforeEach(resetExpansionFillAuthorityFixture);
  afterEach(clearFrozenReuseRoots);

  it.each([
    ["H0", "A", "disabled", undefined],
    ["H0", "B", "env", undefined],
    ["H1", "A", "disabled", "on"],
    ["H1", "B", "env", "on"]
  ] as const)(
    "allows %s cell %s without promotion or consumer-gate authority",
    async (_hypothesis, _cell, embedding, h1MaxProduct) => {
      const fixture = await completeExpansionFixture();
      await expect(assertExpansionRecallAuthority({
        options: { ...BASE_OPTIONS, experiment: true },
        bundle: recallBundle(fixture),
        recallWeightOverrides: undefined,
        env: {
          ...BASE_ENV,
          ALAYA_RECALL_EVAL_EMBEDDING: embedding,
          ...(h1MaxProduct === undefined ? {} : {
            ALAYA_RECALL_CONF_H1_MAX_PRODUCT: h1MaxProduct
          })
        }
      })).resolves.toBeUndefined();

      expect(state.verifyIntegrity).not.toHaveBeenCalled();
      expect(state.substrateBinding).not.toHaveBeenCalled();
      expect(state.seedLedgerBinding).not.toHaveBeenCalled();
    }
  );

  it("rejects a non-canonical H1 experiment flag value", async () => {
    const fixture = await completeExpansionFixture();

    await expect(assertExpansionRecallAuthority({
      options: { ...BASE_OPTIONS, experiment: true },
      bundle: recallBundle(fixture),
      recallWeightOverrides: undefined,
      env: {
        ...BASE_ENV,
        ALAYA_RECALL_CONF_H1_MAX_PRODUCT: "true"
      }
    })).rejects.toThrow(/H1|product-default recall policy/u);
  });

  it("keeps production recall on the default policy when the H1 flag is present", async () => {
    const fixture = await completeExpansionFixture();

    await expect(assertExpansionRecallAuthority({
      options: {
        ...BASE_OPTIONS,
        expansionCapability: fixture.capability
      },
      bundle: recallBundle(fixture),
      recallWeightOverrides: undefined,
      env: {
        ...BASE_ENV,
        ALAYA_RECALL_CONF_H1_MAX_PRODUCT: "on"
      }
    })).rejects.toThrow(/product-default recall policy/u);
  });

  it("allows a bounded slice without weakening production or policy guards", async () => {
    const fixture = await completeExpansionFixture();
    const bundle = recallBundle(fixture);
    const sliced = { ...BASE_OPTIONS, offset: 0, limit: 10 };

    await expect(assertExpansionRecallAuthority({
      options: { ...sliced, expansionCapability: fixture.capability },
      bundle,
      recallWeightOverrides: undefined,
      env: BASE_ENV
    })).rejects.toThrow(/unsliced full snapshot/u);
    await expect(assertExpansionRecallAuthority({
      options: { ...sliced, experiment: true, policyShape: "chat" },
      bundle,
      recallWeightOverrides: undefined,
      env: BASE_ENV
    })).rejects.toThrow(/exact A\/B contract/u);
    await expect(assertExpansionRecallAuthority({
      options: { ...sliced, experiment: true },
      bundle,
      recallWeightOverrides: undefined,
      env: BASE_ENV
    })).resolves.toBeUndefined();
    await expect(assertExpansionRecallAuthority({
      options: { ...BASE_OPTIONS, experiment: true, offset: 499, limit: 1 },
      bundle,
      recallWeightOverrides: undefined,
      env: BASE_ENV
    })).resolves.toBeUndefined();
  });

  it.each([
    [{ weightOverridesJson: "{}" }, "exact A/B contract"],
    [{ legacySnapshot: true }, "exact A/B contract"],
    [{ offset: 0 }, "offset requires a limit"],
    [{ offset: 499, limit: 2 }, "window exceeds the snapshot"],
    [{ offset: 0, limit: 0 }, "window must be positive"]
  ])("rejects experiment drift %#", async (drift, expected) => {
    const fixture = await completeExpansionFixture();
    await expect(assertExpansionRecallAuthority({
      options: { ...BASE_OPTIONS, experiment: true, ...drift },
      bundle: recallBundle(fixture),
      recallWeightOverrides: undefined,
      env: BASE_ENV
    })).rejects.toThrow(new RegExp(expected, "u"));
  });
});
