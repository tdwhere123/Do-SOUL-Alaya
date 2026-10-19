import { mkdtemp, open, readFile, rm, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { writeFile } from "../../mcp/tool-runtime/tool-runtime-file-write.js";

it.each([3, 0])("handles native writes limited to %i bytes without claiming a partial success", async (limit) => {
  const root = await mkdtemp(path.join(tmpdir(), "alaya-short-write-"));
  const target = path.join(root, "target.txt");
  const probe = await open(target, "w");
  const prototype = Object.getPrototypeOf(probe);
  const original = prototype.write;
  await probe.close();
  // Keep real file descriptors and native writes; shorten only the requested
  // write length to exercise the caller's handling of partial progress.
  prototype.write = function (this: FileHandle, buffer: Buffer, offset: number, length: number, position: number) {
    return original.call(this, buffer, offset, Math.min(length, limit), position);
  };
  try {
    const content = "short writes preserve UTF-8: 召回";
    const result = await writeFile({ path: target, content }, [root]);
    if (limit === 0) {
      expect(result).toMatchObject({ ok: false, code: "WRITE_ERROR" });
      expect(await readFile(target, "utf8")).toBe("");
    } else {
      expect(result).toEqual({ ok: true, bytesWritten: Buffer.byteLength(content) });
      expect(await readFile(target, "utf8")).toBe(content);
    }
  } finally {
    prototype.write = original;
    await rm(root, { recursive: true, force: true });
  }
});
