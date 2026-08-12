import { readFileSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { verifyCommittedAuditedExtractionCacheSuccessor } from
  "../../../../../longmemeval/extraction/cache-audit/target-materializer.js";
import {
  catalogRefillCompletionPath, readCatalogRefillCompletionWitness
} from
  "../../../../../longmemeval/extraction/authority/catalog-refill/completion-witness.js";
import {
  createCatalogRefillSuccessorFixture,
  type CatalogRefillSuccessorFixture
} from "../catalog-refill-successor-fixture.js";

let fixture: CatalogRefillSuccessorFixture | undefined;

afterEach(() => {
  fixture?.cleanup();
  fixture = undefined;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("bounded canonical target-local authority readers", () => {
  it("rejects an oversized settled ledger at the bounded reader", async () => {
    quietCliOutput();
    fixture = await createCatalogRefillSuccessorFixture();
    truncateSync(ledgerPath(fixture), 32 * 1024 * 1024 + 1);

    expect(() => verifyCommittedAuditedExtractionCacheSuccessor({
      targetRoot: fixture!.targetRoot
    })).toThrow(/attempt ledger.*(?:exceeds|size limit)|size limit.*attempt ledger/iu);
  }, 15_000);

  it("rejects malformed bytes as non-canonical UTF-8 before JSON parsing", async () => {
    quietCliOutput();
    fixture = await createCatalogRefillSuccessorFixture();
    const path = catalogRefillCompletionPath(
      fixture.targetRoot, fixture.authorityReceipt.receipt_digest
    );
    const bytes = readFileSync(path);
    const whitespace = bytes.indexOf(0x20);
    if (whitespace < 0) throw new Error("expected completion witness whitespace");
    bytes[whitespace] = 0xff;
    writeFileSync(path, bytes);

    expect(() => readCatalogRefillCompletionWitness(path))
      .toThrow(/canonical UTF-8|invalid UTF-8/iu);
  }, 15_000);
});

function ledgerPath(value: CatalogRefillSuccessorFixture): string {
  return join(value.targetRoot,
    `extraction-attempt-ledger.${value.authorityReceipt.lineage_digest}.json`);
}

function quietCliOutput(): void {
  vi.spyOn(process.stdout, "write").mockReturnValue(true);
  vi.spyOn(process.stderr, "write").mockReturnValue(true);
}
