import {
  mkdtempSync, rmSync, symlinkSync, writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readExtractionAuthorityReceipt } from
  "../../../longmemeval/extraction/authority/receipt.js";
import { readExtractionTargetSelectionReceipt } from
  "../../../longmemeval/extraction/authority/target-selection/receipt.js";
import { readExtractionCacheAuditReceipt } from
  "../../../longmemeval/extraction/cache-audit/receipt.js";

const MAX_RECEIPT_BYTES = 64 * 1024;
const roots: string[] = [];
const readers = [
  ["extraction authority", readExtractionAuthorityReceipt],
  ["target selection", readExtractionTargetSelectionReceipt],
  ["cache audit", readExtractionCacheAuditReceipt]
] as const;

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("bounded extraction authority artifact readers", () => {
  it.each(readers)("rejects a symlinked %s before parsing", (_label, read) => {
    const root = mkdtempSync(join(tmpdir(), "alaya-authority-reader-"));
    roots.push(root);
    const outside = join(root, "outside.json");
    const linked = join(root, "receipt.json");
    writeFileSync(outside, "{}\n", "utf8");
    symlinkSync(outside, linked);

    expect(() => read(linked)).toThrow(/regular|symlink|open|bounded|unreadable/iu);
  });

  it.each(readers)("rejects an oversized %s before parsing", (_label, read) => {
    const root = mkdtempSync(join(tmpdir(), "alaya-authority-reader-"));
    roots.push(root);
    const path = join(root, "receipt.json");
    writeFileSync(path, "x".repeat(MAX_RECEIPT_BYTES + 1), "utf8");

    expect(() => read(path)).toThrow(/size limit|bounded|unreadable/iu);
  });
});
