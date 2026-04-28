import { mkdtemp, mkdir, readFile as fsReadFile, rm, symlink, writeFile as fsWriteFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WRITE_FILE_TOOL_SPEC, writeFile } from "../tools/write-file-tool.js";

const tempDirs = new Set<string>();

afterEach(async () => {
  await Promise.all(
    Array.from(tempDirs, async (dir) => {
      await rm(dir, { recursive: true, force: true });
    })
  );
  tempDirs.clear();
});

describe("writeFile", () => {
  it("exports a non-fast-path write tool spec", () => {
    expect(WRITE_FILE_TOOL_SPEC).toMatchObject({
      tool_id: "tools.write_file",
      category: "write",
      read_only: false,
      destructive: false,
      fast_path_eligible: false,
      rollback_support: "best_effort"
    });
  });

  it("writes a new file and reports bytes written", async () => {
    const workspaceDir = await createWorkspace();
    const filePath = path.join(workspaceDir, "notes.txt");

    await expect(writeFile({ path: filePath, content: "hello" }, [workspaceDir])).resolves.toEqual({
      ok: true,
      bytesWritten: 5
    });
    await expect(fsReadFile(filePath, "utf8")).resolves.toBe("hello");
  });

  it("overwrites an existing file", async () => {
    const workspaceDir = await createWorkspace();
    const filePath = path.join(workspaceDir, "notes.txt");
    await fsWriteFile(filePath, "before", "utf8");

    await expect(writeFile({ path: filePath, content: "after" }, [workspaceDir])).resolves.toEqual({
      ok: true,
      bytesWritten: 5
    });
    await expect(fsReadFile(filePath, "utf8")).resolves.toBe("after");
  });

  it("reports utf-8 byte length for unicode content", async () => {
    const workspaceDir = await createWorkspace();
    const filePath = path.join(workspaceDir, "unicode.txt");
    const content = "你好，世界";

    await expect(writeFile({ path: filePath, content }, [workspaceDir])).resolves.toEqual({
      ok: true,
      bytesWritten: Buffer.byteLength(content, "utf8")
    });
  });

  it("allows empty content writes", async () => {
    const workspaceDir = await createWorkspace();
    const filePath = path.join(workspaceDir, "empty.txt");

    await expect(writeFile({ path: filePath, content: "" }, [workspaceDir])).resolves.toEqual({
      ok: true,
      bytesWritten: 0
    });
    await expect(fsReadFile(filePath, "utf8")).resolves.toBe("");
  });

  it("returns ACCESS_DENIED when the target escapes writableRoots", async () => {
    const workspaceDir = await createWorkspace();
    const outsideDir = await createWorkspace();
    const filePath = path.join(outsideDir, "notes.txt");

    await expect(writeFile({ path: filePath, content: "secret" }, [workspaceDir])).resolves.toMatchObject({
      ok: false,
      code: "ACCESS_DENIED"
    });
  });

  it("rejects symlink targets", async () => {
    const workspaceDir = await createWorkspace();
    const targetPath = path.join(workspaceDir, "target.txt");
    const linkPath = path.join(workspaceDir, "target-link.txt");
    await fsWriteFile(targetPath, "before", "utf8");
    await symlink(targetPath, linkPath);

    await expect(writeFile({ path: linkPath, content: "after" }, [workspaceDir])).resolves.toMatchObject({
      ok: false,
      code: "ACCESS_DENIED",
      message: expect.stringContaining("symlink")
    });
  });

  it("rejects writes through a symlinked parent directory", async () => {
    const workspaceDir = await createWorkspace();
    const outsideDir = await createWorkspace();
    const linkDir = path.join(workspaceDir, "linked-outside");
    const escapedPath = path.join(linkDir, "notes.txt");
    await symlink(outsideDir, linkDir);

    await expect(writeFile({ path: escapedPath, content: "hello" }, [workspaceDir])).resolves.toMatchObject({
      ok: false,
      code: "ACCESS_DENIED"
    });
    await expect(fsReadFile(path.join(outsideDir, "notes.txt"), "utf8")).rejects.toMatchObject({
      code: "ENOENT"
    });
  });

  it("returns NOT_FOUND when the parent directory does not exist", async () => {
    const workspaceDir = await createWorkspace();
    const filePath = path.join(workspaceDir, "missing", "notes.txt");

    await expect(writeFile({ path: filePath, content: "hello" }, [workspaceDir])).resolves.toMatchObject({
      ok: false,
      code: "NOT_FOUND"
    });
  });

  it("rejects null bytes in the path before touching the filesystem", async () => {
    const workspaceDir = await createWorkspace();

    await expect(writeFile({ path: `${workspaceDir}\0/notes.txt`, content: "hello" }, [workspaceDir])).resolves.toMatchObject({
      ok: false,
      code: "READ_ERROR"
    });
  });

  it("returns WRITE_ERROR when the target is a directory", async () => {
    const workspaceDir = await createWorkspace();
    const dirPath = path.join(workspaceDir, "nested");
    await mkdir(dirPath);

    await expect(writeFile({ path: dirPath, content: "hello" }, [workspaceDir])).resolves.toMatchObject({
      ok: false,
      code: "WRITE_ERROR"
    });
  });
});

async function createWorkspace(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "dw-a2-7-write-"));
  tempDirs.add(dir);
  return dir;
}
