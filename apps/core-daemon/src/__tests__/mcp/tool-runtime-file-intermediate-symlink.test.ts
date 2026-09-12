import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { readFile as fsReadFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readFile } from "../../mcp/tool-runtime/tool-runtime-file-read-search.js";
import { writeFile } from "../../mcp/tool-runtime/tool-runtime-file-write.js";

describe("openContained intermediate directory junction/symlink", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0).reverse()) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("denies read and write through an intermediate directory symlink", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "tool-intermediate-ws-"));
    const outside = mkdtempSync(join(tmpdir(), "tool-intermediate-out-"));
    dirs.push(workspace, outside);
    const secretPath = join(outside, "secret.txt");
    writeFileSync(secretPath, "outside-secret");
    const subDir = join(workspace, "sub");
    symlinkSync(outside, subDir, process.platform === "win32" ? "junction" : "dir");
    mkdirSync(join(workspace, "keep"), { recursive: true });

    const escapedPath = join(subDir, "secret.txt");
    const readResult = (await readFile({ path: escapedPath } as never, [workspace])) as {
      ok: boolean;
      code?: string;
    };
    expect(readResult.ok).toBe(false);
    expect(readResult.code).toBe("ACCESS_DENIED");

    const writeResult = (await writeFile(
      { path: escapedPath, content: "pwned" } as never,
      [workspace]
    )) as { ok: boolean; code?: string };
    expect(writeResult.ok).toBe(false);
    expect(writeResult.code).toBe("ACCESS_DENIED");
    await expect(fsReadFile(secretPath, "utf8")).resolves.toBe("outside-secret");
  });
});
