import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach } from "vitest";
import { GIT_REGULAR_FILE_MODE } from "../../../bench/provenance/contract/untracked-worktree-frame.js";
import {
  independentDirtyWorktreeHash,
  specGitIdentityBytes,
  specHashDirtyState,
  specTrackedDiffArgs,
  specUint32Be
} from "./worktree-identity-independent-spec.js";

const execFileAsync = promisify(execFile);

export const KNOWN_EMPTY_FILE_N_FRAME_HEX =
  "616c6179612e62656e63682e776f726b747265652d756e747261636b65642e763200000000016e000081a4e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
export const LEFT_NUL_ALIAS_FRAME_HEX =
  "616c6179612e62656e63682e776f726b747265652d756e747261636b65642e7632000000000161000081a4e41b8c498134a75b2e21e964eb34dc6e1500e4b7f77c967aaa05765b30844a210000000163000081a4594e519ae499312b29433b7dd8a97ff068defcba9755b6d5d00e84c524d67b06";

export type FrozenCodeFixture = {
  readonly root: string;
  readonly head: string;
  readonly worktreeSha: string;
  readonly contractPath: string;
};

export type UntrackedFileBytes = {
  readonly relativePath: string;
  readonly bytes: Buffer;
};

export function createFrozenCodeFixtureHarness() {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true })
    ));
  });
  return {
    cleanRepository: () => cleanRepository(roots),
    identityRepository: () => identityRepository(roots)
  };
}

export { GIT_REGULAR_FILE_MODE, independentDirtyWorktreeHash, specUint32Be };

export async function trackedOnlyDirtyWorktreeHash(root: string): Promise<string> {
  const head = await specGitIdentityBytes(root, ["rev-parse", "HEAD"]);
  const porcelain = await specGitIdentityBytes(root, [
    "status", "--porcelain=v1", "-z", "--untracked-files=normal"
  ]);
  return specHashDirtyState({
    head,
    porcelain,
    trackedDiff: await specGitIdentityBytes(root, specTrackedDiffArgs()),
    untrackedFrame: Buffer.alloc(0)
  });
}

export async function hashWithKnownUntrackedFrame(
  root: string,
  frameHex: string
): Promise<string> {
  const head = await specGitIdentityBytes(root, ["rev-parse", "HEAD"]);
  const porcelain = await specGitIdentityBytes(root, [
    "status", "--porcelain=v1", "-z", "--untracked-files=normal"
  ]);
  return specHashDirtyState({
    head,
    porcelain,
    trackedDiff: await specGitIdentityBytes(root, specTrackedDiffArgs()),
    untrackedFrame: Buffer.from(frameHex, "hex")
  });
}

export function encodeLegacyNulUntrackedConcat(
  files: readonly UntrackedFileBytes[]
): Buffer {
  const chunks: Buffer[] = [];
  for (const file of [...files].sort((left, right) =>
    left.relativePath < right.relativePath ? -1 :
      left.relativePath > right.relativePath ? 1 : 0
  )) {
    chunks.push(
      Buffer.from(file.relativePath, "utf8"),
      Buffer.from([0]),
      file.bytes,
      Buffer.from([0])
    );
  }
  return Buffer.concat(chunks);
}

export async function writeUntrackedFiles(
  root: string,
  files: readonly UntrackedFileBytes[]
): Promise<void> {
  await Promise.all(files.map((file) => writeFile(join(root, file.relativePath), file.bytes)));
}

export async function git(root: string, ...args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", root, ...args]);
  return stdout;
}

export function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export async function writeContract(
  path: string,
  head: string,
  worktreeSha: string
): Promise<void> {
  await writeFile(path, `${JSON.stringify({
    schema_version: 1,
    code: {
      commit_sha: head,
      commit_sha7: head.slice(0, 7),
      worktree_state_sha256: worktreeSha
    }
  })}\n`, "utf8");
}

async function cleanRepository(roots: string[]): Promise<FrozenCodeFixture> {
  const root = await mkdtemp(join(tmpdir(), "frozen-code-contract-"));
  roots.push(root);
  await git(root, "init", "--quiet");
  await git(root, "config", "user.name", "Bench Test");
  await git(root, "config", "user.email", "bench@example.invalid");
  await writeFile(join(root, ".gitignore"), "contract.json\n", "utf8");
  await git(root, "add", ".gitignore");
  await git(root, "commit", "--quiet", "-m", "fixture");
  const head = (await git(root, "rev-parse", "HEAD")).trim();
  const worktreeSha = sha256(`${head}\n`);
  const contractPath = join(root, "contract.json");
  await writeContract(contractPath, head, worktreeSha);
  return { root, head, worktreeSha, contractPath };
}

async function identityRepository(roots: string[]): Promise<FrozenCodeFixture> {
  const fixture = await cleanRepository(roots);
  await writeFile(join(fixture.root, ".gitignore"), [
    "contract.json",
    ".do-it/",
    "node_modules/",
    "dist/",
    ".env"
  ].join("\n") + "\n", "utf8");
  await git(fixture.root, "add", ".gitignore");
  await git(fixture.root, "commit", "--quiet", "-m", "ignore generated");
  const head = (await git(fixture.root, "rev-parse", "HEAD")).trim();
  const worktreeSha = sha256(`${head}\n`);
  await writeContract(fixture.contractPath, head, worktreeSha);
  return { ...fixture, head, worktreeSha };
}
