import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { buildExtractionCacheAuditReceipt } from
  "../../../longmemeval/extraction/cache-audit/receipt.js";
import { runSelectExtractionTargetCommand } from
  "../../../cli/target-selection/command.js";
import { readExtractionTargetSelectionReceipt } from
  "../../../longmemeval/extraction/authority/target-selection/receipt.js";
import type { ExtractionTargetSelectionReceipt } from
  "../../../longmemeval/extraction/authority/target-selection/receipt.js";
import type { ExtractionAuthorityReceipt } from
  "../../../longmemeval/extraction/authority/receipt.js";
import type { ExtractionContinuationChildClaim } from
  "../../../longmemeval/extraction/authority/continuation/child-claim.js";
import { emptyExtractionAuthorityShardStatus } from
  "../extraction-authority-inspection-fixture.js";

const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

it("selects a fresh canonical 100Q root without invoking a provider", async () => {
  const root = mkdtempSync(join(tmpdir(), "alaya-target-selection-command-"));
  roots.push(root);
  const cacheRoot = join(root, "cache");
  const write = vi.fn();
  const inspect = vi.fn(async () => {
    expect(existsSync(cacheRoot)).toBe(true);
    return inspection();
  });
  const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);

  const exitCode = await runSelectExtractionTargetCommand([
    "--variant", "s", "--offset", "0", "--limit", "100",
    "--extraction-cache-root", cacheRoot,
    "--cache-audit-receipt", join(root, "audit.json"),
    "--target-selection-out", join(root, "target-selection.json")
  ], {
    inspect,
    readAudit: () => rebuildAuditReceipt(),
    write,
    readRevision: () => "a".repeat(40)
  });

  expect(exitCode).toBe(0);
  expect(inspect).toHaveBeenCalledWith(expect.objectContaining({
    action: "probe", cacheRoot, limit: 100, offset: 0
  }));
  expect(write).toHaveBeenCalledOnce();
  expect(write.mock.calls[0]?.[1]).toMatchObject({
    kind: "longmemeval-extraction-target-selection",
    selection_basis: { kind: "cache_audit" },
    initial_selection: { offset: 0, limit: 100 }
  });
  expect(stdout).toHaveBeenCalledWith(expect.stringContaining("Extraction target selection written"));
});

it("selects a fresh root from an explicit retired-source rebuild authorization", async () => {
  const root = mkdtempSync(join(tmpdir(), "alaya-target-selection-command-"));
  roots.push(root);
  const cacheRoot = join(root, "cache");
  const write = vi.fn();

  const exitCode = await runSelectExtractionTargetCommand([
    "--variant", "s", "--offset", "0", "--limit", "100",
    "--extraction-cache-root", cacheRoot,
    "--retired-source-rebuild-operator", "local-operator",
    "--target-selection-out", join(root, "target-selection.json")
  ], {
    inspect: async () => inspection(),
    write,
    readRevision: () => "a".repeat(40)
  });

  expect(exitCode).toBe(0);
  expect(write.mock.calls[0]?.[1]).toMatchObject({
    selection_basis: { kind: "retired_source_rebuild", operator: "local-operator" }
  });
});

it("rejects ambiguous target-selection authority inputs before creating a root", async () => {
  const root = mkdtempSync(join(tmpdir(), "alaya-target-selection-command-"));
  roots.push(root);
  const cacheRoot = join(root, "cache");
  const inspect = vi.fn(async () => inspection());
  vi.spyOn(process.stderr, "write").mockReturnValue(true);

  const exitCode = await runSelectExtractionTargetCommand([
    "--variant", "s", "--offset", "0", "--limit", "100",
    "--extraction-cache-root", cacheRoot,
    "--cache-audit-receipt", "/audit.json",
    "--retired-source-rebuild-operator", "local-operator",
    "--target-selection-out", join(root, "target-selection.json")
  ], {
    inspect,
    readAudit: () => rebuildAuditReceipt(),
    readRevision: () => "a".repeat(40)
  });

  expect(exitCode).toBe(2);
  expect(inspect).not.toHaveBeenCalled();
  expect(existsSync(cacheRoot)).toBe(false);
});

