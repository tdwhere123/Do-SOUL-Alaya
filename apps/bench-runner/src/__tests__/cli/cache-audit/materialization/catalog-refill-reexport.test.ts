import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { runCli } from "../../../../cli/cli.js";
import { readExtractionCacheManifest } from
  "../../../../longmemeval/extraction/cache/extraction-cache-manifest.js";
import { computeExtractionKeySetSha256 } from
  "../../../../longmemeval/extraction/content-closure.js";
import { readSettledExtractionAttemptLedger } from
  "../../../../longmemeval/extraction/authority/attempt-ledger.js";
import {
  commandArgs, createCatalogRefillSuccessorFixture,
  type CatalogRefillSuccessorFixture
} from "./catalog-refill-successor-fixture.js";

let fixture: CatalogRefillSuccessorFixture | undefined;

afterEach(() => {
  fixture?.cleanup();
  fixture = undefined;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("catalog-refill successor materialization receipt re-export", () => {
  it("re-exports identical bytes from a real settled target-local successor", async () => {
    const stderr: string[] = [];
    vi.spyOn(process.stdout, "write").mockReturnValue(true);
    vi.spyOn(process.stderr, "write").mockImplementation((text) => {
      stderr.push(String(text));
      return true;
    });
    fixture = await createCatalogRefillSuccessorFixture();
    const originalReceipt = readFileSync(fixture.receiptPath);

    expectCompleteSuccessor(fixture);
    rmSync(fixture.receiptPath);
    rmSync(fixture.sourceRoot, { recursive: true });
    for (const name of ["audit-receipt.json", "raw-inventory.json", "source-manifest.json"]) {
      rmSync(join(fixture.auditOutput, name));
    }

    const code = await runCli(commandArgs(fixture));
    expect({ code, stderr: stderr.join("") }).toEqual({ code: 0, stderr: "" });
    expect(readFileSync(fixture.receiptPath)).toEqual(originalReceipt);
  }, 15_000);
});

function expectCompleteSuccessor(fixture: CatalogRefillSuccessorFixture): void {
  const manifest = readExtractionCacheManifest(fixture.targetRoot);
  expect(manifest).toMatchObject({
    schema_version: 3, fill_status: "complete",
    expected_turns: fixture.expectedKeys.length,
    cached_turns: fixture.expectedKeys.length
  });
  if (manifest === undefined || manifest.fill_status !== "complete") {
    throw new Error("expected a complete successor manifest");
  }
  expect(Object.keys(manifest.content_closure_index ?? {}).sort()).toEqual(fixture.expectedKeys);
  expect(manifest.expected_key_set_sha256).toBe(
    computeExtractionKeySetSha256(fixture.expectedKeys)
  );
  const ledger = readSettledExtractionAttemptLedger({
    cacheRoot: fixture.targetRoot,
    lineageDigest: fixture.authorityReceipt.lineage_digest,
    cacheIdentity: { model: "gpt-5.4-mini", requestProfile: "provider-default-v1" }
  });
  expect(ledger.successfulKeys).toEqual(fixture.remainingKeys);
  expect(ledger.pendingKeys).toEqual([]);
  expect(ledger.unresolvedAttempts).toEqual([]);
  expect(existsSync(join(fixture.targetRoot,
    `.catalog-refill-resume.${fixture.authorityReceipt.receipt_digest}.json`))).toBe(false);
}
