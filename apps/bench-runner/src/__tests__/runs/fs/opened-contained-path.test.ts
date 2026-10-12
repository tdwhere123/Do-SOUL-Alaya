import { mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { boundedArtifactEntryExists } from "../../../runs/extraction/cache-audit/bounded-artifact-reader.js";
import { existingNonDirectoryAncestor, isContainedPath, isPhysicalNamedPath, samePhysicalLocation } from "../../../runs/fs/opened-contained-path.js";

describe("isContainedPath", () => {
  it("accepts a legal ..foo basename and rejects escape segments", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "contained-path-"));
    const nested = path.join(root, "sub");
    await mkdir(nested);
    await mkdir(path.join(nested, "dup"));
    await writeFile(path.join(root, "..foo"), "ok", "utf8");
    await writeFile(path.join(nested, "file"), "ok", "utf8");
    await writeFile(path.join(nested, "dup", "dup"), "ok", "utf8");

    expect(isContainedPath(root, path.join(root, "..foo"))).toBe(true);
    expect(isContainedPath(root, path.join(root, "..foo", "nested"))).toBe(true);
    expect(isContainedPath(root, path.join(root, ".."))).toBe(false);
    expect(isContainedPath(root, path.join(root, "../x"))).toBe(false);
    expect(isContainedPath(root, path.join(root, "../..."))).toBe(false);
    expect(isContainedPath(root, `${root}${path.sep}..${path.sep}x`)).toBe(false);
    expect(isContainedPath(root, "/tmp/outside")).toBe(false);
    expect(isContainedPath(root, `${root}/\0escape`)).toBe(false);
    expect(isContainedPath(root, path.join(root, "foo\\bar"))).toBe(
      process.platform === "win32"
    );
    expect(isContainedPath(root, path.join(nested, "file"))).toBe(true);
    expect(isContainedPath(root, path.join(nested, "dup", "dup"))).toBe(true);
    expect(isContainedPath(root, root)).toBe(false);

    const outside = await mkdtemp(path.join(tmpdir(), "contained-outside-"));
    await writeFile(path.join(outside, "leaked"), "no", "utf8");
    await symlink(outside, path.join(root, "link"));
    expect(isContainedPath(root, path.join(root, "link", "leaked"))).toBe(false);
    expect(isContainedPath(root, await realpath(path.join(root, "link", "leaked")))).toBe(false);
  });

  it("handles Windows-native absolute paths without treating separators as escapes", () => {
    const root = "C:\\work\\alaya";
    expect(isContainedPath(root, "C:\\work\\alaya\\src\\index.ts")).toBe(true);
    expect(isContainedPath(root, "C:\\work\\alaya\\..foo")).toBe(true);
    expect(isContainedPath(root, "C:\\work\\outside\\index.ts")).toBe(false);
    expect(isContainedPath(root, "D:\\work\\alaya\\src\\index.ts")).toBe(false);
  });

  it("accepts prefix-aliased directories and rejects symlink leaves", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "physical-named-"));
    expect(isPhysicalNamedPath(root)).toBe(true);
    const outside = await mkdtemp(path.join(tmpdir(), "physical-outside-"));
    const link = path.join(root, "link");
    await symlink(outside, link);
    expect(isPhysicalNamedPath(link)).toBe(false);
    expect(samePhysicalLocation(root, await realpath(root))).toBe(true);
  });
});

describe("existingNonDirectoryAncestor", () => {
  it("treats a file in the path as a blocked ancestor and a missing leaf as absence", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ancestor-file-"));
    const file = path.join(root, "ancestor");
    await writeFile(file, "retained");
    const blocked = path.join(file, "run", "cache");
    expect(existingNonDirectoryAncestor(blocked)).toBe(file);
    expect(() => boundedArtifactEntryExists(blocked)).toThrow(expect.objectContaining({ code: "ENOTDIR" }));
    const missing = path.join(root, "missing-leaf");
    expect(existingNonDirectoryAncestor(missing)).toBeUndefined();
    expect(boundedArtifactEntryExists(missing)).toBe(false);
    const dangling = path.join(root, "dangling");
    await symlink(path.join(root, "missing-target"), dangling);
    expect(existingNonDirectoryAncestor(path.join(dangling, "child"))).toBe(dangling);
  });
});