it("rejects duplicate or partial continuation evidence before inspection", async () => {
  const root = mkdtempSync(join(tmpdir(), "alaya-target-selection-command-"));
  roots.push(root);
  const cacheRoot = join(root, "cache");
  const inspect = vi.fn(async () => inspection());
  vi.spyOn(process.stderr, "write").mockReturnValue(true);
  const base = [
    "--variant", "s", "--offset", "0", "--limit", "100",
    "--extraction-cache-root", cacheRoot,
    "--predecessor-target-selection", "/selection.json",
    "--extraction-predecessor-authority", "/parent.json",
    "--target-selection-out", join(root, "target-selection.json")
  ];

  for (const [flag, first, second] of [
    ["--predecessor-target-selection", "/selection.json", "/sibling-selection.json"],
    ["--extraction-predecessor-authority", "/parent.json", "/sibling.json"],
    ["--adopt-existing-child-target-selection", "/child-selection.json", "/other-selection.json"],
    ["--adopt-existing-child-authority", "/child.json", "/other-child.json"]
  ]) {
    expect(await runSelectExtractionTargetCommand([
      ...base, flag, first, flag, second
    ], { inspect })).toBe(2);
  }
  expect(await runSelectExtractionTargetCommand([
    ...base, "--adopt-existing-child-authority", "/child.json"
  ], { inspect })).toBe(2);
  expect(inspect).not.toHaveBeenCalled();
  expect(existsSync(cacheRoot)).toBe(false);
});

it("rejects an unrelated explicit adoption before any durable or runtime side effect", async () => {
  const root = mkdtempSync(join(tmpdir(), "alaya-target-selection-command-"));
  roots.push(root);
  const cacheRoot = join(root, "cache");
  const fixtures = unrelatedContinuationFixtures();
  const prepareExistingChild = vi.fn(() => preparedClaim());
  const claimExistingChild = vi.fn();
  const assertUnclaimed = vi.fn();
  const assertRootBinding = vi.fn();
  const inspect = vi.fn(async () => inspection());
  const write = vi.fn();
  const readRevision = vi.fn(() => "a".repeat(40));
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

  const exitCode = await runSelectExtractionTargetCommand(continuationArgs(cacheRoot, root), {
    readSelection: (path) => fixtures.selections[path]!,
    readAuthority: (path) => fixtures.authorities[path]!,
    prepareExistingChild,
    claimExistingChild,
    assertUnclaimed,
    assertRootBinding,
    inspect,
    write,
    readRevision
  });

  expect(exitCode).toBe(2);
  expect(stderr).toHaveBeenCalledWith(expect.stringMatching(/immediate parent/u));
  for (const effect of [
    prepareExistingChild, claimExistingChild, assertUnclaimed,
    assertRootBinding, inspect, write, readRevision
  ]) {
    expect(effect).not.toHaveBeenCalled();
  }
  expect(existsSync(cacheRoot)).toBe(false);
});

it("keeps a selected root when reporting fails after its receipt is durable", async () => {
  const root = mkdtempSync(join(tmpdir(), "alaya-target-selection-command-"));
  roots.push(root);
  const cacheRoot = join(root, "cache");
  const outputPath = join(root, "target-selection.json");
  vi.spyOn(process.stdout, "write").mockImplementation(() => {
    throw new Error("simulated stdout failure");
  });
  vi.spyOn(process.stderr, "write").mockReturnValue(true);

  const exitCode = await runSelectExtractionTargetCommand(commandArgs(cacheRoot, outputPath), {
    inspect: async () => inspection(),
    readAudit: () => rebuildAuditReceipt(),
    readRevision: () => "a".repeat(40)
  });

  expect(exitCode).toBe(2);
  expect(existsSync(cacheRoot)).toBe(true);
  expect(readExtractionTargetSelectionReceipt(outputPath).receipt_digest)
    .toMatch(/^[a-f0-9]{64}$/u);
});

it("removes the fresh root when writing its receipt fails", async () => {
  const root = mkdtempSync(join(tmpdir(), "alaya-target-selection-command-"));
  roots.push(root);
  const cacheRoot = join(root, "cache");
  vi.spyOn(process.stderr, "write").mockReturnValue(true);

  const exitCode = await runSelectExtractionTargetCommand(commandArgs(
    cacheRoot, join(root, "target-selection.json")
  ), {
    inspect: async () => inspection(),
    readAudit: () => rebuildAuditReceipt(),
    write: () => { throw new Error("simulated receipt write failure"); },
    readRevision: () => "a".repeat(40)
  });

  expect(exitCode).toBe(2);
  expect(existsSync(cacheRoot)).toBe(false);
});

