import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { readCurrentExtractionAuthorityRevision } from "../../../../runs/extraction/authority/inspection.js";

const checkout = vi.hoisted(() => ({ root: "" }));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFileSync: (file: string, args: readonly string[], options: object = {}) =>
      actual.execFileSync(file, args, { ...options, cwd: checkout.root })
  };
});

afterEach(() => {
  if (checkout.root) rmSync(checkout.root, { recursive: true, force: true });
  checkout.root = "";
});

it("binds every byte of a tracked patch larger than the default subprocess buffer", () => {
  checkout.root = mkdtempSync(join(tmpdir(), "extraction-authority-git-"));
  execFileSync("git", ["init", "--quiet"]);
  writeFileSync(join(checkout.root, "source.txt"), "original\n");
  execFileSync("git", ["add", "source.txt"]);
  execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
    "commit", "--quiet", "-m", "fixture"]);
  writeFileSync(join(checkout.root, "source.txt"), "changed UTF-8 内容\n".repeat(90_000));
  const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const patch = execFileSync("git", ["diff", "--no-ext-diff", "--binary", "HEAD", "--"],
    { maxBuffer: 8 * 1024 * 1024 });
  expect(patch.byteLength).toBeGreaterThan(1024 * 1024);
  const expected = createHash("sha256").update("git-worktree-v1\0").update(head)
    .update("\0").update(patch).digest("hex");
  const revision = readCurrentExtractionAuthorityRevision();
  expect(revision).toBe(`git-worktree-v1:${head}:${expected}`);
  writeFileSync(join(checkout.root, "source.txt"), "changed UTF-8 内容\n".repeat(90_000) + "tail\n");
  expect(readCurrentExtractionAuthorityRevision()).not.toBe(revision);
});

it("propagates Git failure instead of binding an empty patch", () => {
  checkout.root = mkdtempSync(join(tmpdir(), "extraction-authority-not-git-"));
  expect(() => readCurrentExtractionAuthorityRevision()).toThrow();
});
