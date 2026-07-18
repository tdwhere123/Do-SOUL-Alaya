import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  prepareExpansion: vi.fn(),
  readReceipt: vi.fn(),
  inspectAuthority: vi.fn(),
  readLedger: vi.fn(),
  readTargetSelection: vi.fn(),
  assertTargetSelection: vi.fn(),
  assertTargetSelectionWindow: vi.fn(),
  acquireWriteLease: vi.fn()
}));

vi.mock("../../../longmemeval/extraction/expansion-fill-authority.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../longmemeval/extraction/expansion-fill-authority.js")>(),
  prepareExpansionFillAuthority: mocks.prepareExpansion
}));
vi.mock("../../../longmemeval/extraction/cache/extraction-cache-manifest.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../longmemeval/extraction/cache/extraction-cache-manifest.js")>(),
  readExtractionCacheManifestIdentity: vi.fn(() => undefined)
}));
vi.mock("../../../longmemeval/extraction/authority/receipt.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../longmemeval/extraction/authority/receipt.js")>(),
  readExtractionAuthorityReceipt: mocks.readReceipt,
  assertExtractionAuthorityReceipt: vi.fn(),
  assertExtractionAuthorityRuntimeReadiness: vi.fn()
}));
vi.mock("../../../longmemeval/extraction/authority/inspection.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../longmemeval/extraction/authority/inspection.js")>(),
  inspectExtractionAuthority: mocks.inspectAuthority,
  inspectExtractionAuthorityDisk: vi.fn(),
  readCurrentExtractionAuthorityRevision: vi.fn(() => "revision")
}));
vi.mock("../../../longmemeval/extraction/authority/attempt-ledger.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../longmemeval/extraction/authority/attempt-ledger.js")>(),
  readExtractionAttemptLedger: mocks.readLedger,
  openExtractionAttemptLedger: vi.fn()
}));
vi.mock("../../../longmemeval/extraction/authority/target-selection/receipt.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../longmemeval/extraction/authority/target-selection/receipt.js")>(),
  readExtractionTargetSelectionReceipt: mocks.readTargetSelection,
  assertExtractionTargetSelectionReceipt: mocks.assertTargetSelection,
  assertExtractionTargetSelectionWindow: mocks.assertTargetSelectionWindow
}));
vi.mock("../../../longmemeval/extraction/authority/repair/repair-scope.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../longmemeval/extraction/authority/repair/repair-scope.js")>(),
  assertRemainingRepairShards: vi.fn()
}));
vi.mock("../../../longmemeval/extraction/authority/repair/preserved-valid-closure.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../longmemeval/extraction/authority/repair/preserved-valid-closure.js")>(),
  assertPreservedValidClosureUnchanged: vi.fn()
}));
vi.mock("../../../longmemeval/extraction/fill/manifest/fill-root-guard.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../longmemeval/extraction/fill/manifest/fill-root-guard.js")>(),
  acquireExtractionCacheWriteLease: mocks.acquireWriteLease
}));

import { runExtractionFill } from "../../../longmemeval/extraction/extraction-fill.js";

