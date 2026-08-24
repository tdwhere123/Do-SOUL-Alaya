// @ts-nocheck
import {
  existsSync, readFileSync, writeFileSync
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runAuthorizeExtractionCommand } from
  "../../../../cli/extraction-authority/command.js";
import { persistContinuationAuthority } from
  "../../../../cli/extraction-authority/continuation.js";
import {
  assertContinuationChildClaimBinding,
  assertExtractionAuthorityHasNoContinuationChild,
  continuationChildClaimPath
} from "../../../../bench/extraction/authority/continuation/child-claim.js";
import { assertSameRootExtractionContinuationRuntime } from
  "../../../../bench/extraction/authority/continuation/continuation.js";
import { loadSameRootExtractionContinuation } from
  "../../../../bench/extraction/authority/continuation/runtime.js";
import {
  assertExtractionAuthorityReceipt,
  readExtractionAuthorityReceipt
} from "../../../../bench/extraction/authority/receipt.js";
import { readExtractionCacheManifestIdentity } from
  "../../../../bench/extraction/cache/extraction-cache-manifest.js";
import {
  cleanupContinuationRoots,
  createAuthorityRenewalScenario,
  createContinuationScenario,
  createReceipt,
  createSiblingReceipt,
  persistScenario,
  readSuccessorLedger
} from "./continuation-fixture.js";

afterEach(cleanupContinuationRoots);

