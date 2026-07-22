import { writeFileSync, unlinkSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { readSettledExtractionAttemptLedger } from
  "../../../../longmemeval/extraction/authority/attempt-ledger.js";
import {
  adoptExistingContinuationChild,
  assertContinuationChildClaimBinding,
  assertExtractionAuthorityHasNoContinuationChild,
  continuationChildClaimPath
} from "../../../../longmemeval/extraction/authority/continuation/child-claim.js";
import {
  addFailedPredecessorAttempt,
  cleanupContinuationRoots,
  createAndPersistGrandchild,
  createContinuationScenario,
  model,
  persistScenario,
  requestProfile,
  spendLegacySuccessor
} from "./continuation-fixture.js";

afterEach(cleanupContinuationRoots);

describe("same-root continuation legacy adoption", () => {
  it("adopts a spent legacy child and permits the next claimed generation", () => {
    const scenario = createContinuationScenario();
    persistScenario(scenario);
    unlinkSync(continuationChildClaimPath(
      scenario.cacheRoot, scenario.predecessorReceipt.lineage_digest
    ));
    spendLegacySuccessor(scenario);
    expect(adoptExistingContinuationChild({
      cacheRoot: scenario.cacheRoot,
      child: scenario.successorReceipt,
      childTargetSelection: scenario.successorSelection
    })?.successor.receipt_digest).toBe(scenario.successorReceipt.receipt_digest);
    expect(() => assertExtractionAuthorityHasNoContinuationChild({
      cacheRoot: scenario.cacheRoot, authority: scenario.predecessorReceipt
    })).toThrow(/already delegated/u);
    createAndPersistGrandchild(scenario);
    expect(() => assertExtractionAuthorityHasNoContinuationChild({
      cacheRoot: scenario.cacheRoot, authority: scenario.successorReceipt
    })).toThrow(/already delegated/u);
  });

  it("detects raw-byte and settled-counter drift in an adopted parent", () => {
    const scenario = createContinuationScenario();
    persistScenario(scenario);
    writeFileSync(scenario.predecessorLedgerPath, Buffer.concat([
      scenario.originalLedgerBytes, Buffer.from(" ", "utf8")
    ]));
    const whitespaceDrift = readPredecessorLedger(scenario);
    expect(whitespaceDrift.ledgerSha256).toBe(scenario.predecessorLedger.ledgerSha256);
    expect(whitespaceDrift.rawLedgerSha256)
      .not.toBe(scenario.predecessorLedger.rawLedgerSha256);
    expectClaimDrift(scenario, whitespaceDrift);
    writeFileSync(scenario.predecessorLedgerPath, scenario.originalLedgerBytes);
    addFailedPredecessorAttempt(scenario);
    const counterDrift = readPredecessorLedger(scenario);
    expect(counterDrift.attempts).toBe(scenario.predecessorLedger.attempts + 1);
    expectClaimDrift(scenario, counterDrift);
  });
});

function readPredecessorLedger(scenario: ReturnType<typeof createContinuationScenario>) {
  return readSettledExtractionAttemptLedger({
    cacheRoot: scenario.cacheRoot,
    lineageDigest: scenario.predecessorReceipt.lineage_digest,
    cacheIdentity: { model, requestProfile }
  });
}

function expectClaimDrift(
  scenario: ReturnType<typeof createContinuationScenario>,
  predecessorLedger: ReturnType<typeof readSettledExtractionAttemptLedger>
): void {
  expect(() => assertContinuationChildClaimBinding({
    cacheRoot: scenario.cacheRoot,
    predecessorReceiptDigest: scenario.predecessorReceipt.receipt_digest,
    predecessorLedger,
    successor: scenario.successorReceipt
  })).toThrow(/binding drifted/u);
}
