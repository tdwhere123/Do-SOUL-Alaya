import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  assertExtractionAuthorityReceipt,
  createExtractionAuthorityReceipt
} from "../../../../runs/extraction/authority/receipt.js";
import { createExtractionRepairScope } from
  "../../../../runs/extraction/authority/repair/repair-scope.js";
import { computeExtractionFillAttemptCeiling } from
  "../../../../runs/extraction/authority/receipt-limits.js";

const observation = {
  revision: `git-worktree-v1:${"d".repeat(40)}:${"1".repeat(64)}`,
  commandDigest: "e".repeat(64),
  selectionDigest: "f".repeat(64),
  keyDigest: "b".repeat(64),
  dataset: {
    variant: "longmemeval_s",
    revisionSha256: "a".repeat(64),
    windowOffset: 0,
    windowLimit: 100,
    windowTurnOccurrences: 20,
    windowUniqueCacheKeys: 15,
    authorizedQuestionCount: 50,
    authorizedTurnOccurrences: 12,
    authorizedUniqueCacheKeys: 10,
    expectedKeySetSha256: "b".repeat(64)
  },
  extraction: {
    model: "gpt-5.4-mini",
    modelFamily: "gpt-5.4-mini",
    requestProfile: "provider-default-v1" as const,
    providerUrl: "https://example.test/v1",
    systemPromptSha256: "c".repeat(64),
    cacheKeyAlgorithm: "sha256(model\\0requestProfile\\0systemPrompt\\0turnContent)",
    manifestSha256: null,
    rawContentClosureSha256: null
  },
  inventory: {
    expectedTurns: 10,
    validTurns: 1,
    missingTurns: 9,
    invalidTurns: 0,
    orphanTurns: 0
  }
};

