import { createHash } from "node:crypto";
import { chmod, mkdir, rename, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { measureGitState } from "../../../runs/provenance/contract/frozen-code-contract.js";
import { readContainedWorktreeFile } from "../../../runs/provenance/contract/contained-worktree-file.js";
import {
  assertSafeUntrackedRelativePath,
  encodeUntrackedFrameUint32Be,
  encodeUntrackedWorktreeFrame,
  GIT_EXECUTABLE_FILE_MODE,
  GIT_REGULAR_FILE_MODE,
  hashUntrackedContent
} from "../../../runs/provenance/contract/untracked-worktree-frame.js";
import {
  buildRecordedRunCodeIdentity,
  resolveMeasuredRunGitState
} from "../../../runs/provenance/identity/run-code-identity.js";
import {
  composeBenchHistorySlug,
  dirtyWorktreeHistoryToken,
  recordedWorktreeIdentityForSlug
} from "../../../runs/provenance/identity/history-code-slug.js";
import {
  createFrozenCodeFixtureHarness,
  encodeLegacyNulUntrackedConcat,
  git,
  hashWithKnownUntrackedFrame,
  independentDirtyWorktreeHash,
  KNOWN_EMPTY_FILE_N_FRAME_HEX,
  LEFT_NUL_ALIAS_FRAME_HEX,
  sha256,
  specUint32Be,
  trackedOnlyDirtyWorktreeHash,
  writeUntrackedFiles
} from "./frozen-code-contract-fixture.js";
import { decodeUntrackedWorktreeFrame, decodeWorktreeStateFrame } from "./worktree-identity-decoder.js";

const { cleanRepository, identityRepository } = createFrozenCodeFixtureHarness();

const LEFT_NUL_ALIAS = [
  { relativePath: "a", bytes: Buffer.from("x\0c\0y") },
  { relativePath: "c", bytes: Buffer.from("z") }
] as const;
const RIGHT_NUL_ALIAS = [
  { relativePath: "a", bytes: Buffer.from("x") },
  { relativePath: "c", bytes: Buffer.from("y\0c\0z") }
] as const;

describe("frozen code worktree identity", () => {
  it("hashes a dirty worktree from HEAD, porcelain, and tracked diff", async () => {
    const fixture = await cleanRepository();
    const clean = await measureGitState(fixture.root, { allowDirty: true });
    expect(clean.worktreeClean).toBe(true);
    expect(clean.worktreeStateAlgorithm).toBe("sha256-head-lf");
    expect(clean.worktreeStateSha256).toBe(fixture.worktreeSha);

    await writeFile(join(fixture.root, ".gitignore"), "contract.json\ndirty\n", "utf8");
    const dirty = await measureGitState(fixture.root, { allowDirty: true });
    expect(dirty.worktreeClean).toBe(false);
    expect(dirty.worktreeStateAlgorithm).toBe("sha256-worktree-state-v3");
    expect(dirty.worktreeStateSha256).not.toBe(clean.worktreeStateSha256);
    expect(dirty.worktreeStateSha256).toBe(await trackedOnlyDirtyWorktreeHash(fixture.root));
    expect(dirty.worktreeStateSha256).toBe(await independentDirtyWorktreeHash(fixture.root));

    await writeFile(join(fixture.root, ".gitignore"), "contract.json\ndirtier\n", "utf8");
    const dirtier = await measureGitState(fixture.root, { allowDirty: true });
    expect(dirtier.worktreeStateSha256).not.toBe(dirty.worktreeStateSha256);

    await expect(measureGitState(fixture.root)).rejects.toThrow(/not clean/iu);
  });

  it("binds nonignored untracked source bytes into the dirty worktree hash", async () => {
    const fixture = await identityRepository();
    const planted = join(fixture.root, "src", "planted.ts");
    await mkdir(join(fixture.root, "src"));
    await writeFile(planted, "export const token = \"alpha\";\n", "utf8");
    const first = await measureGitState(fixture.root, { allowDirty: true });
    expect(first.worktreeClean).toBe(false);
    expect(first.worktreeStateSha256).toBe(await independentDirtyWorktreeHash(fixture.root));

    await writeFile(planted, "export const token = \"beta\";\n", "utf8");
    const changed = await measureGitState(fixture.root, { allowDirty: true });
    expect(changed.worktreeStateSha256).not.toBe(first.worktreeStateSha256);
    expect(changed.worktreeStateSha256).toBe(await independentDirtyWorktreeHash(fixture.root));

    const throughSeam = await resolveMeasuredRunGitState({
      frozen: null,
      checkoutRoot: fixture.root
    });
    expect(throughSeam.worktreeStateSha256).toBe(changed.worktreeStateSha256);
    const recordedOnly = await resolveMeasuredRunGitState({
      frozen: {
        commitSha: "c".repeat(40),
        commitSha7: "ccccccc",
        worktreeStateSha256: "dd".repeat(32),
        worktreeStateAlgorithm: "sha256-head-lf",
        worktreeClean: true,
        gateContractPath: "/tmp/gate.json",
        gateSha256: "ee".repeat(32)
      },
      checkoutRoot: fixture.root,
      recordedGitState: changed,
      measureGitState: async () => {
        throw new Error("second git measurement");
      }
    });
    expect(recordedOnly.worktreeStateSha256).toBe(changed.worktreeStateSha256);
    const recorded = buildRecordedRunCodeIdentity({
      commitSha7: throughSeam.commitSha7,
      executedDist: {
        algorithm: "sha256-reachable-path-file-sha256-v1",
        sha256: "2".repeat(64),
        file_count: 1
      },
      frozen: null,
      measured: throughSeam
    });
    expect(recorded.worktree_clean).toBe(false);
    expect(recorded.worktree_state_algorithm).toBe("sha256-worktree-state-v3");
    expect(JSON.stringify(recorded)).not.toContain("beta");
    expect(JSON.stringify(recorded)).not.toContain("alpha");
    expect(() => buildRecordedRunCodeIdentity({
      commitSha7: "deadbee",
      executedDist: recorded.executed_dist,
      frozen: null,
      measured: throughSeam
    })).toThrow(/commit.*measured HEAD/iu);
    expect(() => buildRecordedRunCodeIdentity({
      commitSha7: "ccccccc",
      executedDist: recorded.executed_dist,
      frozen: {
        commitSha: "c".repeat(40),
        commitSha7: "ccccccc",
        worktreeStateSha256: "dd".repeat(32),
        worktreeStateAlgorithm: "sha256-head-lf",
        worktreeClean: true,
        gateContractPath: "/tmp/gate.json",
        gateSha256: "ee".repeat(32)
      },
      measured: throughSeam
    })).toThrow(/frozen.*measured/iu);
  });

  it("hashes untracked files by sorted path, not write order", async () => {
    const fixture = await identityRepository();
    await writeFile(join(fixture.root, "z.ts"), "z-body\n", "utf8");
    await writeFile(join(fixture.root, "a.ts"), "a-body\n", "utf8");
    const first = await measureGitState(fixture.root, { allowDirty: true });

    await unlink(join(fixture.root, "z.ts"));
    await unlink(join(fixture.root, "a.ts"));
    await writeFile(join(fixture.root, "a.ts"), "a-body\n", "utf8");
    await writeFile(join(fixture.root, "z.ts"), "z-body\n", "utf8");
    const second = await measureGitState(fixture.root, { allowDirty: true });

    expect(second.worktreeStateSha256).toBe(first.worktreeStateSha256);
    expect(first.worktreeStateSha256).toBe(await independentDirtyWorktreeHash(fixture.root));
  });

  it("ignores generated, env, and .do-it bytes when hashing dirty worktrees", async () => {
    const fixture = await identityRepository();
    await writeFile(join(fixture.root, "src.ts"), "export const live = 1;\n", "utf8");
    const baseline = await measureGitState(fixture.root, { allowDirty: true });

    await mkdir(join(fixture.root, ".do-it", "bench-runs"), { recursive: true });
    await mkdir(join(fixture.root, "node_modules", "pkg"), { recursive: true });
    await mkdir(join(fixture.root, "dist"), { recursive: true });
    await writeFile(join(fixture.root, ".do-it", "secret.env"), "SECRET=planted-do-it-secret\n", "utf8");
    await writeFile(join(fixture.root, "node_modules", "pkg", "index.js"), "module.exports = 1;\n", "utf8");
    await writeFile(join(fixture.root, "dist", "out.js"), "export const generated = true;\n", "utf8");
    await writeFile(join(fixture.root, ".env"), "SECRET=planted-env-secret\n", "utf8");

    const withIgnored = await measureGitState(fixture.root, { allowDirty: true });
    expect(withIgnored.worktreeStateSha256).toBe(baseline.worktreeStateSha256);
    expect(JSON.stringify(withIgnored)).not.toContain("planted-do-it-secret");
    expect(JSON.stringify(withIgnored)).not.toContain("planted-env-secret");
  });

  it("excludes empty directories from dirty worktree identity", async () => {
    const fixture = await identityRepository();
    await writeFile(join(fixture.root, "kept.ts"), "kept\n", "utf8");
    const baseline = await measureGitState(fixture.root, { allowDirty: true });
    await mkdir(join(fixture.root, "empty-dir"));
    const withEmpty = await measureGitState(fixture.root, { allowDirty: true });
    expect(withEmpty.worktreeStateSha256).toBe(baseline.worktreeStateSha256);
  });

  it("changes the dirty hash when an untracked source file is deleted or renamed", async () => {
    const fixture = await identityRepository();
    const planted = join(fixture.root, "planted.ts");
    await writeFile(planted, "export const token = 1;\n", "utf8");
    const present = await measureGitState(fixture.root, { allowDirty: true });

    await unlink(planted);
    const deleted = await measureGitState(fixture.root, { allowDirty: true });
    expect(deleted.worktreeStateSha256).not.toBe(present.worktreeStateSha256);

    await writeFile(planted, "export const token = 1;\n", "utf8");
    const restored = await measureGitState(fixture.root, { allowDirty: true });
    expect(restored.worktreeStateSha256).toBe(present.worktreeStateSha256);

    await rename(planted, join(fixture.root, "renamed.ts"));
    const renamed = await measureGitState(fixture.root, { allowDirty: true });
    expect(renamed.worktreeStateSha256).not.toBe(present.worktreeStateSha256);
  });

  it("fails closed when an untracked provenance path is a symlink", async () => {
    const fixture = await identityRepository();
    await symlink("/tmp/outside-alaya-provenance", join(fixture.root, "escape.ts"));
    await expect(measureGitState(fixture.root, { allowDirty: true }))
      .rejects.toThrow(/regular non-symlink/iu);
  });

  it("fails closed on an intermediate directory symlink before reading bytes", async () => {
    const fixture = await identityRepository();
    const outside = join(tmpdir(), `alaya-wt-outside-${process.pid}`);
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, "planted.ts"), "export const leaked = 1;\n", "utf8");
    await symlink(outside, join(fixture.root, "src"));
    await expect(readContainedWorktreeFile(fixture.root, "src/planted.ts"))
      .rejects.toThrow(/regular non-symlink/iu);
  });

  it("keeps the clean worktree hash as sha256(HEAD newline)", async () => {
    const fixture = await identityRepository();
    const clean = await measureGitState(fixture.root, { allowDirty: true });
    expect(clean.worktreeClean).toBe(true);
    expect(clean.worktreeStateAlgorithm).toBe("sha256-head-lf");
    expect(clean.worktreeStateSha256).toBe(sha256(`${clean.commitSha}\n`));
    expect(clean.worktreeStateSha256).toBe(fixture.worktreeSha);
    expect(clean.worktreeStateSha256).toBe(await independentDirtyWorktreeHash(fixture.root));
  });

  it("separates same-path trees that alias under path-NUL-bytes-NUL", async () => {
    const fixture = await identityRepository();
    expect(encodeLegacyNulUntrackedConcat(LEFT_NUL_ALIAS).equals(
      encodeLegacyNulUntrackedConcat(RIGHT_NUL_ALIAS)
    )).toBe(true);

    await writeUntrackedFiles(fixture.root, LEFT_NUL_ALIAS);
    const left = await measureGitState(fixture.root, { allowDirty: true });
    const leftIndependent = await independentDirtyWorktreeHash(fixture.root);
    await writeUntrackedFiles(fixture.root, RIGHT_NUL_ALIAS);
    const right = await measureGitState(fixture.root, { allowDirty: true });

    expect(left.worktreeStateSha256).not.toBe(right.worktreeStateSha256);
    expect(left.worktreeStateSha256).toBe(leftIndependent);
    expect(right.worktreeStateSha256).toBe(await independentDirtyWorktreeHash(fixture.root));
    expect(JSON.stringify(left)).not.toMatch(/\u0000/u);
    expect(JSON.stringify(right)).not.toMatch(/\u0000/u);
  });

  it("binds an empty binary file and a NUL-only file to the known untracked frame", async () => {
    const fixture = await identityRepository();
    await writeFile(join(fixture.root, "n"), Buffer.alloc(0));
    const measured = await measureGitState(fixture.root, { allowDirty: true });
    expect(encodeUntrackedWorktreeFrame([{
      relativePath: "n",
      mode: GIT_REGULAR_FILE_MODE,
      contentSha256: hashUntrackedContent(Buffer.alloc(0))
    }]).toString("hex")).toBe(KNOWN_EMPTY_FILE_N_FRAME_HEX);
    expect(measured.worktreeStateSha256).toBe(await hashWithKnownUntrackedFrame(
      fixture.root,
      KNOWN_EMPTY_FILE_N_FRAME_HEX
    ));
    const decodedEmpty = decodeUntrackedWorktreeFrame(
      Buffer.from(KNOWN_EMPTY_FILE_N_FRAME_HEX, "hex")
    );
    expect(decodedEmpty.records).toEqual([
      { path: "n", mode: GIT_REGULAR_FILE_MODE, digestHex: sha256(Buffer.alloc(0)) }
    ]);

    await writeFile(join(fixture.root, "n"), Buffer.from([0x00]));
    const nulOnly = await measureGitState(fixture.root, { allowDirty: true });
    expect(nulOnly.worktreeStateSha256).not.toBe(measured.worktreeStateSha256);
    expect(nulOnly.worktreeStateSha256).toBe(await independentDirtyWorktreeHash(fixture.root));
  });

  it("changes identity when a tracked binary file byte changes", async () => {
    const fixture = await identityRepository();
    const binary = join(fixture.root, "blob.bin");
    await writeFile(binary, Buffer.from([0, 1, 2, 3, 0, 255]));
    await git(fixture.root, "add", "blob.bin");
    await git(fixture.root, "commit", "--quiet", "-m", "binary");
    const committed = await measureGitState(fixture.root, { allowDirty: true });
    expect(committed.worktreeClean).toBe(true);

    await writeFile(binary, Buffer.from([0, 1, 2, 4, 0, 255]));
    const first = await measureGitState(fixture.root, { allowDirty: true });
    expect(first.worktreeClean).toBe(false);
    expect(first.worktreeStateSha256).toBe(await independentDirtyWorktreeHash(fixture.root));
    await writeFile(binary, Buffer.from([0, 1, 2, 5, 0, 255]));
    const second = await measureGitState(fixture.root, { allowDirty: true });
    expect(first.worktreeStateSha256).not.toBe(second.worktreeStateSha256);
    expect(second.worktreeStateSha256).toBe(await independentDirtyWorktreeHash(fixture.root));
  });

  it("ignores a fixture-repo external diff driver", async () => {
    const fixture = await identityRepository();
    await writeFile(join(fixture.root, "tracked.txt"), "one\n", "utf8");
    await git(fixture.root, "add", "tracked.txt");
    await git(fixture.root, "commit", "--quiet", "-m", "text");
    await writeFile(join(fixture.root, "tracked.txt"), "two\n", "utf8");
    const without = await measureGitState(fixture.root, { allowDirty: true });
    const driver = join(tmpdir(), `alaya-ext-diff-${process.pid}.sh`);
    await writeFile(driver, "#!/bin/sh\nprintf 'MUTATED-EXTERNAL-DIFF\\n'\n");
    await git(fixture.root, "config", "diff.external", driver);
    const withDriver = await measureGitState(fixture.root, { allowDirty: true });
    expect(withDriver.worktreeStateSha256).toBe(without.worktreeStateSha256);
    expect(withDriver.worktreeStateSha256).toBe(await independentDirtyWorktreeHash(fixture.root));
  });

  it("binds executable mode separately from content", async () => {
    const fixture = await identityRepository();
    const planted = join(fixture.root, "tool.sh");
    await writeFile(planted, "#!/bin/sh\n");
    const regular = await measureGitState(fixture.root, { allowDirty: true });
    await chmod(planted, 0o755);
    const executable = await measureGitState(fixture.root, { allowDirty: true });
    expect(executable.worktreeStateSha256).not.toBe(regular.worktreeStateSha256);
    const decoded = decodeUntrackedWorktreeFrame(encodeUntrackedWorktreeFrame([{
      relativePath: "tool.sh",
      mode: GIT_EXECUTABLE_FILE_MODE,
      contentSha256: hashUntrackedContent(Buffer.from("#!/bin/sh\n"))
    }]));
    expect(decoded.records[0]?.mode).toBe(GIT_EXECUTABLE_FILE_MODE);
  });

  it("rejects overflow and unsafe untracked paths", () => {
    expect(() => encodeUntrackedFrameUint32Be(0x1_0000_0000)).toThrow(/overflows uint32be/iu);
    expect(() => encodeUntrackedFrameUint32Be(-1)).toThrow(/overflows uint32be/iu);
    expect(() => assertSafeUntrackedRelativePath("..", "/tmp/root")).toThrow(/normalized/iu);
    expect(() => assertSafeUntrackedRelativePath("/abs", "/tmp/root")).toThrow(/normalized/iu);
    expect(() => assertSafeUntrackedRelativePath("a\0b", "/tmp/root")).toThrow(/normalized/iu);
    expect(() => assertSafeUntrackedRelativePath("a\\b", "/tmp/root")).toThrow(/normalized/iu);
    expect(() => assertSafeUntrackedRelativePath("a//b", "/tmp/root")).toThrow(/normalized/iu);
    expect(() => assertSafeUntrackedRelativePath("foo/", "/tmp/root")).toThrow(/normalized/iu);
    expect(() => assertSafeUntrackedRelativePath("foo/./bar", "/tmp/root")).toThrow(/normalized/iu);
    expect(() => assertSafeUntrackedRelativePath("", "/tmp/root")).toThrow(/normalized/iu);
    expect(() => encodeUntrackedWorktreeFrame([
      { relativePath: "dup", mode: GIT_REGULAR_FILE_MODE, contentSha256: hashUntrackedContent(Buffer.alloc(0)) },
      { relativePath: "dup", mode: GIT_REGULAR_FILE_MODE, contentSha256: hashUntrackedContent(Buffer.from("x")) }
    ])).toThrow(/unique/iu);
  });

  it("decodes unique record boundaries on the known empty-file vector", () => {
    const frame = Buffer.from(KNOWN_EMPTY_FILE_N_FRAME_HEX, "hex");
    const decoded = decodeUntrackedWorktreeFrame(frame);
    expect(new Set(decoded.starts).size).toBe(decoded.starts.length);
    expect(decoded.starts).toEqual([UNTRACKED_TAG_LENGTH]);
    expect(LEFT_NUL_ALIAS_FRAME_HEX).toMatch(/^[0-9a-f]+$/u);
    const left = decodeUntrackedWorktreeFrame(Buffer.from(LEFT_NUL_ALIAS_FRAME_HEX, "hex"));
    expect(new Set(left.starts).size).toBe(left.starts.length);
    expect(left.starts.length).toBe(2);
  });

  it("decodes unique labeled boundaries on a planted dirty state frame", () => {
    const frame = Buffer.concat([
      Buffer.from("alaya.bench.worktree-state.v3\0", "utf8"),
      specLabeled("head", Buffer.from("abc\n")),
      specLabeled("porcelain", Buffer.from("?? a\n")),
      specLabeled("tracked-diff", Buffer.alloc(0)),
      specLabeled("untracked", Buffer.from(KNOWN_EMPTY_FILE_N_FRAME_HEX, "hex"))
    ]);
    const decoded = decodeWorktreeStateFrame(frame);
    expect(new Set(decoded.starts).size).toBe(decoded.starts.length);
    expect(decoded.records.map((record) => record.label)).toEqual([
      "head", "porcelain", "tracked-diff", "untracked"
    ]);
  });

  it("distinguishes dirty history slugs without colliding planted states", () => {
    const runAt = new Date("2026-08-20T05:00:00.000Z");
    const clean = composeBenchHistorySlug({
      runAt,
      commitSha7: "9e331fa",
      policyDiscriminator: "policy-stress",
      worktreeClean: true,
      worktreeStateSha256: "aa".repeat(32)
    });
    expect(clean).toBe("2026-08-20T050000Z-9e331fa-policy-stress");
    const first = composeBenchHistorySlug({
      runAt,
      commitSha7: "9e331fa",
      policyDiscriminator: "policy-stress",
      worktreeClean: false,
      worktreeStateSha256: "aa".repeat(32)
    });
    const second = composeBenchHistorySlug({
      runAt,
      commitSha7: "9e331fa",
      policyDiscriminator: "policy-stress",
      worktreeClean: false,
      worktreeStateSha256: "bb".repeat(32)
    });
    expect(first).toBe(
      `2026-08-20T050000Z-9e331fa-policy-stress-${dirtyWorktreeHistoryToken("aa".repeat(32))}`
    );
    expect(second).not.toBe(first);
    expect(second).toContain(`wt-${"bb".repeat(32)}`);
    expect(first).toContain(`wt-${"aa".repeat(32)}`);
  });

  it("refuses to mint a current dirty slug from missing worktree_clean", () => {
    expect(() => dirtyWorktreeHistoryToken("aa".repeat(6))).toThrow(/sha256 hex digest/iu);
    expect(() => recordedWorktreeIdentityForSlug(undefined)).toThrow(/recorded worktree state digest/iu);
    expect(() => recordedWorktreeIdentityForSlug({
      worktree_state_sha256: "aa".repeat(32)
    })).toThrow(/archive-only/iu);
  });
});

const UNTRACKED_TAG_LENGTH = Buffer.from("alaya.bench.worktree-untracked.v2\0").length;

function specLabeled(label: string, payload: Buffer): Buffer {
  const labelBytes = Buffer.from(label, "utf8");
  return Buffer.concat([
    specUint32Be(labelBytes.length),
    labelBytes,
    specUint32Be(payload.length),
    payload
  ]);
}
