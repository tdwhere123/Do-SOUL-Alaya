import {
  existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { runAuthorizeExtractionCommand } from
  "../../../cli/extraction-authority/command.js";
import { openExtractionAttemptLedger, readExtractionAttemptLedger } from
  "../../../longmemeval/extraction/authority/attempt-ledger.js";
import { computeExtractionFillAttemptCeiling } from
  "../../../longmemeval/extraction/authority/receipt-limits.js";

const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

it("embeds an audited existing-root missing-key set bound to target selection", async () => {
  const cacheRoot = temporaryRoot();
  const allowlistPath = writeAllowlist(cacheRoot);
  const write = vi.fn();
  const inspect = vi.fn(async () => inspection());

  const exitCode = await runAuthorizeExtractionCommand(catalogArgs(cacheRoot, allowlistPath), {
    inspect,
    writeExclusive: write,
    readRevision: () => "a".repeat(40),
    readTargetSelection: () => ({
      receipt_digest: "9".repeat(64),
      created_at: "2026-08-12T00:00:00.000Z"
    } as never),
    assertTargetSelection: () => undefined,
    assertTargetSelectionWindow: () => undefined
  });

  expect(exitCode).toBe(0);
  expect(inspect).toHaveBeenCalledTimes(2);
  expect(write).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
    action: "fill",
    limits: expect.objectContaining({
      starting_missing: 1,
      maximum_attempts: computeExtractionFillAttemptCeiling(1),
      successful_shard_ceiling: 1
    }),
    catalog_refill: expect.objectContaining({
      shard_count: 1,
      keys: ["2".repeat(64)]
    }),
    target_selection_digest: "9".repeat(64)
  }));
  const receipt = write.mock.calls[0]?.[1];
  const ledger = readExtractionAttemptLedger({
    cacheRoot,
    lineageDigest: receipt.lineage_digest,
    cacheIdentity: {
      model: receipt.observation.extraction.model,
      requestProfile: receipt.observation.extraction.requestProfile
    }
  });
  expect(ledger).toMatchObject({
    startingMissing: 1,
    maximumAttempts: computeExtractionFillAttemptCeiling(1),
    successfulShardCeiling: 1,
    attempts: 0,
    successfulShards: 0,
    pendingKeys: [],
    unresolvedAttempts: []
  });
  expect(existsSync(join(cacheRoot, ".extraction-fill.lock"))).toBe(false);
});

it("rejects live catalog drift before creating its ledger or receipt", async () => {
  const cacheRoot = temporaryRoot();
  const allowlistPath = writeAllowlist(cacheRoot);
  const drifted = inspection();
  const inspect = vi.fn()
    .mockResolvedValueOnce(inspection())
    .mockResolvedValueOnce({ ...drifted, missingKeys: [] });
  const write = vi.fn();
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

  const exitCode = await runAuthorizeExtractionCommand(
    catalogArgs(cacheRoot, allowlistPath),
    {
      inspect,
      writeExclusive: write,
      readRevision: () => "a".repeat(40),
      readLedger: () => undefined,
      readTargetSelection: () => ({
        receipt_digest: "9".repeat(64),
        created_at: "2026-08-12T00:00:00.000Z"
      } as never),
      assertTargetSelection: () => undefined,
      assertTargetSelectionWindow: () => undefined
    }
  );

  expect(exitCode).toBe(2);
  expect(stderr).toHaveBeenCalledWith(expect.stringMatching(/cache drifted/u));
  expect(write).not.toHaveBeenCalled();
  expect(existsSync(join(cacheRoot, ".extraction-fill.lock"))).toBe(false);
  expect(existsSync(join(cacheRoot, `extraction-attempt-ledger.${"a".repeat(64)}.json`)))
    .toBe(false);
});

