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
    initial_selection: { offset: 0, limit: 100 }
  });
  expect(stdout).toHaveBeenCalledWith(expect.stringContaining("Extraction target selection written"));
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
