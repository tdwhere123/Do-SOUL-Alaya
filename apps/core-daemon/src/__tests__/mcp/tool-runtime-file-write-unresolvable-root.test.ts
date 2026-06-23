import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// invariant: an unresolvable writable root is DROPPED (never resolve()d back),
// so it cannot weaken the realpath symlink boundary. A write whose parent only
// matches via that dropped root must be denied; the drop warns.
// see also: apps/core-daemon/src/routes/workspace-git-binding.ts (drop pattern)

const realpathMock = vi.hoisted(() => ({
  // roots whose realpath() must throw (simulating an unresolvable root)
  unresolvable: new Set<string>()
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    realpath: vi.fn(async (target: string, ...rest: unknown[]) => {
      if (realpathMock.unresolvable.has(target)) {
        const error = new Error(`ENOENT: ${target}`) as NodeJS.ErrnoException;
        error.code = "ENOENT";
        throw error;
      }
      return await (actual.realpath as (p: string, ...r: unknown[]) => Promise<string>)(target, ...rest);
    })
  };
});

const { writeFile } = await import("../../mcp/tool-runtime-file-write-exec.js");

describe("writeFile with an unresolvable writable root", () => {
  let realRoot: string;

  beforeEach(() => {
    realRoot = mkdtempSync(join(tmpdir(), "tool-write-root-"));
    realpathMock.unresolvable.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    realpathMock.unresolvable.clear();
    rmSync(realRoot, { recursive: true, force: true });
  });

  it("writes successfully under a resolvable root", async () => {
    const target = join(realRoot, "note.txt");
    const result = (await writeFile({ path: target, content: "hi" } as never, [realRoot])) as {
      ok: boolean;
    };
    expect(result.ok).toBe(true);
    await expect(readFile(target, "utf8")).resolves.toBe("hi");
  });

  it("drops the unresolvable root, denies the write, and warns", async () => {
    // The target's parent (realRoot/sub) is a real, resolvable directory, but
    // the single writable root passed (realRoot) is marked unresolvable: its
    // realpath() throws, so it is dropped, the resolved-roots set is empty, and
    // the write is denied. (Parent ≠ root so parent realpath still succeeds.)
    realpathMock.unresolvable.add(realRoot);
    const emitWarning = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
    const subDir = join(realRoot, "sub");
    mkdirSync(subDir, { recursive: true });
    const target = join(subDir, "note.txt");

    const result = (await writeFile({ path: target, content: "x" } as never, [realRoot])) as {
      ok: boolean;
      code?: string;
    };

    expect(result.ok).toBe(false);
    expect(result.code).toBe("ACCESS_DENIED");
    expect(emitWarning).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ code: "ALAYA_WRITABLE_ROOT_UNRESOLVABLE" })
    );
  });
});
