import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertCatalogRefillRootBinding,
  assertCatalogRefillScopeMatchesInspection,
  createExtractionCatalogRefillScope
} from "../../../../longmemeval/extraction/authority/catalog-refill/scope.js";
import { createExtractionAuthorityReceipt } from
  "../../../../longmemeval/extraction/authority/receipt.js";
import type { ExtractionAuthorityInspection } from
  "../../../../longmemeval/extraction/authority/inspection.js";

const roots: string[] = [];
const firstKey = "1".repeat(64);
const secondKey = "2".repeat(64);

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("catalog refill authority scope creation", () => {
  it("binds exactly the current missing set, current manifest, and existing root", () => {
    const cacheRoot = temporaryRoot();
    const inspection = inspected([firstKey, secondKey]);
    const scope = createExtractionCatalogRefillScope({
      cacheRoot,
      inspection,
      allowlist: allowlist([secondKey, firstKey])
    });

    expect(scope).toMatchObject({
      kind: "audited-missing-cache-keys-v1",
      shard_count: 2,
      keys: [firstKey, secondKey],
      initial_manifest_sha256: "f".repeat(64),
      initial_raw_content_closure_sha256: "e".repeat(64)
    });
    expect(() => assertCatalogRefillScopeMatchesInspection({
      scope, cacheRoot, inspection
    })).not.toThrow();
  });

  it("rejects a list that is not exactly the currently audited missing set", () => {
    expect(() => createExtractionCatalogRefillScope({
      cacheRoot: temporaryRoot(),
      inspection: inspected([firstKey, secondKey]),
      allowlist: allowlist([firstKey])
    })).toThrow(/allowlist does not match/u);
  });

  it("rejects a root or missing-set drift before any attempt is reserved", () => {
    const cacheRoot = temporaryRoot();
    const scope = createExtractionCatalogRefillScope({
      cacheRoot,
      inspection: inspected([firstKey, secondKey]),
      allowlist: allowlist([firstKey, secondKey])
    });

    expect(() => assertCatalogRefillRootBinding(scope.root_binding, temporaryRoot()))
      .toThrow(/root binding drifted/u);
    expect(() => assertCatalogRefillScopeMatchesInspection({
      scope,
      cacheRoot,
      inspection: inspected([firstKey, "3".repeat(64)])
    })).toThrow(/missing-key set drifted/u);
  });
});

describe("catalog refill authority scope progress", () => {
  it("accepts only receipt-ledger progress over the original missing set", () => {
    const cacheRoot = temporaryRoot();
    const scope = createExtractionCatalogRefillScope({
      cacheRoot,
      inspection: inspected([firstKey, secondKey]),
      allowlist: allowlist([firstKey, secondKey])
    });
    const current = inspected([secondKey]);
    const resumed = {
      ...current,
      observation: {
        ...current.observation,
        extraction: {
          ...current.observation.extraction,
          manifestSha256: "9".repeat(64)
        }
      },
      preservedValidClosure: {
        ...current.preservedValidClosure,
        shard_count: 2
      }
    } as ExtractionAuthorityInspection;

    expect(() => assertCatalogRefillScopeMatchesInspection({
      scope,
      cacheRoot,
      inspection: resumed,
      ledgerProgress: { attempts: 1, successfulKeys: [firstKey] }
    })).toThrow(/cache manifest drifted/u);
    expect(() => assertCatalogRefillScopeMatchesInspection({
      scope,
      cacheRoot,
      inspection: resumed,
      resumeManifestSha256: "9".repeat(64),
      ledgerProgress: { attempts: 1, successfulKeys: [firstKey] }
    })).not.toThrow();
    expect(() => assertCatalogRefillScopeMatchesInspection({
      scope,
      cacheRoot,
      inspection: resumed,
      ledgerProgress: { attempts: 1, successfulKeys: ["3".repeat(64)] }
    })).toThrow(/out-of-scope success/u);
  });
});

describe("catalog refill authority target selection", () => {
  it("requires an existing-root refill to bind its adopted target selection", () => {
    const cacheRoot = temporaryRoot();
    const inspection = inspected([firstKey, secondKey]);
    const catalogRefillScope = createExtractionCatalogRefillScope({
      cacheRoot,
      inspection,
      allowlist: allowlist([firstKey, secondKey])
    });

    expect(createExtractionAuthorityReceipt({
      action: "fill",
      observation: inspection.observation,
      outputTokenCap: { field: "max_tokens", value: 512 },
      priceEstimate: {
        inputUsdPerMillion: 1,
        outputUsdPerMillion: 2,
        maximumInputTokensPerAttempt: 300
      },
      diskFloorBytes: 0,
      inspection: {
        writerLock: inspection.writerLock,
        disk: inspection.disk,
        credentialStatus: inspection.credentialStatus,
        modelReadiness: inspection.modelReadiness
      },
      targetSelectionDigest: "f".repeat(64),
      catalogRefillScope
    })).toMatchObject({
      catalog_refill: catalogRefillScope,
      target_selection_digest: "f".repeat(64)
    });
    expect(() => createExtractionAuthorityReceipt({
      action: "fill",
      observation: inspection.observation,
      outputTokenCap: { field: "max_tokens", value: 512 },
      priceEstimate: {
        inputUsdPerMillion: 1,
        outputUsdPerMillion: 2,
        maximumInputTokensPerAttempt: 300
      },
      diskFloorBytes: 0,
      inspection: {
        writerLock: inspection.writerLock,
        disk: inspection.disk,
        credentialStatus: inspection.credentialStatus,
        modelReadiness: inspection.modelReadiness
      },
      catalogRefillScope
    })).toThrow(/existing-root fill authority mode/u);
  });
});

function inspected(missingKeys: readonly string[]): ExtractionAuthorityInspection {
  const validTurns = 4 - missingKeys.length;
  return {
    observation: {
      revision: "a".repeat(40),
      commandDigest: "b".repeat(64),
      selectionDigest: "c".repeat(64),
      keyDigest: "d".repeat(64),
      dataset: {
        variant: "longmemeval_s",
        revisionSha256: "a".repeat(64),
        windowOffset: 0,
        windowLimit: 100,
        expectedKeySetSha256: "d".repeat(64)
      },
      extraction: {
        model: "gpt-5.4-mini",
        modelFamily: "gpt-5.4-mini",
        requestProfile: "provider-default-v1",
        providerUrl: "https://example.test/v1",
        systemPromptSha256: "e".repeat(64),
        cacheKeyAlgorithm: "test",
        manifestSha256: "f".repeat(64),
        rawContentClosureSha256: "e".repeat(64)
      },
      inventory: {
        expectedTurns: 4,
        validTurns,
        missingTurns: missingKeys.length,
        invalidTurns: 0,
        orphanTurns: 0
      }
    },
    missingKeys,
    invalidShards: [],
    preservedValidClosure: {
      shard_count: validTurns,
      key_set_sha256: "a".repeat(64),
      content_closure_sha256: "b".repeat(64)
    },
    writerLock: "absent",
    disk: { status: "available", freeBytes: 1 },
    credentialStatus: "present",
    modelReadiness: "not_probed"
  } as ExtractionAuthorityInspection;
}

function allowlist(cacheKeys: readonly string[]) {
  return {
    kind: "test-catalog-refill",
    expected_turns: 4,
    cached_turns: 4 - cacheKeys.length,
    missing_turns: cacheKeys.length,
    expected_key_set_sha256: "d".repeat(64),
    cache_keys: cacheKeys
  };
}

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "alaya-catalog-refill-"));
  roots.push(root);
  return root;
}
