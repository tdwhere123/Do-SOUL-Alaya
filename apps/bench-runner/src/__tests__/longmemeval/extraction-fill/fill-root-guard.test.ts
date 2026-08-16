import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  acquireExtractionCacheWriteLease
} from "../../../longmemeval/extraction/fill/manifest/fill-root-guard.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it("excludes a concurrent writer and releases ownership for the next writer", async () => {
  const root = await fixtureRoot();
  const first = acquireExtractionCacheWriteLease(root);

  expect(() => acquireExtractionCacheWriteLease(root)).toThrow(/already has an active writer/u);

  first.release();
  const second = acquireExtractionCacheWriteLease(root);
  second.assertOwned();
  second.release();
});

it("treats ancestor-symlink aliases as the same physical cache root", async () => {
  const parent = await fixtureRoot();
  const root = join(parent, "cache");
  const aliasParent = join(parent, "alias");
  await mkdir(root);
  await symlink(parent, aliasParent, "dir");
  const first = acquireExtractionCacheWriteLease(root);

  expect(() => acquireExtractionCacheWriteLease(join(aliasParent, "cache")))
    .toThrow(/already has an active writer/u);

  first.assertOwned();
  first.release();
});

it("reclaims metadata left by a dead kernel-backed writer", async () => {
  const root = await fixtureRoot();
  const lockPath = join(root, ".extraction-fill.lock");
  await mkdir(lockPath);
  await writeFile(join(lockPath, "owner.json"), JSON.stringify({
    schema_version: 2,
    token: "dead-owner",
    started_at: "2026-08-16T00:00:00.000Z"
  }));

  const lease = acquireExtractionCacheWriteLease(root);
  lease.assertOwned();
  expect(JSON.parse(await readFile(join(lockPath, "owner.json"), "utf8")))
    .toMatchObject({ schema_version: 2 });
  lease.release();
});

it("releases the descriptor and kernel lease when metadata removal fails", async () => {
  const root = await fixtureRoot();
  const lockPath = join(root, ".extraction-fill.lock");
  const lease = acquireExtractionCacheWriteLease(root);
  await chmod(root, 0o500);
  try {
    expect(() => lease.release()).toThrow(/permission|cleanup/iu);
    await expect(access(lease.stableRootPath)).rejects.toThrow();
  } finally {
    await chmod(root, 0o700);
  }

  await rm(lockPath, { recursive: true });
  const next = acquireExtractionCacheWriteLease(root);
  next.assertOwned();
  next.release();
});

it("fails closed for a legacy lock whose writer identity cannot be proven dead", async () => {
  const root = await fixtureRoot();
  const lockPath = join(root, ".extraction-fill.lock");
  await mkdir(lockPath);
  await writeFile(join(lockPath, "owner.json"), JSON.stringify({
    pid: 123,
    token: "legacy-owner",
    started_at: "2026-08-16T00:00:00.000Z"
  }));

  expect(() => acquireExtractionCacheWriteLease(root)).toThrow(/legacy writer lock/u);
});

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "extraction-fill-root-guard-"));
  roots.push(root);
  return root;
}