describe("extraction authority receipt", () => {
  it("binds the fixed identity to non-resettable success and attempt ceilings", () => {
    const receipt = createExtractionAuthorityReceipt({
      action: "fill",
      observation,
      outputTokenCap: { field: "max_tokens", value: 512 },
      priceEstimate: {
        inputUsdPerMillion: 1,
        outputUsdPerMillion: 2,
        maximumInputTokensPerAttempt: 300
      },
      diskFloorBytes: 1_024,
      inspection: {
        writerLock: "absent",
        disk: { status: "available", freeBytes: 2_048 },
        credentialStatus: "present",
        modelReadiness: "not_probed"
      }
    });

    expect(receipt.identity_digest).toMatch(/^[a-f0-9]{64}$/u);
    expect(receipt.receipt_digest).toMatch(/^[a-f0-9]{64}$/u);
    expect(receipt.limits).toMatchObject({
      starting_missing: 9,
      maximum_attempts: computeExtractionFillAttemptCeiling(9),
      successful_shard_ceiling: 9,
      max_output_tokens: 512,
      no_progress_timeout_ms: 1_800_000
    });
    expect(receipt.price.estimated_upper_usd).toBeGreaterThan(0);
    expect(() => assertExtractionAuthorityReceipt(receipt, observation)).not.toThrow();
  });

  it("accepts a MiMo request profile as sealed fill authority", () => {
    const mimoObservation = {
      ...observation,
      extraction: {
        ...observation.extraction,
        model: "mimo-v2.5",
        modelFamily: "mimo-v2.5",
        requestProfile: "mimo-v2.5-nonthinking-v1" as const
      }
    };
    const receipt = createExtractionAuthorityReceipt({
      action: "fill",
      observation: mimoObservation,
      outputTokenCap: { field: "max_tokens", value: 512 },
      priceEstimate: {
        inputUsdPerMillion: 0,
        outputUsdPerMillion: 0,
        maximumInputTokensPerAttempt: 300
      },
      diskFloorBytes: 1_024,
      inspection: {
        writerLock: "absent",
        disk: { status: "available", freeBytes: 2_048 },
        credentialStatus: "present",
        modelReadiness: "not_probed"
      }
    });
    expect(receipt.observation.extraction.requestProfile).toBe("mimo-v2.5-nonthinking-v1");
    expect(() => assertExtractionAuthorityReceipt(receipt, mimoObservation)).not.toThrow();
  });

  it("rejects a fresh fill cap that omits the bounded retry envelope", () => {
    expect(() => createExtractionAuthorityReceipt({
      action: "fill",
      observation,
      cumulativeLimits: {
        startingMissing: 9,
        maximumAttempts: 8,
        successfulShardCeiling: 9
      },
      outputTokenCap: { field: "max_tokens", value: 512 },
      priceEstimate: {
        inputUsdPerMillion: 1,
        outputUsdPerMillion: 2,
        maximumInputTokensPerAttempt: 300
      },
      diskFloorBytes: 1_024,
      inspection: {
        writerLock: "absent",
        disk: { status: "available", freeBytes: 2_048 },
        credentialStatus: "present",
        modelReadiness: "not_probed"
      }
    })).toThrow(/cumulative limits are not derivable/u);
  });

  it("validates an actual signed v4 artifact with the five-attempt policy", () => {
    const legacy = JSON.parse(readFileSync(
      new URL("./fixtures/authority-v4-five-attempts.json", import.meta.url), "utf8"
    )) as Parameters<typeof assertExtractionAuthorityReceipt>[0];

    expect(() => assertExtractionAuthorityReceipt(legacy, legacy.observation)).not.toThrow();
  });

  it.each([
    [3, Math.ceil(observation.inventory.missingTurns * 1.1)],
    [3, observation.inventory.missingTurns * 5],
    [4, observation.inventory.missingTurns * 4]
  ] as const)("validates signed schema %i receipt ceiling %i", (schemaVersion, ceiling) => {
    const legacy = signLegacyReceipt(createModernReceipt(), schemaVersion, ceiling);
    expect(() => assertExtractionAuthorityReceipt(legacy, observation)).not.toThrow();
  });

  it("allows only monotonic in-lineage inventory progress after receipt creation", () => {
    const receipt = createExtractionAuthorityReceipt({
      action: "fill",
      observation,
      outputTokenCap: { field: "max_tokens", value: 512 },
      priceEstimate: {
        inputUsdPerMillion: 1,
        outputUsdPerMillion: 2,
        maximumInputTokensPerAttempt: 300
      },
      diskFloorBytes: 1_024,
      inspection: {
        writerLock: "absent",
        disk: { status: "available", freeBytes: 2_048 },
        credentialStatus: "present",
        modelReadiness: "not_probed"
      }
    });

    expect(() => assertExtractionAuthorityReceipt(receipt, {
      ...observation,
      inventory: { ...observation.inventory, missingTurns: 8, validTurns: 2 }
    })).not.toThrow();
    expect(() => assertExtractionAuthorityReceipt(receipt, {
      ...observation,
      inventory: { ...observation.inventory, missingTurns: 10, validTurns: 0 }
    })).toThrow(/regressed/u);
  });

  it("rejects a tampered receipt and a stale revision before live work", () => {
    const receipt = createExtractionAuthorityReceipt({
      action: "fill",
      observation,
      outputTokenCap: { field: "max_tokens", value: 512 },
      priceEstimate: {
        inputUsdPerMillion: 1,
        outputUsdPerMillion: 2,
        maximumInputTokensPerAttempt: 300
      },
      diskFloorBytes: 1_024,
      inspection: {
        writerLock: "absent",
        disk: { status: "available", freeBytes: 2_048 },
        credentialStatus: "present",
        modelReadiness: "not_probed"
      }
    });
    const tampered = {
      ...receipt,
      price: { ...receipt.price, estimated_upper_usd: receipt.price.estimated_upper_usd + 1 }
    };

    expect(() => assertExtractionAuthorityReceipt(tampered, observation))
      .toThrow(/invalid|digest/u);
    expect(() => assertExtractionAuthorityReceipt(receipt, {
      ...observation,
      revision: `git-worktree-v1:${"a".repeat(40)}:${"1".repeat(64)}`
    })).toThrow(/identity drift|does not match/u);
    expect(() => assertExtractionAuthorityReceipt(receipt, {
      ...observation,
      extraction: {
        ...observation.extraction,
        rawContentClosureSha256: "a".repeat(64)
      }
    })).toThrow(/raw cache closure/u);
  });

  it("binds an in-place repair to exact strict-invalid shard content", () => {
    const repairScope = createExtractionRepairScope([
      { cache_key: "1".repeat(64), raw_json_sha256: "2".repeat(64) },
      { cache_key: "3".repeat(64), raw_json_sha256: "4".repeat(64) }
    ], {
      shard_count: 8,
      key_set_sha256: "5".repeat(64),
      content_closure_sha256: "6".repeat(64)
    });
    const repairObservation = {
      ...observation,
      inventory: {
        expectedTurns: 10, validTurns: 8, missingTurns: 0, invalidTurns: 2, orphanTurns: 0
      }
    };
    const receipt = createExtractionAuthorityReceipt({
      action: "fill",
      observation: repairObservation,
      repairScope,
      cumulativeLimits: {
        startingMissing: 2,
        maximumAttempts: computeExtractionFillAttemptCeiling(2),
        successfulShardCeiling: 2
      },
      outputTokenCap: { field: "max_tokens", value: 4096 },
      priceEstimate: {
        inputUsdPerMillion: 0,
        outputUsdPerMillion: 0,
        maximumInputTokensPerAttempt: 300
      },
      diskFloorBytes: 0,
      inspection: {
        writerLock: "absent",
        disk: { status: "available", freeBytes: 2_048 },
        credentialStatus: "present",
        modelReadiness: "not_probed"
      }
    });

    expect(receipt.repair_scope?.source_content_sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(receipt.observation.dataset).toMatchObject({
      windowTurnOccurrences: 20,
      windowUniqueCacheKeys: 15,
      authorizedQuestionCount: 50,
      authorizedTurnOccurrences: 12,
      authorizedUniqueCacheKeys: 10
    });
    expect(receipt.limits).toMatchObject({
      starting_missing: 2,
      maximum_attempts: computeExtractionFillAttemptCeiling(2),
      successful_shard_ceiling: 2,
      max_output_tokens: 4096
    });
    expect(() => assertExtractionAuthorityReceipt(receipt, {
      ...repairObservation,
      inventory: {
        expectedTurns: 10, validTurns: 9, missingTurns: 0, invalidTurns: 1, orphanTurns: 0
      }
    })).not.toThrow();
    expect(() => assertExtractionAuthorityReceipt(receipt, {
      ...repairObservation,
      inventory: {
        expectedTurns: 10, validTurns: 8, missingTurns: 1, invalidTurns: 1, orphanTurns: 0
      }
    })).toThrow(/bounded scope/u);
    expect(() => createExtractionAuthorityReceipt({
      action: "fill",
      observation: {
        ...repairObservation,
        dataset: { ...repairObservation.dataset, authorizedUniqueCacheKeys: 9 }
      },
      repairScope,
      cumulativeLimits: {
        startingMissing: 2,
        maximumAttempts: computeExtractionFillAttemptCeiling(2),
        successfulShardCeiling: 2
      },
      outputTokenCap: { field: "max_tokens", value: 4096 },
      priceEstimate: {
        inputUsdPerMillion: 0,
        outputUsdPerMillion: 0,
        maximumInputTokensPerAttempt: 300
      },
      diskFloorBytes: 0,
      inspection: {
        writerLock: "absent",
        disk: { status: "available", freeBytes: 2_048 },
        credentialStatus: "present",
        modelReadiness: "not_probed"
      }
    })).toThrow(/observation is invalid/u);
  });
});

function createModernReceipt() {
  return createExtractionAuthorityReceipt({
    action: "fill",
    observation,
    outputTokenCap: { field: "max_tokens", value: 512 },
    priceEstimate: {
      inputUsdPerMillion: 1,
      outputUsdPerMillion: 2,
      maximumInputTokensPerAttempt: 300
    },
    diskFloorBytes: 1_024,
    inspection: {
      writerLock: "absent",
      disk: { status: "available", freeBytes: 2_048 },
      credentialStatus: "present",
      modelReadiness: "not_probed"
    }
  });
}

function signLegacyReceipt(
  modern: ReturnType<typeof createModernReceipt>,
  schemaVersion: 3 | 4,
  maximumAttempts: number
) {
  const { receipt_digest: _discarded, ...modernUnsigned } = modern;
  const unsigned = {
    ...modernUnsigned,
    schema_version: schemaVersion,
    limits: { ...modern.limits, maximum_attempts: maximumAttempts }
  };
  return {
    ...unsigned,
    receipt_digest: createHash("sha256").update(JSON.stringify(unsigned), "utf8").digest("hex")
  };
}
