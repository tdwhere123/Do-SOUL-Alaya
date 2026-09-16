import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeFile } from "../../mcp/tool-runtime/tool-runtime-file-write.js";

describe("writeFile private created mode", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0).reverse()) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("creates a new file without other-write even when umask is 0", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "tool-write-private-mode-"));
    dirs.push(workspace);
    const target = join(workspace, "created.txt");
    const posix = process.platform !== "win32";
    const previousUmask = posix ? process.umask(0) : 0;
    try {
      const result = (await writeFile(
        { path: target, content: "secret-payload" } as never,
        [workspace]
      )) as { readonly ok: boolean; readonly bytesWritten?: number };
      expect(result).toEqual({ ok: true, bytesWritten: Buffer.byteLength("secret-payload") });
      if (!posix) {
        // Windows maps a writable file to 0o666; other-write is a POSIX umask bit.
        return;
      }
      const mode = statSync(target).mode & 0o777;
      expect(mode & 0o002).toBe(0);
      expect(mode).toBe(0o600);
    } finally {
      if (posix) {
        process.umask(previousUmask);
      }
    }
  });
});
