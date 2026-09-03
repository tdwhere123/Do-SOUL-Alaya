import { chmodSync, closeSync, constants, existsSync, mkdirSync, openSync, renameSync, writeFileSync } from "node:fs";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

const rootBindingProbe = vi.hoisted(() => ({
  afterOpen: undefined as undefined | (() => void),
  beforeIdentityCheck: undefined as undefined | ((path: string) => void)
}));

vi.mock(
  "../../../runs/extraction/fill/manifest/root-directory-binding.js",
  async (importOriginal) => {
    const original = await importOriginal<typeof import(
      "../../../runs/extraction/fill/manifest/root-directory-binding.js"
    )>();
    return {
      ...original,
      openOrCreateCacheRoot(cacheRoot: string) {
        const bound = original.openOrCreateCacheRoot(cacheRoot);
        rootBindingProbe.afterOpen?.();
        return bound;
      },
      assertDirectoryIdentity(
        ...args: Parameters<typeof original.assertDirectoryIdentity>
      ) {
        rootBindingProbe.beforeIdentityCheck?.(args[0]);
        return original.assertDirectoryIdentity(...args);
      }
    };
  }
);

import {
  acquireExtractionCacheWriteLease
} from "../../../runs/extraction/fill/manifest/fill-root-guard.js";
import { readDirectoryIdentity, unlinkBoundChildDirectory } from
  "../../../runs/extraction/fill/manifest/root-directory-binding.js";

interface CapturedWriterOwner extends Record<string, unknown> {
  readonly process_start_identity: string;
}

const roots: string[] = [];

