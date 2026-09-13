import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("protocol production leaf", () => {
  it("does not import node:crypto", () => {
    const srcRoot = fileURLToPath(new URL("../..", import.meta.url));
    const hits = listProductionTs(srcRoot).filter((file) =>
      fs.readFileSync(file, "utf8").includes('from "node:crypto"')
    );
    expect(hits).toEqual([]);
  });
});

function listProductionTs(dir: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__") continue;
      files.push(...listProductionTs(full));
      continue;
    }
    if (entry.name.endsWith(".ts")) files.push(full);
  }
  return files;
}
