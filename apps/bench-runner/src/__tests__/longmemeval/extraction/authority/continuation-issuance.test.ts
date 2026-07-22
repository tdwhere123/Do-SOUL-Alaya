import {
  existsSync, readFileSync, writeFileSync
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { persistContinuationAuthority } from
  "../../../../cli/extraction-authority/continuation.js";
import {
  assertContinuationChildClaimBinding,
  assertExtractionAuthorityHasNoContinuationChild,
  continuationChildClaimPath
} from "../../../../longmemeval/extraction/authority/continuation/child-claim.js";
import { assertSameRootExtractionContinuationRuntime } from
  "../../../../longmemeval/extraction/authority/continuation/continuation.js";
import { loadSameRootExtractionContinuation } from
  "../../../../longmemeval/extraction/authority/continuation/runtime.js";
import {
  assertExtractionAuthorityReceipt,
  readExtractionAuthorityReceipt
} from "../../../../longmemeval/extraction/authority/receipt.js";
import { readExtractionCacheManifestIdentity } from
  "../../../../longmemeval/extraction/cache/extraction-cache-manifest.js";
import {
  cleanupContinuationRoots,
  createContinuationScenario,
  createSiblingReceipt,
  persistScenario,
  readSuccessorLedger
} from "./continuation-fixture.js";

afterEach(cleanupContinuationRoots);

describe("same-root continuation issuance", () => {
  it("rejects live ledger or manifest drift before creating durable child state", () => {
    const scenario = createContinuationScenario();
    appendWhitespace(scenario.predecessorLedgerPath);
    expect(() => persistScenario(scenario)).toThrow(/ledger drifted during continuation issuance/u);
    expect(hasPredecessorClaim(scenario)).toBe(false);
    writeFileSync(scenario.predecessorLedgerPath, scenario.originalLedgerBytes);
    appendWhitespace(scenario.manifestPath);
    expect(() => persistScenario(scenario)).toThrow(/starting manifest drifted/u);
    expect(hasPredecessorClaim(scenario)).toBe(false);
    expect(readSuccessorLedger(scenario)).toBeUndefined();
  });

  it("recovers an exact claim and pristine fork after crashing before receipt write", () => {
    const scenario = createContinuationScenario();
    expect(() => persistScenario(scenario, {
      writeContinuation: () => { throw new Error("simulated crash before receipt"); }
    })).toThrow(/simulated crash/u);
    expect(existsSync(scenario.outputPath)).toBe(false);
    persistScenario(scenario);
    expect(readSuccessorLedger(scenario)).toMatchObject({ attempts: 1, successfulShards: 1 });
    expect(readExtractionAuthorityReceipt(scenario.outputPath).receipt_digest)
      .toBe(scenario.successorReceipt.receipt_digest);
    expect(() => assertContinuationChildClaimBinding({
      cacheRoot: scenario.cacheRoot,
      predecessorReceiptDigest: scenario.predecessorReceipt.receipt_digest,
      predecessorLedger: scenario.predecessorLedger,
      successor: scenario.successorReceipt
    })).not.toThrow();
  });

  it("rejects the delegated parent and enforces a monotonic successor runtime", () => {
    const scenario = createContinuationScenario();
    persistScenario(scenario);
    const ledger = readSuccessorLedger(scenario)!;
    expect(scenario.continuation.predecessor).toMatchObject({
      attempts_consumed: 1, remaining_attempts: 9,
      successful_shards: 1, remaining_successful_shards: 1
    });
    expect(() => assertExtractionAuthorityHasNoContinuationChild({
      cacheRoot: scenario.cacheRoot, authority: scenario.predecessorReceipt
    })).toThrow(/already delegated/u);
    expect(() => loadSameRootExtractionContinuation({
      cacheRoot: scenario.cacheRoot,
      receipt: scenario.predecessorReceipt,
      predecessorAuthorityReceiptPath: undefined
    })).toThrow(/already delegated/u);
    expect(() => assertExtractionAuthorityReceipt(
      scenario.successorReceipt, scenario.successorObservation
    )).not.toThrow();
    expectRuntime(scenario, ledger).not.toThrow();
    expectRuntime(scenario, { ...ledger, attempts: 0 }).toThrow(/monotonic predecessor fork/u);
  });

  it("requires an explicit post-pin manifest transition for a pristine child", () => {
    const scenario = createContinuationScenario();
    persistScenario(scenario);
    const ledger = readSuccessorLedger(scenario)!;
    appendWhitespace(scenario.manifestPath);
    const postPinManifestSha256 = readExtractionCacheManifestIdentity(
      scenario.cacheRoot
    )!.manifestSha256;
    const inspection = withManifest(scenario.inspection, postPinManifestSha256);
    expectRuntime(scenario, ledger, inspection).toThrow(/manifest does not close/u);
    expectRuntime(
      scenario, ledger, inspection, postPinManifestSha256
    ).not.toThrow();
  });

  it("rejects a sibling receipt after the predecessor claim is durable", () => {
    const scenario = createContinuationScenario();
    persistScenario(scenario);
    expect(() => persistContinuationAuthority({
      cacheRoot: scenario.cacheRoot,
      outputPath: join(scenario.cacheRoot, "..", "sibling-authority.json"),
      receipt: createSiblingReceipt(scenario),
      prepared: scenario.prepared
    })).toThrow(/sibling child/u);
  });
});

function hasPredecessorClaim(scenario: ReturnType<typeof createContinuationScenario>): boolean {
  return existsSync(continuationChildClaimPath(
    scenario.cacheRoot, scenario.predecessorReceipt.lineage_digest
  ));
}

function appendWhitespace(path: string): void {
  writeFileSync(path, Buffer.concat([readFileSync(path), Buffer.from(" ", "utf8")]));
}

function expectRuntime(
  scenario: ReturnType<typeof createContinuationScenario>,
  successorLedger: NonNullable<ReturnType<typeof readSuccessorLedger>>,
  inspection = scenario.inspection,
  postPinManifestSha256?: string
) {
  return expect(() => assertSameRootExtractionContinuationRuntime({
    cacheRoot: scenario.cacheRoot,
    receipt: scenario.successorReceipt,
    predecessor: scenario.predecessorReceipt,
    predecessorLedger: scenario.predecessorLedger,
    successorLedger,
    targetSelection: scenario.successorSelection,
    inspection,
    ...(postPinManifestSha256 === undefined ? {} : { postPinManifestSha256 })
  }));
}

function withManifest(
  inspection: ReturnType<typeof createContinuationScenario>["inspection"],
  manifestSha256: string
) {
  return {
    ...inspection,
    observation: {
      ...inspection.observation,
      extraction: { ...inspection.observation.extraction, manifestSha256 }
    }
  };
}
