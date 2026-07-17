import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  writeFileSync
} from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  inspectC0LockRelocation,
  preflightC0LockIsolation,
  relocateC0Lock,
  type C0LockFilesystem,
  type C0LockOwnerSummary
} from "../../longmemeval/extraction/c0-lock-isolation.js";

const LOCK_NAME = ".extraction-fill.lock";
const TOKEN = "must-not-appear-in-receipts";

interface LockFixture {
  readonly root: string;
  readonly sourceRoot: string;
  readonly targetRoot: string;
  readonly sourceLock: string;
}

let cleanupRoot = "";

afterEach(async () => {
  if (cleanupRoot !== "") await rm(cleanupRoot, { recursive: true, force: true });
  cleanupRoot = "";
});

describe("C0 lock isolation", () => {
  it("returns an unproven read-only preflight for an operator proof gate", async () => {
    const fixture = await createFixture();
    const ownerBefore = readFileSync(join(fixture.sourceLock, "owner.json"), "utf8");

    const preflight = preflightC0LockIsolation({
      sourceCacheRoot: fixture.sourceRoot,
      targetEvidenceRoot: fixture.targetRoot,
      filesystem: nodeFilesystem
    });

    expect(preflight.proof_status).toBe("unproven");
    expect(preflight.source_lock_path).toBe(join(realpathSync(fixture.sourceRoot), LOCK_NAME));
    expect(preflight.target_lock_path).toBe(join(realpathSync(fixture.targetRoot), LOCK_NAME));
    expect(preflight.same_device).toBe(true);
    expect(preflight.destination_clear).toBe(true);
    expect(preflight.prepared_journal_clear).toBe(true);
    expect(preflight.relocation_receipt_clear).toBe(true);
    expect(preflight.owner.token_present).toBe(true);
    expect(JSON.stringify(preflight)).not.toContain(TOKEN);
    expect(preflight.tree.entry_count).toBeGreaterThan(0);
    expect(readFileSync(join(fixture.sourceLock, "owner.json"), "utf8")).toBe(ownerBefore);
    expect(existsSync(join(fixture.targetRoot, LOCK_NAME))).toBe(false);
    expect(existsSync(join(fixture.targetRoot, ".c0-lock-isolation-prepared.json"))).toBe(false);
    expect(existsSync(join(fixture.targetRoot, ".c0-lock-isolation-receipt.json"))).toBe(false);
  });

  it("fails closed for an unproven legacy owner without touching the lock", async () => {
    const fixture = await createFixture();
    const ownerBefore = readFileSync(join(fixture.sourceLock, "owner.json"), "utf8");

    expect(() => relocateC0Lock(inputFor(fixture))).toThrow(/stopped-owner proof/iu);
    expect(existsSync(fixture.sourceLock)).toBe(true);
    expect(existsSync(join(fixture.targetRoot, LOCK_NAME))).toBe(false);
    expect(readFileSync(join(fixture.sourceLock, "owner.json"), "utf8")).toBe(ownerBefore);
    expect(existsSync(join(fixture.targetRoot, ".c0-lock-isolation-prepared.json"))).toBe(false);
  });

  it("rejects a symlinked lock before it can be inspected or moved", async () => {
    const fixture = await createFixture();
    const realLock = join(fixture.root, "real-lock");
    await rm(fixture.sourceLock, { recursive: true, force: true });
    await mkdir(realLock);
    await writeFile(join(realLock, "owner.json"), ownerJson(), "utf8");
    await symlink(realLock, fixture.sourceLock, "dir");

    expect(() => inspectC0LockRelocation(inputFor(fixture, stoppedProof))).toThrow(/symbolic link/iu);
    expect(lstatSync(fixture.sourceLock).isSymbolicLink()).toBe(true);
    expect(existsSync(join(fixture.targetRoot, LOCK_NAME))).toBe(false);
  });

  it("atomically relocates a proved stopped lock and preserves its tree hash", async () => {
    const fixture = await createFixture();
    const ownerBefore = readFileSync(join(fixture.sourceLock, "owner.json"), "utf8");

    const receipt = relocateC0Lock(inputFor(fixture, stoppedProof));
    const targetLock = join(fixture.targetRoot, LOCK_NAME);
    const journalBytes = readFileSync(
      join(fixture.targetRoot, ".c0-lock-isolation-prepared.json"),
      "utf8"
    );
    const receiptBytes = readFileSync(
      join(fixture.targetRoot, ".c0-lock-isolation-receipt.json"),
      "utf8"
    );

    expect(receipt.outcome).toBe("relocated");
    expect(receipt.pre_tree_sha256).toBe(receipt.post_tree_sha256);
    expect(receipt.owner.token_present).toBe(true);
    expect(JSON.stringify(receipt)).not.toContain(TOKEN);
    expect(journalBytes).not.toContain(TOKEN);
    expect(receiptBytes).not.toContain(TOKEN);
    expect(existsSync(fixture.sourceLock)).toBe(false);
    expect(readFileSync(join(targetLock, "owner.json"), "utf8")).toBe(ownerBefore);
    expect(readFileSync(join(targetLock, "nested", "payload.txt"), "utf8")).toBe("fixture payload\n");
  });
});