describe("same-root continuation issuance", () => {
  it("renews a settled same-revision authority only with a higher output cap", () => {
    const scenario = createAuthorityRenewalScenario();
    expect(scenario.successorReceipt.limits).toMatchObject({
      max_output_tokens: 1_024,
      maximum_attempts: scenario.predecessorReceipt.limits.maximum_attempts,
      successful_shard_ceiling: scenario.predecessorReceipt.limits.successful_shard_ceiling
    });
    persistScenario(scenario);
    expectRuntime(scenario, readSuccessorLedger(scenario)!).not.toThrow();
    expect(() => createAuthorityRenewalScenario(512)).toThrow(/output token cap.*increase/u);
    expect(() => createAuthorityRenewalScenario(1_024, 301))
      .toThrow(/changed another authority term/u);
  });

  it("switches only physical transport without changing semantic cache identity", () => {
    const scenario = createAuthorityRenewalScenario(
      512, 300, "https://provider-b.example/v1"
    );

    expect(scenario.continuation.mode).toBe("transport_successor");
    expect(scenario.successorReceipt.observation.transport).toEqual({
      providerUrl: "https://provider-b.example/v1",
      model: "provider-model-alias"
    });
    persistScenario(scenario);
    expectRuntime(scenario, readSuccessorLedger(scenario)!).not.toThrow();
    expect(() => createAuthorityRenewalScenario(
      1_024, 300, "https://provider-b.example/v1"
    )).toThrow(/transport successor changed another authority term/u);
  });

  it("issues the renewal through the canonical authorize command", async () => {
    const scenario = createAuthorityRenewalScenario();
    const writeContinuation = vi.fn();
    vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const exitCode = await runAuthorizeExtractionCommand([
      "--variant", "s", "--offset", "0", "--limit", "100",
      "--extraction-cache-root", scenario.cacheRoot,
      "--extraction-action", "fill",
      "--extraction-receipt-out", scenario.outputPath,
      "--extraction-output-token-cap", "1024",
      "--extraction-output-token-field", "max_tokens",
      "--extraction-input-price-usd-per-million", "1",
      "--extraction-output-price-usd-per-million", "2",
      "--extraction-max-input-tokens", "300",
      "--extraction-disk-floor-bytes", "0",
      "--extraction-predecessor-authority", "/predecessor.json",
      "--extraction-target-selection", "/target-selection.json"
    ], {
      inspect: vi.fn(async () => scenario.inspection),
      readLedger: (input) => input.lineageDigest === scenario.predecessorReceipt.lineage_digest
        ? scenario.predecessorLedger
        : undefined,
      readPredecessorAuthority: () => scenario.predecessorReceipt,
      readSettledLedger: () => scenario.predecessorLedger,
      readTargetSelection: () => scenario.predecessorSelection,
      assertTargetSelection: () => undefined,
      assertTargetSelectionWindow: () => undefined,
      claimChild: () => undefined,
      ensureForkedLedger: () => undefined,
      writeContinuation
    });
    expect(exitCode).toBe(0);
    expect(writeContinuation).toHaveBeenCalledWith(
      scenario.outputPath,
      expect.objectContaining({
        limits: expect.objectContaining({ max_output_tokens: 1_024 }),
        continuation: expect.objectContaining({ mode: "output_token_cap_renewal" })
      })
    );
  });

  it("chains a second output-token-cap renewal while the ancestor ledger remains", async () => {
    const first = createAuthorityRenewalScenario();
    persistScenario(first);
    vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const outputPath = join(first.cacheRoot, "..", "renewed-2048.json");
    const exitCode = await runAuthorizeExtractionCommand([
      "--variant", "s", "--offset", "0", "--limit", "100",
      "--extraction-cache-root", first.cacheRoot,
      "--extraction-action", "fill",
      "--extraction-receipt-out", outputPath,
      "--extraction-output-token-cap", "2048",
      "--extraction-output-token-field", "max_tokens",
      "--extraction-input-price-usd-per-million", "1",
      "--extraction-output-price-usd-per-million", "2",
      "--extraction-max-input-tokens", "300",
      "--extraction-disk-floor-bytes", "0",
      "--extraction-predecessor-authority", first.outputPath,
      "--extraction-target-selection", "/target-selection.json"
    ], {
      inspect: vi.fn(async () => first.inspection),
      readTargetSelection: () => first.successorSelection,
      assertTargetSelection: () => undefined,
      assertTargetSelectionWindow: () => undefined
    });
    expect(exitCode).toBe(0);
    const receipt = readExtractionAuthorityReceipt(outputPath);
    expect(receipt.limits.max_output_tokens).toBe(2_048);
    expect(receipt.continuation).toMatchObject({ mode: "output_token_cap_renewal" });
  });

  it("rejects re-issuing an already-forked renewal lineage", async () => {
    const scenario = createAuthorityRenewalScenario();
    persistScenario(scenario);
    vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const exitCode = await runAuthorizeExtractionCommand([
      "--variant", "s", "--offset", "0", "--limit", "100",
      "--extraction-cache-root", scenario.cacheRoot,
      "--extraction-action", "fill",
      "--extraction-receipt-out", join(scenario.cacheRoot, "..", "renewed-again.json"),
      "--extraction-output-token-cap", "1024",
      "--extraction-output-token-field", "max_tokens",
      "--extraction-input-price-usd-per-million", "1",
      "--extraction-output-price-usd-per-million", "2",
      "--extraction-max-input-tokens", "300",
      "--extraction-disk-floor-bytes", "0",
      "--extraction-predecessor-authority", "/predecessor.json",
      "--extraction-target-selection", "/target-selection.json"
    ], {
      inspect: vi.fn(async () => scenario.inspection),
      readPredecessorAuthority: () => scenario.predecessorReceipt,
      readSettledLedger: () => scenario.predecessorLedger,
      readTargetSelection: () => scenario.predecessorSelection,
      assertTargetSelection: () => undefined,
      assertTargetSelectionWindow: () => undefined
    });
    expect(exitCode).toBe(2);
  });

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
      attempts_consumed: 1,
      remaining_attempts: scenario.predecessorReceipt.limits.maximum_attempts - 1,
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

  it("validates a schema-6 continuation against its signed receipt ceiling", () => {
    const scenario = createContinuationScenario();
    const { successor_maximum_attempts: _removed, ...current } = scenario.continuation;
    const continuation = { ...current, schema_version: 6 as const };
    const receipt = createReceipt({
      observation: scenario.successorObservation,
      targetSelectionDigest: scenario.successorSelection.receipt_digest,
      continuation
    });
    const successorLedger = {
      ...scenario.predecessorLedger,
      lineageDigest: receipt.lineage_digest,
      maximumAttempts: receipt.limits.maximum_attempts
    };

    expect(() => assertSameRootExtractionContinuationRuntime({
      cacheRoot: scenario.cacheRoot,
      receipt,
      predecessor: scenario.predecessorReceipt,
      predecessorLedger: scenario.predecessorLedger,
      successorLedger,
      targetSelection: scenario.successorSelection,
      inspection: scenario.inspection
    })).not.toThrow();
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
