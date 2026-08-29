import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  assertIsolatedShadowOffDest,
  createShadowOffWorktreePath,
  resolveMainCheckoutRoot,
  resolveShadowOffCopyRoot
} from "./neutrality-shadow-off-runner.js";

const RECALL_TEST_DIR = "packages/core/src/__tests__/recall";
const here = path.dirname(fileURLToPath(import.meta.url));

describe("neutrality-shadow-off-runner isolation", () => {
  it("refuses the live main checkout recall directory as copy dest", () => {
    const mainRoot = resolveMainCheckoutRoot(here);
    const fsRoot = path.parse(mainRoot).root;
    expect(mainRoot).not.toBe(fsRoot);
    expect(existsSync(path.join(mainRoot, ".git"))).toBe(true);
    const mainDest = path.join(mainRoot, RECALL_TEST_DIR);
    expect(() => assertIsolatedShadowOffDest(mainDest, mainRoot))
      .toThrow(/must not be inside/u);
    expect(() => resolveShadowOffCopyRoot(mainRoot, [mainRoot])).toThrow();
    expect(path.resolve(mainDest)).not.toBe(path.resolve(tmpdir()));
  });

  it("refuses dest inside filesystem root when that root is forbidden", () => {
    const fsRoot = path.parse(path.resolve(here)).root;
    const nested = path.join(fsRoot, "var", "tmp", "alaya-shadow-off-root-case");
    expect(() => assertIsolatedShadowOffDest(nested, fsRoot))
      .toThrow(/must not be inside/u);
  });

  it("refuses dest inside the current worktree recall directory", () => {
    const currentRoot = gitToplevel(here);
    expect(() => assertIsolatedShadowOffDest(here, currentRoot))
      .toThrow(/must not be inside/u);
  });

  it("resolves copy root under tmpdir, not the main recall path", () => {
    const mainRoot = resolveMainCheckoutRoot(here);
    const currentRoot = gitToplevel(here);
    const mainDest = path.join(mainRoot, RECALL_TEST_DIR);
    const worktreeRoot = createShadowOffWorktreePath();
    try {
      expectUnderTmpdir(worktreeRoot);
      expect(path.resolve(worktreeRoot)).not.toBe(path.resolve(mainRoot));
      expect(path.resolve(worktreeRoot)).not.toBe(path.resolve(currentRoot));
      const dest = resolveShadowOffCopyRoot(worktreeRoot, [
        mainRoot,
        currentRoot
      ]);
      expectUnderTmpdir(dest);
      expect(path.resolve(dest)).not.toBe(path.resolve(mainDest));
      expect(() => assertIsolatedShadowOffDest(dest, mainRoot)).not.toThrow();
      expect(() => assertIsolatedShadowOffDest(dest, currentRoot)).not.toThrow();
    } finally {
      rmSync(path.dirname(worktreeRoot), { recursive: true, force: true });
    }
  });

  it("throws when dest equals a forbidden root", () => {
    const forbidden = mkdtempSync(path.join(tmpdir(), "alaya-shadow-off-unit-"));
    try {
      expect(() => assertIsolatedShadowOffDest(forbidden, forbidden))
        .toThrow(/must not be inside/u);
      const nested = path.join(forbidden, RECALL_TEST_DIR);
      expect(() => assertIsolatedShadowOffDest(nested, forbidden))
        .toThrow(/must not be inside/u);
    } finally {
      rmSync(forbidden, { recursive: true, force: true });
    }
  });
});

function expectUnderTmpdir(target: string): void {
  const resolved = path.resolve(target);
  const tmp = path.resolve(tmpdir());
  expect(
    resolved === tmp || resolved.startsWith(`${tmp}${path.sep}`)
  ).toBe(true);
}

function gitToplevel(from: string): string {
  return execFileSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: from,
    encoding: "utf8"
  }).trim();
}
