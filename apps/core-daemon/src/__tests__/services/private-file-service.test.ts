import { mkdtemp, open, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { syncDirectory, writePrivateTextAtomic } from "../../services/support/private-file-service.js";

vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open) };
});

const platform = process.platform;
const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.mocked(open).mockClear();
  Object.defineProperty(process, "platform", { value: platform });
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function fixture(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "alaya-private-file-"));
  directories.push(directory);
  return directory;
}

describe("private file directory durability", () => {
  it.each([["win32", "EPERM", true], ["win32", "EIO", false], ["linux", "EPERM", false]] as const)(
    "handles directory flush %s / %s without swallowing other failures", async (host, code, tolerated) => {
      const directory = await fixture();
      const handle = await open(directory, "r");
      const error = Object.assign(new Error(`injected ${code}`), { code });
      vi.spyOn(handle, "sync").mockRejectedValue(error);
      const close = vi.spyOn(handle, "close");
      vi.mocked(open).mockResolvedValueOnce(handle);
      Object.defineProperty(process, "platform", { value: host });
      if (tolerated) await expect(syncDirectory(directory)).resolves.toBeUndefined();
      else await expect(syncDirectory(directory)).rejects.toBe(error);
      expect(close).toHaveBeenCalledOnce();
    }
  );

  it("does not tolerate a file flush permission failure on Windows", async () => {
    const directory = await fixture();
    const filename = path.join(directory, "config");
    const handle = await open(path.join(directory, "staging"), "wx", 0o600);
    const error = Object.assign(new Error("injected EPERM"), { code: "EPERM" });
    vi.spyOn(handle, "sync").mockRejectedValue(error);
    vi.mocked(open).mockResolvedValueOnce(handle);
    Object.defineProperty(process, "platform", { value: "win32" });
    await expect(writePrivateTextAtomic(filename, "secret", 0o600)).rejects.toBe(error);
    await expect(readFile(filename)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("atomically writes complete contents through the real filesystem", async () => {
    const directory = await fixture();
    const filename = path.join(directory, "config");
    await writePrivateTextAtomic(filename, "first", 0o600);
    await writePrivateTextAtomic(filename, "replacement", 0o600);
    expect(await readFile(filename, "utf8")).toBe("replacement");
  });
});
