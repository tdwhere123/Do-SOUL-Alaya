import { describe, expect, it } from "vitest";
import { collectPathCandidates } from "../tool-hot-path/tool-path-guards.js";

describe("tool path guards", () => {
  it("collects nested path-like candidates from objects and arrays", () => {
    expect(
      collectPathCandidates({
        targets: [{ targetPath: "src/index.ts" }, { directory: "docs" }],
        options: { cwd: "." },
        baseDir: "packages"
      })
    ).toEqual(["src/index.ts", "docs", ".", "packages"]);
  });

  it("ignores non-path-like scalar fields", () => {
    expect(
      collectPathCandidates({
        pattern: "**/*.ts",
        query: "needle",
        limit: 10
      })
    ).toEqual([]);
  });
});
