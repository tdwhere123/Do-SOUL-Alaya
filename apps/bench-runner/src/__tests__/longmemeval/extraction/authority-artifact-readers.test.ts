import {
  existsSync, mkdtempSync, rmSync, symlinkSync, truncateSync, writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readExtractionAuthorityReceipt } from
  "../../../runs/extraction/authority/receipt.js";
import {
  MAX_EXTRACTION_AUTHORITY_RECEIPT_BYTES,
  readExtractionAuthorityReceiptArtifact,
  writeExtractionAuthorityReceiptArtifact
} from "../../../runs/extraction/authority/receipt/artifact-io.js";
import { readExtractionTargetSelectionReceipt } from
  "../../../runs/extraction/authority/target-selection/receipt.js";
import { readExtractionCacheAuditReceipt } from
  "../../../runs/extraction/cache-audit/receipt.js";

const MAX_SMALL_RECEIPT_BYTES = 64 * 1024;
const roots: string[] = [];
const readers = [
  ["extraction authority", readExtractionAuthorityReceipt],
  ["target selection", readExtractionTargetSelectionReceipt],
  ["cache audit", readExtractionCacheAuditReceipt]
] as const;
const smallReceiptReaders = readers.slice(1);

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("bounded extraction authority artifact readers", () => {
  it("round-trips a catalog-sized authority artifact", () => {
    const root = mkdtempSync(join(tmpdir(), "alaya-authority-reader-"));
    roots.push(root);
    const path = join(root, "receipt.json");
    const receipt = { keys: Array.from({ length: 2_000 }, (_, index) => `${index}`.padStart(64, "0")) };

    writeExtractionAuthorityReceiptArtifact(path, receipt);

    expect(readExtractionAuthorityReceiptArtifact(path)).toEqual(receipt);
  });

  it("rejects an oversized authority artifact before publication", () => {
    const root = mkdtempSync(join(tmpdir(), "alaya-authority-reader-"));
    roots.push(root);
    const path = join(root, "receipt.json");

    expect(() => writeExtractionAuthorityReceiptArtifact(path, {
      payload: "x".repeat(MAX_EXTRACTION_AUTHORITY_RECEIPT_BYTES)
    })).toThrow(/size limit/iu);
    expect(existsSync(path)).toBe(false);
  });

  it.each(readers)("rejects a symlinked %s before parsing", (_label, read) => {
    const root = mkdtempSync(join(tmpdir(), "alaya-authority-reader-"));
    roots.push(root);
    const outside = join(root, "outside.json");
    const linked = join(root, "receipt.json");
    writeFileSync(outside, "{}\n", "utf8");
    symlinkSync(outside, linked);

    expect(() => read(linked)).toThrow(/regular|symlink|open|bounded|unreadable/iu);
  });

  it("rejects an oversized extraction authority before parsing", () => {
    const root = mkdtempSync(join(tmpdir(), "alaya-authority-reader-"));
    roots.push(root);
    const path = join(root, "receipt.json");
    writeFileSync(path, "", "utf8");
    truncateSync(path, MAX_EXTRACTION_AUTHORITY_RECEIPT_BYTES + 1);

    expect(() => readExtractionAuthorityReceipt(path)).toThrow(/size limit|bounded|unreadable/iu);
  });

  it.each(smallReceiptReaders)("rejects an oversized %s before parsing", (_label, read) => {
    const root = mkdtempSync(join(tmpdir(), "alaya-authority-reader-"));
    roots.push(root);
    const path = join(root, "receipt.json");
    writeFileSync(path, "", "utf8");
    truncateSync(path, MAX_SMALL_RECEIPT_BYTES + 1);

    expect(() => read(path)).toThrow(/size limit|bounded|unreadable/iu);
  });
});
