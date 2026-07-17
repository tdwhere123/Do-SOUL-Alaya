import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { buildExtractionCacheAuditReceipt } from
  "../../../longmemeval/extraction/cache-audit/receipt.js";
import { createExtractionAuthorityReceipt, type ExtractionAuthorityObservation } from
  "../../../longmemeval/extraction/authority/receipt.js";
import { createFreshExtractionTargetSelection } from
  "../../../longmemeval/extraction/authority/target-selection/receipt.js";
import { createExtractionExecutionAuthority } from
  "../../../longmemeval/extraction/fill/execution-authority.js";

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

it("rechecks a selected root before opening an attempt ledger or reserving a provider call", () => {
  const parent = mkdtempSync(join(tmpdir(), "alaya-target-selection-execution-"));
  roots.push(parent);
  const cacheRoot = join(parent, "cache");
  const selection = createFreshExtractionTargetSelection({
    cacheRoot,
    auditReceipt: rebuildAuditReceipt(),
    observation: observation()
  });
  const authority = createExtractionAuthorityReceipt({
    action: "fill",
    observation: observation(),
    outputTokenCap: { field: "max_tokens", value: 512 },
    priceEstimate: {
      inputUsdPerMillion: 1,
      outputUsdPerMillion: 2,
      maximumInputTokensPerAttempt: 300
    },
    diskFloorBytes: 0,
    inspection: {
      writerLock: "absent",
      disk: { status: "available", freeBytes: 2_048 },
      credentialStatus: "present",
      modelReadiness: "not_probed"
    },
    targetSelectionDigest: selection.receipt_digest
  });

  rmSync(cacheRoot, { recursive: true, force: true });
  mkdirSync(cacheRoot);

  expect(() => createExtractionExecutionAuthority(authority, cacheRoot, selection))
    .toThrow(/target root changed/u);
  expect(readdirSync(cacheRoot)).toEqual([]);
});

function observation(): ExtractionAuthorityObservation {
  return {
    revision: `git-worktree-v1:${"a".repeat(40)}:${"b".repeat(64)}`,
    commandDigest: "c".repeat(64),
    selectionDigest: "d".repeat(64),
    keyDigest: "e".repeat(64),
    dataset: {
      variant: "longmemeval_s",
      revisionSha256: "f".repeat(64),
      windowOffset: 0,
      windowLimit: 100,
      expectedKeySetSha256: "e".repeat(64)
    },
    extraction: {
      model: "gpt-5.4-mini",
      modelFamily: "gpt-5.4-mini",
      requestProfile: "provider-default-v1",
      providerUrl: "https://example.test/v1",
      systemPromptSha256: "1".repeat(64),
      cacheKeyAlgorithm: "sha256(model\\0requestProfile\\0systemPrompt\\0turnContent)",
      manifestSha256: null,
      rawContentClosureSha256: null
    },
    inventory: {
      expectedTurns: 10,
      validTurns: 0,
      missingTurns: 10,
      invalidTurns: 0,
      orphanTurns: 0
    }
  };
}

function rebuildAuditReceipt() {
  const finalIdentity = {
    datasetRevision: "f".repeat(64),
    model: "gpt-5.4-mini",
    modelFamily: "gpt-5.4-mini",
    requestProfile: "provider-default-v1",
    providerUrl: "https://example.test/v1",
    systemPromptSha256: "1".repeat(64),
    cacheKeyAlgorithm: "sha256(model\\0requestProfile\\0systemPrompt\\0turnContent)",
    rawClosureSha256: "2".repeat(64),
    parserSemanticsSha256: "3".repeat(64),
    formationSemanticsSha256: "4".repeat(64),
    temporalSchemaRevision: "5".repeat(64)
  };
  return buildExtractionCacheAuditReceipt({
    createdAt: "2026-07-17T00:00:00.000Z",
    sourceRoot: "/source-cache",
    sourceManifestSha256: "6".repeat(64),
    rawInventorySha256: "7".repeat(64),
    occurrenceIndexSha256: "8".repeat(64),
    decision: {
      action: "rebuild",
      sourceRoot: "/source-cache",
      reasons: ["model_mismatch"],
      source: { ...finalIdentity, model: "old-model" },
      final: finalIdentity,
      replay: {
        occurrenceCount: 10,
        accountedOccurrences: 10,
        elementCount: 10,
        accountedElements: 10,
        admitted: 10,
        deferred: 0,
        rejected: 0,
        invalid: 0,
        ledgerSha256: "9".repeat(64)
      }
    }
  });
}