async function createFixture(): Promise<LockFixture> {
  const root = await mkdtemp(join(tmpdir(), "c0-lock-isolation-"));
  cleanupRoot = root;
  const sourceRoot = join(root, "source-cache");
  const targetRoot = join(root, "evidence-root");
  const sourceLock = join(sourceRoot, LOCK_NAME);
  await mkdir(join(sourceLock, "nested"), { recursive: true });
  await mkdir(targetRoot);
  await Promise.all([
    writeFile(join(sourceLock, "owner.json"), ownerJson(), "utf8"),
    writeFile(join(sourceLock, "nested", "payload.txt"), "fixture payload\n", "utf8")
  ]);
  return { root, sourceRoot, targetRoot, sourceLock };
}

function inputFor(
  fixture: LockFixture,
  proveStoppedOwner?: (owner: C0LockOwnerSummary) => ReturnType<typeof stoppedProof>
) {
  return {
    sourceCacheRoot: fixture.sourceRoot,
    targetEvidenceRoot: fixture.targetRoot,
    filesystem: nodeFilesystem,
    now: () => "2026-07-17T00:00:00.000Z",
    ...(proveStoppedOwner === undefined ? {} : { proveStoppedOwner })
  };
}

function stoppedProof(owner: C0LockOwnerSummary) {
  return {
    status: "stopped" as const,
    basis: "operator_attestation" as const,
    source_owner_sha256: owner.sha256,
    source_pid: owner.pid!,
    observed_at: "2026-07-17T00:00:00.000Z"
  };
}

function ownerJson(): string {
  return `${JSON.stringify({ pid: 23, started_at: "2026-07-16T00:00:00.000Z", token: TOKEN })}\n`;
}

const nodeFilesystem: C0LockFilesystem = {
  canonicalPath: (path) => realpathSync(path),
  lstat: (path) => nodeStat(path),
  lstatIfPresent: (path) => {
    try {
      return nodeStat(path);
    } catch (cause) {
      if (hasErrorCode(cause, "ENOENT")) return undefined;
      throw cause;
    }
  },
  readDirectory: (path) => readdirSync(path),
  readFile: (path) => readFileSync(path),
  writeNewFile: (path, contents) => writeFileSync(path, contents, { encoding: "utf8", flag: "wx" }),
  rename: (source, target) => renameSync(source, target)
};

function nodeStat(path: string) {
  const stat = lstatSync(path);
  return {
    kind: stat.isDirectory() ? "directory" : stat.isFile() ? "file" :
      stat.isSymbolicLink() ? "symlink" : "other",
    device: stat.dev,
    size: stat.size
  } as const;
}

function hasErrorCode(cause: unknown, code: string): boolean {
  return typeof cause === "object" && cause !== null && "code" in cause &&
    cause.code === code;
}
