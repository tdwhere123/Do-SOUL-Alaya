import { createHash } from "node:crypto";
import { lstatSync, renameSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  boundFileFullContentReadCount,
  copyRegularFileNoFollow,
  hashRegularFileNoFollow,
  readRegularFileNoFollow,
  seedRegularFileSha256,
  type OpenedFileIdentity
} from "../../../runs/snapshot/bound-file.js";

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

  it("hashes a sealed file once while inode identity holds", async () => {
    const input = await fixture();
    const before = boundFileFullContentReadCount();
    const first = hashRegularFileNoFollow(input.source);
    const second = hashRegularFileNoFollow(input.source);
    expect(second).toBe(first);
    expect(boundFileFullContentReadCount() - before).toBe(1);

    await writeFile(input.source, "mutated after digest");
    expect(hashRegularFileNoFollow(input.source)).not.toBe(first);
    expect(boundFileFullContentReadCount() - before).toBe(2);
  });

  it("refuses to register a digest against a replacement path", async () => {
    const input = await fixture();
    const original = `${input.source}.original`;
    const replacement = Buffer.from("replacement bytes", "utf8");

    expect(() => hashRegularFileNoFollow(input.source, {
      beforeCacheRegistration: () => {
        renameSync(input.source, original);
        writeFileSync(input.source, replacement);
      }
    })).toThrow(/changed before digest registration/u);
    expect(hashRegularFileNoFollow(input.source)).toBe(
      createHash("sha256").update(replacement).digest("hex")
    );
  });

  it("seeds a parent proof without hashing packed bytes", async () => {
    const input = await fixture();
    const before = boundFileFullContentReadCount();
    seedRegularFileSha256({
      filePath: input.source,
      expectedIdentity: openedIdentity(input.source),
      sha256: input.sha256
    });
    expect(hashRegularFileNoFollow(input.source)).toBe(input.sha256);
    expect(boundFileFullContentReadCount() - before).toBe(0);
  });

  it("fails closed when inode or size drift after the parent proof", async () => {
    const input = await fixture();
    const proof = {
      expectedIdentity: openedIdentity(input.source),
      sha256: input.sha256
    };
    const before = boundFileFullContentReadCount();

    const replaced = join(input.root, "replaced.db");
    await writeFile(replaced, "replacement inode");
    renameSync(input.source, `${input.source}.original`);
    renameSync(replaced, input.source);
    expect(() => seedRegularFileSha256({
      filePath: input.source,
      ...proof
    })).toThrow(/changed/u);
    expect(boundFileFullContentReadCount() - before).toBe(0);

    await writeFile(input.source, Buffer.concat([
      Buffer.from("trusted snapshot bytes", "utf8"),
      Buffer.from("!")
    ]));
    expect(() => seedRegularFileSha256({
      filePath: input.source,
      expectedIdentity: proof.expectedIdentity,
      sha256: input.sha256
    })).toThrow(/changed/u);
    expect(boundFileFullContentReadCount() - before).toBe(0);
  });

  it("hashes once when parent proof is absent", async () => {
    const input = await fixture();
    const before = boundFileFullContentReadCount();
    expect(hashRegularFileNoFollow(input.source)).toBe(input.sha256);
    expect(hashRegularFileNoFollow(input.source)).toBe(input.sha256);
    expect(boundFileFullContentReadCount() - before).toBe(1);
  });

  it("refuses copy cache registration when source or target paths drift", async () => {
    const sourceInput = await fixture();
    const sourceTarget = join(sourceInput.root, "source-drift.db");
    expect(() => copyRegularFileNoFollow({
      sourcePath: sourceInput.source,
      targetPath: sourceTarget,
      expectedSha256: sourceInput.sha256,
      beforeCacheRegistration: () => {
        renameSync(sourceInput.source, `${sourceInput.source}.original`);
        writeFileSync(sourceInput.source, "source replacement");
      }
    })).toThrow(/changed before digest registration/u);
    await expect(readFile(sourceTarget)).rejects.toThrow();

    const targetInput = await fixture();
    const target = join(targetInput.root, "target-drift.db");
    expect(() => copyRegularFileNoFollow({
      sourcePath: targetInput.source,
      targetPath: target,
      expectedSha256: targetInput.sha256,
      beforeCacheRegistration: () => {
        renameSync(target, `${target}.original`);
        writeFileSync(target, "target replacement");
      }
    })).toThrow(/changed before digest registration/u);
    await expect(readFile(target)).rejects.toThrow();
    expect(await readFile(`${target}.original`)).toEqual(await readFile(targetInput.source));
  });
});

function openedIdentity(filePath: string): OpenedFileIdentity {
  const metadata = lstatSync(filePath);
  return {
    dev: metadata.dev,
    ino: metadata.ino,
    ctimeMs: metadata.ctimeMs,
    size: metadata.size,
    mtimeMs: metadata.mtimeMs
  };
}
