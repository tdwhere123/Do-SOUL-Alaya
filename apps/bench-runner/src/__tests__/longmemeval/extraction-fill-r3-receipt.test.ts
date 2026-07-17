import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  prepareExpansion: vi.fn(),
  readReceipt: vi.fn(),
  inspectAuthority: vi.fn(),
  readLedger: vi.fn()
}));

vi.mock("../../longmemeval/extraction/expansion-fill-authority.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../longmemeval/extraction/expansion-fill-authority.js")>(),
  prepareExpansionFillAuthority: mocks.prepareExpansion
}));
vi.mock("../../longmemeval/extraction-cache-manifest.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../longmemeval/extraction-cache-manifest.js")>(),
  readExtractionCacheManifestIdentity: vi.fn(() => undefined)
}));
vi.mock("../../longmemeval/extraction/authority/receipt.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../longmemeval/extraction/authority/receipt.js")>(),
  readExtractionAuthorityReceipt: mocks.readReceipt,
  assertExtractionAuthorityReceipt: vi.fn(),
  assertExtractionAuthorityRuntimeReadiness: vi.fn()
}));
vi.mock("../../longmemeval/extraction/authority/inspection.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../longmemeval/extraction/authority/inspection.js")>(),
  inspectExtractionAuthority: mocks.inspectAuthority,
  inspectExtractionAuthorityDisk: vi.fn(),
  readCurrentExtractionAuthorityRevision: vi.fn(() => "revision")
}));
vi.mock("../../longmemeval/extraction/authority/attempt-ledger.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../longmemeval/extraction/authority/attempt-ledger.js")>(),
  readExtractionAttemptLedger: mocks.readLedger,
  openExtractionAttemptLedger: vi.fn()
}));

import { runExtractionFill } from "../../longmemeval/extraction-fill.js";

describe("500Q R3 receipt binding", () => {
  beforeEach(() => {
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
      authorityReceiptPath: "/fixture/extraction-authority.json"
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
      authorityReceiptPath: "/fixture/extraction-authority.json"
    })).rejects.toThrow(/approved R3 spend envelope/u);
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
    price: { estimated_upper_usd: 5 }
  };
}