describe("500Q R3 receipt binding", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.prepareExpansion.mockResolvedValue(expansionFixture());
    mocks.readReceipt.mockReturnValue(receiptFixture());
    mocks.inspectAuthority.mockResolvedValue({
      observation: {},
      writerLock: "absent",
      disk: { status: "available", freeBytes: 1 },
      credentialStatus: "present",
      modelReadiness: "not_probed"
    });
    mocks.readLedger.mockReturnValue(undefined);
    mocks.readTargetSelection.mockReturnValue({ receipt_digest: "b".repeat(64) });
    mocks.assertTargetSelection.mockReturnValue(undefined);
    mocks.assertTargetSelectionWindow.mockReturnValue(undefined);
    mocks.acquireWriteLease.mockImplementation(() => {
      throw new Error("write lease reached");
    });
  });

  it("refuses canonical 500Q before the cache write lease without a receipt-bound authority", async () => {
    await expect(runExtractionFill({
      variant: "longmemeval_s",
      cacheRoot: "/must-not-lock"
    })).rejects.toThrow(/receipt-bound extraction authority/u);
  });

  it("refuses a 500Q receipt whose attempt ceiling exceeds the R3 approval", async () => {
    mocks.readReceipt.mockReturnValue({
      ...receiptFixture(),
      limits: { ...receiptFixture().limits, maximum_attempts: 442 }
    });

    await expect(runExtractionFill({
      variant: "longmemeval_s",
      cacheRoot: "/must-not-lock",
      authorityReceiptPath: "/fixture/extraction-authority.json",
      targetSelectionReceiptPath: "/fixture/target-selection.json"
    })).rejects.toThrow(/approved R3 spend envelope/u);
  });

  it("refuses a 500Q receipt whose successful-shard ceiling exceeds the R3 approval", async () => {
    mocks.readReceipt.mockReturnValue({
      ...receiptFixture(),
      limits: { ...receiptFixture().limits, successful_shard_ceiling: 401 }
    });

    await expect(runExtractionFill({
      variant: "longmemeval_s",
      cacheRoot: "/must-not-lock",
      authorityReceiptPath: "/fixture/extraction-authority.json",
      targetSelectionReceiptPath: "/fixture/target-selection.json"
    })).rejects.toThrow(/approved R3 spend envelope/u);
  });

  it("admits a receipt-bound repair limited to the existing first 100Q cache", async () => {
    mocks.readReceipt.mockReturnValue(repairReceiptFixture());

    await expect(runExtractionFill({
      variant: "longmemeval_s",
      limit: 500,
      questionBatchLimit: 100,
      cacheRoot: "/must-not-lock",
      authorityReceiptPath: "/fixture/extraction-authority.json"
    })).rejects.toThrow(/write lease reached/u);
    expect(mocks.prepareExpansion).not.toHaveBeenCalled();
  });

  it("keeps the expansion gate for an unbounded 500Q repair request", async () => {
    mocks.readReceipt.mockReturnValue(repairReceiptFixture());

    await expect(runExtractionFill({
      variant: "longmemeval_s",
      limit: 500,
      cacheRoot: "/must-not-lock",
      authorityReceiptPath: "/fixture/extraction-authority.json"
    })).rejects.toThrow(/approved R3 spend envelope/u);
    expect(mocks.prepareExpansion).toHaveBeenCalledOnce();
    expect(mocks.acquireWriteLease).not.toHaveBeenCalled();
  });

  it("does not treat a question-bounded normal fill as an existing-cache repair", async () => {
    mocks.prepareExpansion.mockRejectedValueOnce(new Error("promotion gate reached"));

    await expect(runExtractionFill({
      variant: "longmemeval_s",
      limit: 500,
      questionBatchLimit: 100,
      cacheRoot: "/must-not-lock",
      authorityReceiptPath: "/fixture/extraction-authority.json",
      targetSelectionReceiptPath: "/fixture/target-selection.json"
    })).rejects.toThrow(/promotion gate reached/u);
    expect(mocks.prepareExpansion).toHaveBeenCalledOnce();
    expect(mocks.acquireWriteLease).not.toHaveBeenCalled();
  });
});

function expansionFixture() {
  return {
    r3SpendApproval: {
      approval: {
        r2: { final_cache_identity_sha256: "a".repeat(64) },
        spend: {
          starting_missing: 400,
          maximum_attempts: 441,
          successful_shard_ceiling: 400,
          estimated_cost_usd: 5,
          disk_floor_bytes: 10
        }
      }
    }
  };
}

function receiptFixture() {
  return {
    action: "fill",
    observation: {
      dataset: {
        variant: "longmemeval_s",
        windowOffset: 0,
        windowLimit: 500
      },
      extraction: { manifestSha256: "a".repeat(64) },
      inventory: { missingTurns: 400 }
    },
    limits: {
      starting_missing: 400,
      maximum_attempts: 441,
      successful_shard_ceiling: 400,
      disk_floor_bytes: 10
    },
    price: { estimated_upper_usd: 5 },
    target_selection_digest: "b".repeat(64)
  };
}

function repairReceiptFixture() {
  const receipt = receiptFixture();
  return {
    ...receipt,
    target_selection_digest: undefined,
    observation: {
      ...receipt.observation,
      dataset: {
        ...receipt.observation.dataset,
        authorizedQuestionCount: 100
      },
      inventory: {
        expectedTurns: 23_807,
        validTurns: 14_272,
        missingTurns: 0,
        invalidTurns: 9_535,
        orphanTurns: 0
      }
    },
    repair_scope: {
      shard_count: 9_535,
      shards: [],
      preserved_valid_closure: { shard_count: 14_272 }
    }
  };
}
