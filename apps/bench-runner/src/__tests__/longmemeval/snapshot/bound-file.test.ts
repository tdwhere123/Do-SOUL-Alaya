import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  copyRegularFileNoFollow,
  readRegularFileNoFollow
} from "../../../longmemeval/snapshot/bound-file.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<{ root: string; source: string; sha256: string }> {
  const root = await mkdtemp(join(tmpdir(), "bound-file-"));
  roots.push(root);
  const source = join(root, "source.db");
  const content = Buffer.from("trusted snapshot bytes", "utf8");
  await writeFile(source, content);
  return {
    root,
    source,
    sha256: createHash("sha256").update(content).digest("hex")
  };
}

describe("descriptor-bound file IO", () => {
  it("copies and hashes the same opened source bytes", async () => {
    const input = await fixture();
    const target = join(input.root, "working", "alaya.db");
    copyRegularFileNoFollow({
      sourcePath: input.source,
      targetPath: target,
      expectedSha256: input.sha256
    });
    expect(await readFile(target)).toEqual(await readFile(input.source));
  });

  it("rejects symlinks for both buffered reads and DB copies", async () => {
    const input = await fixture();
    const link = join(input.root, "linked.db");
    await symlink(input.source, link);
    expect(() => readRegularFileNoFollow(link)).toThrow();
    expect(() => copyRegularFileNoFollow({
      sourcePath: link,
      targetPath: join(input.root, "working.db"),
      expectedSha256: input.sha256
    })).toThrow();
  });

  it("removes an untrusted working copy when the bound hash differs", async () => {
    const input = await fixture();
    const target = join(input.root, "working.db");
    expect(() => copyRegularFileNoFollow({
      sourcePath: input.source,
      targetPath: target,
      expectedSha256: "0".repeat(64)
    })).toThrow(/SHA-256 mismatch/u);
    await expect(readFile(target)).rejects.toThrow();
  });
});
