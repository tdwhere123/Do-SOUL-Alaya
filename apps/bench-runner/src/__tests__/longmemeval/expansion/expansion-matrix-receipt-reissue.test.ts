import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetExpansionFillAuthorityFixture } from
  "./expansion-fill-authority-fixture/fixture.js";
import { mintReissuedMatrixCapability } from
  "./expansion-fill-authority-fixture/capability.js";
import {
  completeExpansionFixture,
  recallBundle,
  withReissuedMatrixLineage
} from "./expansion-fill-authority-fixture/recall-bundle.js";
import {
  clearFrozenReuseRoots,
  frozenReuseEnvironment
} from "./expansion-fill-authority-fixture/reuse-environment.js";
import type { LongMemEvalExpansionCapability } from
  "../../../longmemeval/promotion/expansion/expansion-capability.js";
import { assertExpansionRecallAuthority } from
  "../../../longmemeval/promotion/expansion/authority/expansion-recall-authority.js";

describe("500Q expansion matrix receipt reissue", () => {
  beforeEach(resetExpansionFillAuthorityFixture);
  afterEach(clearFrozenReuseRoots);

  it("consumes a completed cache through one equivalent receipt", async () => {
    const fixture = await completeExpansionFixture();
    const capability = await mintReissuedMatrixCapability();
    const bundle = recallBundle(fixture);

    await expect(assertExpansionRecallAuthority({
      options: recallOptions(capability),
      bundle,
      recallWeightOverrides: undefined,
      env: await frozenReuseEnvironment(bundle)
    })).resolves.toBeUndefined();
  });

  it("rejects different historical anchor and lineage receipt tuples", async () => {
    const fixture = await completeExpansionFixture();
    const capability = await mintReissuedMatrixCapability();
    const bundle = withReissuedMatrixLineage(recallBundle(fixture), capability);

    await expect(assertExpansionRecallAuthority({
      options: recallOptions(capability),
      bundle,
      recallWeightOverrides: undefined,
      env: await frozenReuseEnvironment(bundle)
    })).rejects.toThrow(/source anchor|lineage/u);
  });
});

function recallOptions(expansionCapability: LongMemEvalExpansionCapability) {
  return {
    snapshotDbPath: "/snapshot/target.db",
    variant: "longmemeval_s" as const,
    historyRoot: "/history",
    policyShape: "stress" as const,
    simulateReport: "none" as const,
    expansionCapability
  };
}
