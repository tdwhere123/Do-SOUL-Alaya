import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile as fsReadFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const openHook = vi.hoisted(() => ({
  beforeOpen: undefined as undefined | ((target: string) => Promise<void>)
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: vi.fn(async (target: string, ...rest: unknown[]) => {
      await openHook.beforeOpen?.(target);
      return await (actual.open as (p: string, ...r: unknown[]) => Promise<unknown>)(target, ...rest);
    }),
    readdir: vi.fn(async (target: string, ...rest: unknown[]) => {
      await openHook.beforeOpen?.(String(target));
      return await (actual.readdir as (p: string, ...r: unknown[]) => Promise<unknown>)(target, ...rest);
    })
  };
});

const { listDirectory, readFile, searchFiles } = await import(
  "../../mcp/tool-runtime/tool-runtime-file-read-search.js"
);

describe("read/list/search containment", () => {
  let realRoot: string;

  beforeEach(() => {
    realRoot = mkdtempSync(join(tmpdir(), "tool-read-root-"));
    openHook.beforeOpen = undefined;
  });

  afterEach(() => {
    openHook.beforeOpen = undefined;
    rmSync(realRoot, { recursive: true, force: true });
  });

  it("reads a regular file inside the writable root", async () => {
    const target = join(realRoot, "note.txt");
    writeFileSync(target, "hello", "utf8");
    await expect(readFile({ path: target }, [realRoot])).resolves.toEqual({
      ok: true,
      content: "hello",
      bytesRead: 5
    });
  });

  it("rejects a read when the path is swapped to a symlink before open", async () => {
    const outsideRoot = mkdtempSync(join(tmpdir(), "tool-read-outside-"));
    const subDir = join(realRoot, "sub");
    const target = join(subDir, "note.txt");
    const outsideTarget = join(outsideRoot, "note.txt");
    mkdirSync(subDir, { recursive: true });
    writeFileSync(target, "inside", "utf8");
    writeFileSync(outsideTarget, "secret-outside", "utf8");

    openHook.beforeOpen = async (openTarget) => {
      if (openTarget !== target) {
        return;
      }
      rmSync(subDir, { recursive: true, force: true });
      await import("node:fs/promises").then(({ symlink }) => symlink(outsideRoot, subDir, "dir"));
    };

    try {
      const result = (await readFile({ path: target }, [realRoot])) as {
        ok: boolean;
        code?: string;
        content?: string;
      };
      expect(result.ok).toBe(false);
      expect(result.code).toBe("ACCESS_DENIED");
      expect(result.content).toBeUndefined();
      await expect(fsReadFile(outsideTarget, "utf8")).resolves.toBe("secret-outside");
    } finally {
      rmSync(outsideRoot, { recursive: true, force: true });
    }
  });

  it("rejects listing a directory swapped to a symlink before open", async () => {
    const outsideRoot = mkdtempSync(join(tmpdir(), "tool-list-outside-"));
    const subDir = join(realRoot, "sub");
    mkdirSync(subDir, { recursive: true });
    writeFileSync(join(outsideRoot, "secret.txt"), "nope", "utf8");

    openHook.beforeOpen = async (openTarget) => {
      if (openTarget !== subDir) {
        return;
      }
      rmSync(subDir, { recursive: true, force: true });
      await import("node:fs/promises").then(({ symlink }) => symlink(outsideRoot, subDir, "dir"));
    };

    try {
      const result = (await listDirectory({ path: subDir }, [realRoot])) as {
        ok: boolean;
        code?: string;
      };
      expect(result.ok).toBe(false);
      expect(result.code).toBe("ACCESS_DENIED");
    } finally {
      rmSync(outsideRoot, { recursive: true, force: true });
    }
  });

  it("does not follow a symlink file during search", async () => {
    const outsideRoot = mkdtempSync(join(tmpdir(), "tool-search-outside-"));
    const outsideFile = join(outsideRoot, "secret.txt");
    writeFileSync(outsideFile, "secret-outside", "utf8");
    await import("node:fs/promises").then(({ symlink }) =>
      symlink(outsideFile, join(realRoot, "link.txt"))
    );

    writeFileSync(join(realRoot, "note.txt"), "hello", "utf8");
    try {
      const result = (await searchFiles(
        { pattern: "*", baseDir: realRoot },
        [realRoot]
      )) as { ok: boolean; paths?: readonly string[] };
      expect(result.ok).toBe(true);
      expect(result.paths ?? []).toContain("note.txt");
      expect(result.paths ?? []).not.toContain("link.txt");
    } finally {
      rmSync(outsideRoot, { recursive: true, force: true });
    }
  });
});