it("resumes an exact pristine issuance ledger after receipt publication fails", async () => {
  const cacheRoot = temporaryRoot();
  const allowlistPath = writeAllowlist(cacheRoot);
  const write = vi.fn()
    .mockImplementationOnce(() => { throw new Error("simulated receipt failure"); })
    .mockImplementationOnce(() => undefined);
  vi.spyOn(process.stderr, "write").mockReturnValue(true);
  vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const dependencies = {
    inspect: vi.fn(async () => inspection()),
    writeExclusive: write,
    readRevision: () => "a".repeat(40),
    readTargetSelection: () => ({
      receipt_digest: "9".repeat(64),
      created_at: "2026-08-12T00:00:00.000Z"
    } as never),
    assertTargetSelection: () => undefined,
    assertTargetSelectionWindow: () => undefined
  };

  expect(await runAuthorizeExtractionCommand(
    catalogArgs(cacheRoot, allowlistPath), dependencies
  )).toBe(2);
  const lineageDigest = write.mock.calls[0]?.[1].lineage_digest as string;
  const ledgerPath = join(cacheRoot, `extraction-attempt-ledger.${lineageDigest}.json`);
  expect(existsSync(ledgerPath)).toBe(true);
  const firstLedger = readExtractionAttemptLedger({
    cacheRoot,
    lineageDigest,
    cacheIdentity: { model: "gpt-5.4-mini", requestProfile: "provider-default-v1" }
  });

  expect(await runAuthorizeExtractionCommand(
    catalogArgs(cacheRoot, allowlistPath), dependencies
  )).toBe(0);
  expect(write.mock.calls[1]?.[1].receipt_digest)
    .toBe(write.mock.calls[0]?.[1].receipt_digest);
  expect(readExtractionAttemptLedger({
    cacheRoot,
    lineageDigest,
    cacheIdentity: { model: "gpt-5.4-mini", requestProfile: "provider-default-v1" }
  })?.rawLedgerSha256).toBe(firstLedger?.rawLedgerSha256);
  expect(existsSync(join(cacheRoot, ".extraction-fill.lock"))).toBe(false);
});

it("refuses to reissue catalog authority after an attempt starts", async () => {
  const cacheRoot = temporaryRoot();
  const allowlistPath = writeAllowlist(cacheRoot);
  const write = vi.fn();
  vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const dependencies = catalogDependencies();
  expect(await runAuthorizeExtractionCommand(
    catalogArgs(cacheRoot, allowlistPath), { ...dependencies, writeExclusive: write }
  )).toBe(0);
  const receipt = write.mock.calls[0]?.[1];
  openExtractionAttemptLedger({
    cacheRoot,
    lineageDigest: receipt.lineage_digest,
    cacheIdentity: {
      model: receipt.observation.extraction.model,
      requestProfile: receipt.observation.extraction.requestProfile
    },
    startingMissing: receipt.limits.starting_missing,
    maximumAttempts: receipt.limits.maximum_attempts,
    successfulShardCeiling: receipt.limits.successful_shard_ceiling
  }).reserveAttempt("2".repeat(64));
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

  expect(await runAuthorizeExtractionCommand(
    catalogArgs(cacheRoot, allowlistPath), { ...dependencies, writeExclusive: write }
  )).toBe(2);
  expect(stderr).toHaveBeenCalledWith(expect.stringMatching(/not exact and pristine/u));
  expect(write).toHaveBeenCalledOnce();
  expect(existsSync(join(cacheRoot, ".extraction-fill.lock"))).toBe(false);
});

it("preserves a conflicting authority output after pristine ledger issuance", async () => {
  const cacheRoot = temporaryRoot();
  const allowlistPath = writeAllowlist(cacheRoot);
  const outputPath = join(cacheRoot, "authority.json");
  writeFileSync(outputPath, "operator-owned\n", "utf8");
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

  expect(await runAuthorizeExtractionCommand(
    catalogArgs(cacheRoot, allowlistPath), catalogDependencies()
  )).toBe(2);
  expect(stderr).toHaveBeenCalledWith(expect.stringMatching(/EEXIST|published destination/u));
  expect(readFileSync(outputPath, "utf8")).toBe("operator-owned\n");
  const ledgers = readFileNames(cacheRoot).filter((name) =>
    name.startsWith("extraction-attempt-ledger.")
  );
  expect(ledgers).toHaveLength(1);
  expect(existsSync(join(cacheRoot, ".extraction-fill.lock"))).toBe(false);
});

