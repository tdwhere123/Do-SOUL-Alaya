import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { buildExtractionCacheAuditReceipt } from
  "../../../../longmemeval/extraction/cache-audit/receipt.js";
import {
  assertExtractionTargetSelectionReceipt,
  createFreshExtractionTargetSelection,
  createFreshRetiredSourceRebuildTargetSelection,
  readExtractionTargetSelectionReceipt,
  requiresExtractionTargetSelection
} from "../../../../longmemeval/extraction/authority/target-selection/receipt.js";
import type { ExtractionAuthorityObservation } from
  "../../../../longmemeval/extraction/authority/receipt.js";

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

it("binds a fresh rebuild root to the audited final extraction identity", () => {
  const parent = createTemporaryRoot();
  const cacheRoot = join(parent, "cache");
  const receipt = createFreshExtractionTargetSelection({
    cacheRoot,
    auditReceipt: rebuildAuditReceipt(),
    observation: initialObservation()
  });

  expect(() => assertExtractionTargetSelectionReceipt({
    receipt,
    cacheRoot,
    observation: initialObservation()
  })).not.toThrow();
  expect(receipt.initial_selection).toMatchObject({ offset: 0, limit: 100 });

  rmSync(cacheRoot, { recursive: true, force: true });
  mkdirSync(cacheRoot);
  expect(() => assertExtractionTargetSelectionReceipt({
    receipt,
    cacheRoot,
    observation: initialObservation()
  })).toThrow(/target root changed/u);
});

it("binds an operator-authorized retired-source rebuild to a fresh target", () => {
  const parent = createTemporaryRoot();
  const cacheRoot = join(parent, "cache");
  const receipt = createFreshRetiredSourceRebuildTargetSelection({
    cacheRoot,
    operator: "local-operator",
    observation: initialObservation()
  });

  expect(receipt).toMatchObject({
    schema_version: 2,
    selection_basis: { kind: "retired_source_rebuild", operator: "local-operator" }
  });
  expect(() => assertExtractionTargetSelectionReceipt({
    receipt,
    cacheRoot,
    observation: initialObservation()
  })).not.toThrow();
  expect(() => createFreshRetiredSourceRebuildTargetSelection({
    cacheRoot: join(parent, "invalid-operator"),
    operator: " ",
    observation: initialObservation()
  })).toThrow(/operator/u);
});

it("rejects legacy V1 target selections during deserialization", () => {
  const parent = createTemporaryRoot();
  const receipt = createFreshRetiredSourceRebuildTargetSelection({
    cacheRoot: join(parent, "cache"),
    operator: "local-operator",
    observation: initialObservation()
  });
  const { selection_basis: _selectionBasis, ...legacyReceipt } = receipt;
  const path = join(parent, "legacy-target-selection.json");
  writeFileSync(path, `${JSON.stringify({
    ...legacyReceipt,
    schema_version: 1,
    audit_decision_digest: "a".repeat(64)
  })}\n`);

  expect(() => readExtractionTargetSelectionReceipt(path)).toThrow(
    /invalid extraction target selection receipt/u
  );
});

it("rejects an audit final identity that disagrees with the selected root", () => {
  const parent = createTemporaryRoot();
  expect(() => createFreshExtractionTargetSelection({
    cacheRoot: join(parent, "cache"),
    auditReceipt: rebuildAuditReceipt({ model: "other-model" }),
    observation: initialObservation()
  })).toThrow(/audit final identity/u);
});

it("limits target selection to the canonical LongMemEval-S 100Q and 500Q windows", () => {
  const observation = initialObservation();

  expect(requiresExtractionTargetSelection(observation)).toBe(true);
  expect(requiresExtractionTargetSelection({
    ...observation,
    dataset: { ...observation.dataset, windowLimit: 500 }
  })).toBe(true);
  expect(requiresExtractionTargetSelection({
    ...observation,
    dataset: { ...observation.dataset, variant: "longmemeval_oracle" }
  })).toBe(false);
  expect(requiresExtractionTargetSelection({
    ...observation,
    dataset: { ...observation.dataset, windowLimit: 1 }
  })).toBe(false);
});

function createTemporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "alaya-target-selection-"));
  roots.push(root);
  return root;
}

function initialObservation(): ExtractionAuthorityObservation {
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

function rebuildAuditReceipt(overrides: Partial<{ model: string }> = {}) {
  const finalIdentity = {
    datasetRevision: "f".repeat(64),
    model: overrides.model ?? "gpt-5.4-mini",
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