afterEach(async () => {
  rootBindingProbe.afterOpen = undefined;
  rootBindingProbe.beforeIdentityCheck = undefined;
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

it("rejects an ancestor-symlink alias before root acquisition", async () => {
  const parent = await fixtureRoot();
  const root = join(parent, "cache");
  const aliasParent = join(parent, "alias");
  await mkdir(root);
  await symlink(parent, aliasParent, "dir");
  expect(() => acquireExtractionCacheWriteLease(join(aliasParent, "cache")))
    .toThrow(/symlink|ENOTDIR|stable real directory/u);
  const lease = acquireExtractionCacheWriteLease(root);
  lease.assertOwned();
  lease.release();
});

it("reclaims current metadata only after its writer PID is confirmed dead", async () => {
  const root = await fixtureRoot();
  const lockPath = join(root, ".extraction-fill.lock");
  const stale = await captureCurrentOwner(root);
  await mkdir(lockPath);
  await writeFile(join(lockPath, "owner.json"), `${JSON.stringify({
    ...stale,
    pid: 2_147_483_647,
    process_start_identity: "1",
    token: "dead-owner"
  })}\n`);

  const lease = acquireExtractionCacheWriteLease(root);
  lease.assertOwned();
  expect(JSON.parse(await readFile(join(lockPath, "owner.json"), "utf8")))
    .toMatchObject({
      schema_version: 3,
      pid: process.pid,
      token: lease.generation
    });
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

it("reclaims legacy metadata only when its PID is confirmed dead", async () => {
  const root = await fixtureRoot();
  const lockPath = join(root, ".extraction-fill.lock");
  await mkdir(lockPath);
  await writeFile(join(lockPath, "owner.json"), JSON.stringify({
    schema_version: 2,
    pid: 2_147_483_647,
    token: "legacy-owner",
    started_at: "2026-08-16T00:00:00.000Z"
  }));

  const lease = acquireExtractionCacheWriteLease(root);
  lease.assertOwned();
  expect(JSON.parse(await readFile(join(lockPath, "owner.json"), "utf8")))
    .toMatchObject({ schema_version: 3, pid: process.pid });
  lease.release();
});

it("preserves live current metadata even without a matching kernel lease", async () => {
  const root = await fixtureRoot();
  const lockPath = join(root, ".extraction-fill.lock");
  const liveOwner = await captureCurrentOwner(root);
  const serialized = `${JSON.stringify(liveOwner)}\n`;
  await mkdir(lockPath);
  await writeFile(join(lockPath, "owner.json"), serialized);

  expect(() => acquireExtractionCacheWriteLease(root)).toThrow(/active writer/u);
  expect(await readFile(join(lockPath, "owner.json"), "utf8")).toBe(serialized);
});

it("preserves ownerless, unreadable, and unverifiable legacy metadata", async () => {
  const fixtures: readonly [string, string | undefined][] = [
    ["ownerless", undefined],
    ["unreadable", "{not-json\n"],
    ["invalid-current", `${JSON.stringify({ schema_version: 3, pid: process.pid })}\n`],
    ["unknown-legacy", `${JSON.stringify({ schema_version: 2, token: "unknown" })}\n`],
    ["live-legacy", `${JSON.stringify({ schema_version: 2, pid: process.pid })}\n`]
  ];
  for (const [name, owner] of fixtures) {
    const parent = await fixtureRoot();
    const root = join(parent, name);
    const lockPath = join(root, ".extraction-fill.lock");
    await mkdir(lockPath, { recursive: true });
    if (owner !== undefined) await writeFile(join(lockPath, "owner.json"), owner);

    expect(() => acquireExtractionCacheWriteLease(root))
      .toThrow(/unreadable|unverifiable|invalid|possibly live/u);
    expect(existsSync(lockPath)).toBe(true);
    if (owner !== undefined) {
      expect(await readFile(join(lockPath, "owner.json"), "utf8")).toBe(owner);
    }
  }
});

it("reclaims current metadata after a PID start-identity mismatch", async () => {
  const root = await fixtureRoot();
  const lockPath = join(root, ".extraction-fill.lock");
  const stale = await captureCurrentOwner(root);
  await mkdir(lockPath);
  await writeFile(join(lockPath, "owner.json"), `${JSON.stringify({
    ...stale,
    process_start_identity: stale.process_start_identity === "0" ? "1" : "0"
  })}\n`);

  const lease = acquireExtractionCacheWriteLease(root);
  lease.assertOwned();
  lease.release();
});

it("publishes through the held root when the prepared root name is replaced", async () => {
  const parent = await fixtureRoot();
  const root = join(parent, "cache");
  const heldRoot = join(parent, "held-cache");
  await mkdir(root);
  let heldLockObserved = false;
  let replacementLockObserved = false;
  rootBindingProbe.afterOpen = () => {
    rootBindingProbe.afterOpen = undefined;
    renameSync(root, heldRoot);
    mkdirSync(root);
  };
  rootBindingProbe.beforeIdentityCheck = (path) => {
    if (path !== root) return;
    rootBindingProbe.beforeIdentityCheck = undefined;
    heldLockObserved = existsSync(join(heldRoot, ".extraction-fill.lock"));
    replacementLockObserved = existsSync(join(root, ".extraction-fill.lock"));
  };

  expect(() => acquireExtractionCacheWriteLease(root)).toThrow(/final identity|identity changed/u);
  expect(heldLockObserved).toBe(true);
  expect(replacementLockObserved).toBe(false);
  expect(existsSync(join(heldRoot, ".extraction-fill.lock"))).toBe(false);
  expect(existsSync(join(root, ".extraction-fill.lock"))).toBe(false);
});

it("aggregates acquisition and held-root cleanup failures", async () => {
  const parent = await fixtureRoot();
  const root = join(parent, "cache");
  const heldRoot = join(parent, "held-cache");
  await mkdir(root);
  rootBindingProbe.afterOpen = () => {
    rootBindingProbe.afterOpen = undefined;
    renameSync(root, heldRoot);
    mkdirSync(root);
  };
  rootBindingProbe.beforeIdentityCheck = (path) => {
    if (path !== root) return;
    rootBindingProbe.beforeIdentityCheck = undefined;
    chmodSync(heldRoot, 0o500);
  };

  let thrown: unknown;
  try {
    acquireExtractionCacheWriteLease(root);
  } catch (cause) {
    thrown = cause;
  } finally {
    chmodSync(heldRoot, 0o700);
  }
  expect(thrown).toBeInstanceOf(AggregateError);
  expect((thrown as AggregateError).errors.map(String).join(" "))
    .toMatch(/final identity.*permission|final identity.*EPERM/iu);
  expect(existsSync(join(heldRoot, ".extraction-fill.lock"))).toBe(true);
  expect(existsSync(join(root, ".extraction-fill.lock"))).toBe(false);
});

it("releases the held inode without touching a replacement root", async () => {
  const parent = await fixtureRoot();
  const root = join(parent, "cache");
  const heldRoot = join(parent, "held-cache");
  await mkdir(root);
  const lease = acquireExtractionCacheWriteLease(root);
  await rename(root, heldRoot);
  await mkdir(root);

  expect(existsSync(join(heldRoot, ".extraction-fill.lock"))).toBe(true);
  expect(existsSync(join(root, ".extraction-fill.lock"))).toBe(false);
  expect(() => lease.release()).toThrow(/final identity|identity changed/u);
  expect(existsSync(join(heldRoot, ".extraction-fill.lock"))).toBe(false);
  expect(existsSync(join(root, ".extraction-fill.lock"))).toBe(false);

  const replacementLease = acquireExtractionCacheWriteLease(root);
  replacementLease.release();
});

it("fails closed when the lock directory inode is swapped before release", async () => {
  const root = await fixtureRoot();
  const lockPath = join(root, ".extraction-fill.lock");
  const displacedLockPath = join(root, ".extraction-fill.lock.displaced");
  const lease = acquireExtractionCacheWriteLease(root);
  await rename(lockPath, displacedLockPath);
  await mkdir(lockPath);
  await writeFile(join(lockPath, "owner.json"), "foreign-owner\n");

  expect(() => lease.release()).toThrow(/ownership|identity|verify/u);
  expect(await readFile(join(lockPath, "owner.json"), "utf8")).toBe("foreign-owner\n");
  expect(existsSync(displacedLockPath)).toBe(true);
});

it("captures the leased root inode and refuses a replacement tree at publish", async () => {
  const parent = await fixtureRoot();
  const root = join(parent, "cache");
  const heldRoot = join(parent, "held-cache");
  await mkdir(root);
  const lease = acquireExtractionCacheWriteLease(root);
  expect(lease.rootIdentity).toEqual(readDirectoryIdentity(root, "extraction cache root"));
  await rename(root, heldRoot);
  mkdirSync(root);
  expect(() => lease.assertOwned()).toThrow(/identity changed|descriptor identity|final identity/u);
  expect(() => lease.release()).toThrow(/final identity|identity changed/u);
});

it("does not unlink a lock directory swapped after the bound inode is verified", async () => {
  const root = await fixtureRoot();
  const lockPath = join(root, ".extraction-fill.lock");
  const displacedLockPath = join(root, ".extraction-fill.lock.displaced");
  mkdirSync(lockPath);
  writeFileSync(join(lockPath, "owner.json"), "ours\n");
  const parentFd = openSync(root, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    const identity = readDirectoryIdentity(lockPath, "extraction cache writer lock");
    expect(() => unlinkBoundChildDirectory({
      parentFd,
      childName: ".extraction-fill.lock",
      identity,
      tombstoneName: ".extraction-fill.lock.dead.test",
      assertOpened() {
        renameSync(lockPath, displacedLockPath);
        mkdirSync(lockPath);
        writeFileSync(join(lockPath, "owner.json"), "foreign-owner\n");
      }
    })).toThrow(/identity changed/u);
    expect(await readFile(join(lockPath, "owner.json"), "utf8")).toBe("foreign-owner\n");
    expect(existsSync(displacedLockPath)).toBe(true);
  } finally {
    closeSync(parentFd);
  }
});

async function captureCurrentOwner(root: string): Promise<CapturedWriterOwner> {
  const lockPath = join(root, ".extraction-fill.lock");
  const lease = acquireExtractionCacheWriteLease(root);
  const owner = JSON.parse(await readFile(join(lockPath, "owner.json"), "utf8")) as
    CapturedWriterOwner;
  lease.release();
  return owner;
}

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "extraction-fill-root-guard-"));
  roots.push(root);
  return root;
}