it("refuses to place the target-selection receipt inside the selected cache root", async () => {
  const root = mkdtempSync(join(tmpdir(), "alaya-target-selection-command-"));
  roots.push(root);
  const cacheRoot = join(root, "cache");
  const inspect = vi.fn(async () => inspection());
  vi.spyOn(process.stderr, "write").mockReturnValue(true);

  const exitCode = await runSelectExtractionTargetCommand(commandArgs(
    cacheRoot, join(cacheRoot, "target-selection.json")
  ), {
    inspect,
    readAudit: () => rebuildAuditReceipt(),
    readRevision: () => "a".repeat(40)
  });

  expect(exitCode).toBe(2);
  expect(inspect).not.toHaveBeenCalled();
  expect(existsSync(cacheRoot)).toBe(false);
});

function commandArgs(cacheRoot: string, outputPath: string): string[] {
  return [
    "--variant", "s", "--offset", "0", "--limit", "100",
    "--extraction-cache-root", cacheRoot,
    "--cache-audit-receipt", "/audit.json",
    "--target-selection-out", outputPath
  ];
}

function continuationArgs(cacheRoot: string, root: string): string[] {
  return [
    "--variant", "s", "--offset", "0", "--limit", "100",
    "--extraction-cache-root", cacheRoot,
    "--predecessor-target-selection", "/actual-selection.json",
    "--extraction-predecessor-authority", "/actual-authority.json",
    "--adopt-existing-child-target-selection", "/explicit-selection.json",
    "--adopt-existing-child-authority", "/explicit-authority.json",
    "--target-selection-out", join(root, "target-selection.json")
  ];
}

function unrelatedContinuationFixtures() {
  const actualSelection = {
    receipt_digest: "1".repeat(64),
    selection_basis: {
      kind: "same_root_continuation",
      predecessor_target_selection_digest: "9".repeat(64),
      predecessor_authority_receipt_digest: "7".repeat(64)
    }
  } as unknown as ExtractionTargetSelectionReceipt;
  const explicitSelection = {
    receipt_digest: "6".repeat(64)
  } as ExtractionTargetSelectionReceipt;
  return {
    selections: {
      "/actual-selection.json": actualSelection,
      "/explicit-selection.json": explicitSelection
    } as Record<string, ExtractionTargetSelectionReceipt>,
    authorities: {
      "/actual-authority.json": fakeAuthority("2", "3", "1", "7", "8"),
      "/explicit-authority.json": fakeAuthority("4", "5", "6", "a", "b")
    } as Record<string, ExtractionAuthorityReceipt>
  };
}

function fakeAuthority(
  receipt: string,
  lineage: string,
  selection: string,
  predecessorReceipt: string,
  predecessorLineage: string
): ExtractionAuthorityReceipt {
  return {
    receipt_digest: receipt.repeat(64),
    lineage_digest: lineage.repeat(64),
    target_selection_digest: selection.repeat(64),
    continuation: {
      predecessor: {
        receipt_digest: predecessorReceipt.repeat(64),
        lineage_digest: predecessorLineage.repeat(64)
      }
    }
  } as unknown as ExtractionAuthorityReceipt;
}

function preparedClaim(): ExtractionContinuationChildClaim {
  return { claim_digest: "c".repeat(64) } as ExtractionContinuationChildClaim;
}

function inspection() {
  return {
    observation: {
      revision: "a".repeat(40),
      commandDigest: "b".repeat(64),
      selectionDigest: "c".repeat(64),
      keyDigest: "d".repeat(64),
      dataset: {
        variant: "longmemeval_s",
        revisionSha256: "e".repeat(64),
        windowOffset: 0,
        windowLimit: 100,
        expectedKeySetSha256: "d".repeat(64)
      },
      extraction: {
        model: "gpt-5.4-mini",
        modelFamily: "gpt-5.4-mini",
        requestProfile: "provider-default-v1" as const,
        providerUrl: "https://example.test/v1",
        systemPromptSha256: "f".repeat(64),
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
    },
    missingKeys: ["1".repeat(64)],
    ...emptyExtractionAuthorityShardStatus(),
    writerLock: "absent" as const,
    disk: { status: "available" as const, freeBytes: 10_000 },
    credentialStatus: "present" as const,
    modelReadiness: "not_probed" as const
  };
}

function rebuildAuditReceipt() {
  const finalIdentity = {
    datasetRevision: "e".repeat(64),
    model: "gpt-5.4-mini",
    modelFamily: "gpt-5.4-mini",
    requestProfile: "provider-default-v1",
    providerUrl: "https://example.test/v1",
    systemPromptSha256: "f".repeat(64),
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
