import { describe, expect, it } from "vitest";
import type { ExtractionAttemptLedgerSnapshot } from
  "../../../../longmemeval/extraction/authority/attempt-ledger.js";
import type { ExtractionAuthorityInspection } from
  "../../../../longmemeval/extraction/authority/inspection.js";
import type { ExtractionAuthorityReceipt } from
  "../../../../longmemeval/extraction/authority/receipt.js";
import {
  assertCatalogPredecessorState,
  assertContinuationInventory,
  assertInheritedContinuationPredecessorState,
  continuationPredecessorNewSuccessfulKeys
} from
  "../../../../longmemeval/extraction/authority/continuation/predecessor-state.js";
import type { SameRootExtractionContinuation } from
  "../../../../longmemeval/extraction/authority/continuation/contract.js";

const successfulKey = "1".repeat(64);
const missingKey = "2".repeat(64);
const laterKey = "3".repeat(64);
const baseClosure = closure(1, "a");
const fullPredecessorClosure = closure(2, "b");

describe("catalog refill continuation closure", () => {
  it("binds the audited base population plus predecessor successes", () => {
    expect(() => assertCatalogPredecessorState({
      inspection: inspection({
        expected: 3, valid: 2, missing: 1,
        missingKeys: [missingKey], preservedClosure: fullPredecessorClosure, rawClosure: "c"
      }),
      baseInspection: inspection({
        expected: 3, valid: 2, missing: 1,
        missingKeys: [missingKey], preservedClosure: baseClosure, rawClosure: "d"
      }),
      predecessor: ledger(1, [successfulKey]),
      scope: scope()
    })).not.toThrow();
  });

  it("rejects drift in the audited base population", () => {
    expect(() => assertCatalogPredecessorState({
      inspection: inspection({
        expected: 3, valid: 2, missing: 1,
        missingKeys: [missingKey], preservedClosure: fullPredecessorClosure, rawClosure: "c"
      }),
      baseInspection: inspection({
        expected: 3, valid: 2, missing: 1,
        missingKeys: [missingKey], preservedClosure: closure(1, "e"), rawClosure: "d"
      }),
      predecessor: ledger(1, [successfulKey]),
      scope: scope()
    })).toThrow(/catalog predecessor closure|preserved strict-valid closure drifted/u);
  });

  it("adds only successor successes to the full predecessor closure", () => {
    expect(() => assertContinuationInventory({
      inspection: inspection({
        expected: 3, valid: 3, missing: 0,
        missingKeys: [], preservedClosure: fullPredecessorClosure, rawClosure: "f"
      }),
      continuation: {
        preserved_valid_closure: fullPredecessorClosure
      } as SameRootExtractionContinuation,
      predecessor: ledger(1, [successfulKey]),
      successor: ledger(2, [successfulKey, missingKey])
    })).not.toThrow();
  });

  it("carries successful-key ancestry across continuation generations", () => {
    const receipt = inheritedReceipt(6, [successfulKey]);
    const predecessor = ledger(2, [successfulKey, missingKey]);
    expect(continuationPredecessorNewSuccessfulKeys(receipt, predecessor))
      .toEqual([missingKey]);
    expect(() => assertInheritedContinuationPredecessorState({
      inspection: inspection({
        expected: 3, valid: 3, missing: 0,
        missingKeys: [], preservedClosure: closure(3, "f"), rawClosure: "f"
      }),
      baseInspection: inspection({
        expected: 3, valid: 3, missing: 0,
        missingKeys: [], preservedClosure: fullPredecessorClosure, rawClosure: "b"
      }),
      predecessor,
      receipt
    })).not.toThrow();
  });

  it("continues a pristine schema-5 predecessor without inventing ancestry", () => {
    const receipt = inheritedReceipt(5, []);
    expect(continuationPredecessorNewSuccessfulKeys(receipt, ledger(0, []))).toEqual([]);
    expect(() => continuationPredecessorNewSuccessfulKeys(
      receipt, ledger(1, [laterKey])
    )).toThrow(/cannot prove successful-key ancestry/u);
  });
});

function inheritedReceipt(
  schemaVersion: 5 | 6,
  successfulKeys: readonly string[]
): ExtractionAuthorityReceipt {
  return {
    continuation: {
      schema_version: schemaVersion,
      preserved_valid_closure: fullPredecessorClosure,
      predecessor: {
        successful_shards: successfulKeys.length,
        ...(schemaVersion === 6 ? { successful_keys: successfulKeys } : {})
      }
    }
  } as ExtractionAuthorityReceipt;
}

function scope(): NonNullable<ExtractionAuthorityReceipt["catalog_refill"]> {
  return {
    shard_count: 2,
    keys: [successfulKey, missingKey],
    preserved_valid_closure: baseClosure,
    initial_raw_content_closure_sha256: "d".repeat(64)
  } as NonNullable<ExtractionAuthorityReceipt["catalog_refill"]>;
}

function ledger(
  successfulShards: number,
  successfulKeys: readonly string[]
): ExtractionAttemptLedgerSnapshot {
  return { successfulShards, successfulKeys } as ExtractionAttemptLedgerSnapshot;
}

function inspection(input: {
  readonly expected: number;
  readonly valid: number;
  readonly missing: number;
  readonly missingKeys: readonly string[];
  readonly preservedClosure: ExtractionAuthorityInspection["preservedValidClosure"];
  readonly rawClosure: string;
}): ExtractionAuthorityInspection {
  return {
    observation: {
      inventory: {
        expectedTurns: input.expected,
        validTurns: input.valid,
        missingTurns: input.missing,
        invalidTurns: 0,
        orphanTurns: 0
      },
      extraction: { rawContentClosureSha256: input.rawClosure.repeat(64) }
    },
    missingKeys: input.missingKeys,
    preservedValidClosure: input.preservedClosure
  } as ExtractionAuthorityInspection;
}

function closure(shardCount: number, digest: string) {
  return {
    shard_count: shardCount,
    key_set_sha256: digest.repeat(64),
    content_closure_sha256: digest.repeat(64)
  };
}
