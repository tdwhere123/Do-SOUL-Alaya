import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { publishExtractionCacheAuditBundle } from
  "../../../cli/cache-audit/bundle-writer.js";

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("extraction cache audit bundle writer", () => {
  it("removes staging output and leaves the final path absent when a write fails", () => {
    const root = mkdtempSync(join(tmpdir(), "alaya-cache-audit-bundle-"));
    roots.push(root);
    const output = join(root, "audit-output");
    const staging = `${output}.fixed.tmp`;
    let writes = 0;

    expect(() => publishExtractionCacheAuditBundle(output, [
      { name: "first.json", contents: "{}\n" },
      { name: "second.json", contents: "{}\n" }
    ], {
      randomId: () => "fixed",
      writeArtifact: (path, contents) => {
        writeFileSync(path, contents, { encoding: "utf8", flag: "wx" });
        writes += 1;
        if (writes === 1) throw new Error("injected bundle write failure");
      }
    })).toThrow(/injected bundle write failure/u);

    expect(existsSync(output)).toBe(false);
    expect(existsSync(staging)).toBe(false);
  });
});