it("reissues exact authority and pristine ledger bytes idempotently", async () => {
  const cacheRoot = temporaryRoot();
  const allowlistPath = writeAllowlist(cacheRoot);
  const outputPath = join(cacheRoot, "authority.json");
  vi.spyOn(process.stdout, "write").mockReturnValue(true);

  expect(await runAuthorizeExtractionCommand(
    catalogArgs(cacheRoot, allowlistPath), catalogDependencies()
  )).toBe(0);
  const authorityBytes = readFileSync(outputPath);
  const ledgerName = readFileNames(cacheRoot).find((name) =>
    name.startsWith("extraction-attempt-ledger.")
  )!;
  const ledgerBytes = readFileSync(join(cacheRoot, ledgerName));

  expect(await runAuthorizeExtractionCommand(
    catalogArgs(cacheRoot, allowlistPath), catalogDependencies()
  )).toBe(0);
  expect(readFileSync(outputPath)).toEqual(authorityBytes);
  expect(readFileSync(join(cacheRoot, ledgerName))).toEqual(ledgerBytes);
  expect(existsSync(join(cacheRoot, ".extraction-fill.lock"))).toBe(false);
});

function catalogDependencies() {
  return {
    inspect: vi.fn(async () => inspection()),
    readRevision: () => "a".repeat(40),
    readTargetSelection: () => ({
      receipt_digest: "9".repeat(64),
      created_at: "2026-08-12T00:00:00.000Z"
    } as never),
    assertTargetSelection: () => undefined,
    assertTargetSelectionWindow: () => undefined
  };
}

function writeAllowlist(cacheRoot: string): string {
  const path = join(cacheRoot, "allowlist.json");
  writeFileSync(path, JSON.stringify({
    kind: "test-catalog-refill",
    expected_turns: 2,
    cached_turns: 1,
    missing_turns: 1,
    expected_key_set_sha256: "d".repeat(64),
    cache_keys: ["2".repeat(64)]
  }), "utf8");
  return path;
}

function catalogArgs(cacheRoot: string, allowlistPath: string): string[] {
  return [
    "--variant", "s", "--offset", "0", "--limit", "100",
    "--extraction-cache-root", cacheRoot,
    "--catalog-refill-allowlist", allowlistPath,
    "--extraction-target-selection", join(cacheRoot, "target-selection.json"),
    "--extraction-action", "fill",
    "--extraction-receipt-out", join(cacheRoot, "authority.json"),
    "--extraction-output-token-cap", "512",
    "--extraction-output-token-field", "max_tokens",
    "--extraction-input-price-usd-per-million", "1",
    "--extraction-output-price-usd-per-million", "2",
    "--extraction-max-input-tokens", "300",
    "--extraction-disk-floor-bytes", "0"
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
        cacheKeyAlgorithm: "test",
        manifestSha256: "a".repeat(64),
        rawContentClosureSha256: "b".repeat(64)
      },
      inventory: {
        expectedTurns: 2,
        validTurns: 1,
        missingTurns: 1,
        invalidTurns: 0,
        orphanTurns: 0
      }
    },
    missingKeys: ["2".repeat(64)],
    invalidShards: [],
    preservedValidClosure: {
      shard_count: 1,
      key_set_sha256: "c".repeat(64),
      content_closure_sha256: "d".repeat(64)
    },
    writerLock: "absent" as const,
    disk: { status: "available" as const, freeBytes: 10_000 },
    credentialStatus: "present" as const,
    modelReadiness: "not_probed" as const
  };
}

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "alaya-catalog-refill-command-"));
  roots.push(root);
  return root;
}

function readFileNames(root: string): string[] {
  return readdirSync(root);
}
