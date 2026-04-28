import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listDirectory } from "../tools/list-directory-tool.js";
import { readFile } from "../tools/read-file-tool.js";
import { searchFiles } from "../tools/search-files-tool.js";

const tempDirs = new Set<string>();
const originalCwd = process.cwd();

afterEach(async () => {
  process.chdir(originalCwd);
  await Promise.all(
    Array.from(tempDirs, async (dir) => {
      await rm(dir, { recursive: true, force: true });
    })
  );
  tempDirs.clear();
});

describe("file read tools", () => {
  it("reads a file within the workspace and reports bytes read", async () => {
    const workspaceDir = await createWorkspace();
    const filePath = path.join(workspaceDir, "notes.txt");
    await writeFile(filePath, "alpha", "utf8");

    await expect(readFile({ path: filePath }, [workspaceDir])).resolves.toEqual({
      ok: true,
      content: "alpha",
      bytesRead: 5
    });
  });

  it("returns SIZE_EXCEEDED when the file is larger than maxBytes", async () => {
    const workspaceDir = await createWorkspace();
    const filePath = path.join(workspaceDir, "large.txt");
    await writeFile(filePath, "0123456789", "utf8");

    await expect(readFile({ path: filePath, maxBytes: 4 }, [workspaceDir])).resolves.toMatchObject({
      ok: false,
      code: "SIZE_EXCEEDED"
    });
  });

  it("returns ACCESS_DENIED when readFile escapes writableRoots", async () => {
    const workspaceDir = await createWorkspace();
    const outsideDir = await createWorkspace();
    const filePath = path.join(outsideDir, "secret.txt");
    await writeFile(filePath, "secret", "utf8");

    await expect(readFile({ path: filePath }, [workspaceDir])).resolves.toMatchObject({
      ok: false,
      code: "ACCESS_DENIED"
    });
  });

  it("rejects null bytes in readFile paths before touching the filesystem", async () => {
    const workspaceDir = await createWorkspace();

    await expect(readFile({ path: `${workspaceDir}\0/notes.txt` }, [workspaceDir])).resolves.toMatchObject({
      ok: false,
      code: "READ_ERROR"
    });
  });

  it("rejects symlink targets in readFile with an explicit access denial", async () => {
    const workspaceDir = await createWorkspace();
    const targetPath = path.join(workspaceDir, "notes.txt");
    const linkPath = path.join(workspaceDir, "notes-link.txt");
    await writeFile(targetPath, "alpha", "utf8");
    await symlink(targetPath, linkPath);

    await expect(readFile({ path: linkPath }, [workspaceDir])).resolves.toMatchObject({
      ok: false,
      code: "ACCESS_DENIED",
      message: expect.stringContaining("symlink")
    });
  });

  it("returns NOT_FOUND when readFile targets a missing file", async () => {
    const workspaceDir = await createWorkspace();

    await expect(readFile({ path: path.join(workspaceDir, "missing.txt") }, [workspaceDir])).resolves.toMatchObject({
      ok: false,
      code: "NOT_FOUND"
    });
  });

  it("resolves relative readFile paths from the workspace root", async () => {
    const workspaceDir = await createWorkspace();
    await writeFile(path.join(workspaceDir, "notes.txt"), "alpha", "utf8");

    await expect(
      withOutsideCwd(async () => await readFile({ path: "notes.txt" }, [workspaceDir]))
    ).resolves.toEqual({
      ok: true,
      content: "alpha",
      bytesRead: 5
    });
  });

  it("lists directory entries in lexical order and distinguishes directories", async () => {
    const workspaceDir = await createWorkspace();
    await mkdir(path.join(workspaceDir, "b-dir"));
    await writeFile(path.join(workspaceDir, "a-file.txt"), "a", "utf8");
    await writeFile(path.join(workspaceDir, "c-file.txt"), "c", "utf8");

    await expect(listDirectory({ path: workspaceDir }, [workspaceDir])).resolves.toEqual({
      ok: true,
      entries: [
        { name: "a-file.txt", isDirectory: false },
        { name: "b-dir", isDirectory: true },
        { name: "c-file.txt", isDirectory: false }
      ]
    });
  });

  it("returns an empty list for an empty directory", async () => {
    const workspaceDir = await createWorkspace();

    await expect(listDirectory({ path: workspaceDir }, [workspaceDir])).resolves.toEqual({
      ok: true,
      entries: []
    });
  });

  it("returns ACCESS_DENIED when listDirectory escapes writableRoots", async () => {
    const workspaceDir = await createWorkspace();
    const outsideDir = await createWorkspace();

    await expect(listDirectory({ path: outsideDir }, [workspaceDir])).resolves.toMatchObject({
      ok: false,
      code: "ACCESS_DENIED"
    });
  });

  it("rejects symlink targets in listDirectory with an explicit access denial", async () => {
    const workspaceDir = await createWorkspace();
    const targetDir = path.join(workspaceDir, "actual-dir");
    const linkDir = path.join(workspaceDir, "dir-link");
    await mkdir(targetDir);
    await symlink(targetDir, linkDir);

    await expect(listDirectory({ path: linkDir }, [workspaceDir])).resolves.toMatchObject({
      ok: false,
      code: "ACCESS_DENIED",
      message: expect.stringContaining("symlink")
    });
  });

  it("resolves relative listDirectory paths from the workspace root", async () => {
    const workspaceDir = await createWorkspace();
    const nestedDir = path.join(workspaceDir, "nested");
    await mkdir(nestedDir);
    await writeFile(path.join(nestedDir, "entry.txt"), "alpha", "utf8");

    await expect(
      withOutsideCwd(async () => await listDirectory({ path: "nested" }, [workspaceDir]))
    ).resolves.toEqual({
      ok: true,
      entries: [{ name: "entry.txt", isDirectory: false }]
    });
  });

  it("searches files by glob pattern, sorts results, and truncates to maxResults", async () => {
    const workspaceDir = await createWorkspace();
    await mkdir(path.join(workspaceDir, "nested"));
    await writeFile(path.join(workspaceDir, "b.ts"), "export const b = 1;", "utf8");
    await writeFile(path.join(workspaceDir, "a.ts"), "export const a = 1;", "utf8");
    await writeFile(path.join(workspaceDir, "nested", "c.ts"), "export const c = 1;", "utf8");
    await writeFile(path.join(workspaceDir, "nested", "notes.md"), "# notes", "utf8");

    await expect(
      searchFiles({ baseDir: workspaceDir, pattern: "**/*.ts", maxResults: 2 }, [workspaceDir])
    ).resolves.toEqual({
      ok: true,
      paths: ["a.ts", "b.ts"]
    });
  });

  it("returns ACCESS_DENIED when searchFiles baseDir escapes writableRoots", async () => {
    const workspaceDir = await createWorkspace();
    const outsideDir = await createWorkspace();

    await expect(
      searchFiles({ baseDir: outsideDir, pattern: "**/*.ts" }, [workspaceDir])
    ).resolves.toMatchObject({
      ok: false,
      code: "ACCESS_DENIED"
    });
  });

  it("resolves relative searchFiles baseDir from the workspace root", async () => {
    const workspaceDir = await createWorkspace();
    await writeFile(path.join(workspaceDir, "root.ts"), "export const root = true;", "utf8");

    await expect(
      withOutsideCwd(async () => await searchFiles({ baseDir: ".", pattern: "**/*.ts" }, [workspaceDir]))
    ).resolves.toEqual({
      ok: true,
      paths: ["root.ts"]
    });
  });

  it("returns ACCESS_DENIED when searchFiles pattern escapes the workspace boundary", async () => {
    const workspaceDir = await createWorkspace();
    const outsideDir = await createWorkspace();
    await writeFile(path.join(outsideDir, "outside.ts"), "export const outside = true;", "utf8");
    const escapePattern = path.join(path.relative(workspaceDir, outsideDir), "*.ts");

    await expect(
      searchFiles({ baseDir: workspaceDir, pattern: escapePattern }, [workspaceDir])
    ).resolves.toMatchObject({
      ok: false,
      code: "ACCESS_DENIED"
    });
  });

  it("rejects searchFiles escape intent even when no outside matches exist", async () => {
    const workspaceDir = await createWorkspace();

    await expect(
      searchFiles({ baseDir: workspaceDir, pattern: "../missing/*.ts" }, [workspaceDir])
    ).resolves.toMatchObject({
      ok: false,
      code: "ACCESS_DENIED"
    });
  });

  it("rejects null bytes in searchFiles baseDir before touching the filesystem", async () => {
    const workspaceDir = await createWorkspace();

    await expect(
      searchFiles({ baseDir: `${workspaceDir}\0/subdir`, pattern: "**/*.ts" }, [workspaceDir])
    ).resolves.toMatchObject({
      ok: false,
      code: "READ_ERROR"
    });
  });

  it("rejects symlink base directories in searchFiles with an explicit access denial", async () => {
    const workspaceDir = await createWorkspace();
    const targetDir = path.join(workspaceDir, "src");
    const linkDir = path.join(workspaceDir, "src-link");
    await mkdir(targetDir);
    await writeFile(path.join(targetDir, "entry.ts"), "export const entry = true;", "utf8");
    await symlink(targetDir, linkDir);

    await expect(searchFiles({ baseDir: linkDir, pattern: "**/*.ts" }, [workspaceDir])).resolves.toMatchObject({
      ok: false,
      code: "ACCESS_DENIED",
      message: expect.stringContaining("symlink")
    });
  });

  it("allows parent traversal when the resolved matches stay within the workspace boundary", async () => {
    const workspaceDir = await createWorkspace();
    const srcDir = path.join(workspaceDir, "src");
    await mkdir(srcDir);
    await writeFile(path.join(workspaceDir, "root.ts"), "export const root = true;", "utf8");
    await writeFile(path.join(srcDir, "nested.ts"), "export const nested = true;", "utf8");

    await expect(searchFiles({ baseDir: srcDir, pattern: "../*.ts" }, [workspaceDir])).resolves.toEqual({
      ok: true,
      paths: ["../root.ts"]
    });
  });
});

async function createWorkspace(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "dw-a2-6-"));
  tempDirs.add(dir);
  return dir;
}

async function withOutsideCwd<T>(callback: () => Promise<T>): Promise<T> {
  const cwd = await createWorkspace();
  process.chdir(cwd);

  try {
    return await callback();
  } finally {
    process.chdir(originalCwd);
  }
}
