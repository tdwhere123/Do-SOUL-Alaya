import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { devNull } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const EMPTY_SOURCE = process.platform === "win32" ? "NUL" : devNull;
const SPEC_GIT_CONFIG = [
  "-c", "core.quotepath=false",
  "-c", "core.abbrev=40",
  "-c", `core.excludesFile=${EMPTY_SOURCE}`,
  "-c", `core.attributesFile=${EMPTY_SOURCE}`,
  "-c", "diff.mnemonicPrefix=false",
  "-c", "diff.noprefix=false",
  "-c", "diff.indentHeuristic=false",
  "-c", "diff.renames=false",
  "-c", "diff.external=",
  "-c", "diff.textconv=",
  "-c", "diff.algorithm=myers",
  "-c", "diff.context=3",
  "-c", "status.showUntrackedFiles=normal",
  "-c", "status.renames=false"
] as const;
const SPEC_DIFF_ARGV = [
  "diff",
  "--no-ext-diff",
  "--no-textconv",
  "--binary",
  "--no-color",
  "--no-renames",
  "--full-index",
  "--unified=3",
  "--diff-algorithm=myers",
  "--abbrev=40",
  "HEAD",
  "--"
] as const;

export const SPEC_STATE_FRAME_TAG = Buffer.from("alaya.bench.worktree-state.v3\0", "utf8");
export const SPEC_UNTRACKED_FRAME_TAG = Buffer.from(
  "alaya.bench.worktree-untracked.v2\0",
  "utf8"
);
export const SPEC_STATE_FRAME_TAG_HEX = "616c6179612e62656e63682e776f726b747265652d73746174652e763300";
export const SPEC_PLANTED_DIRTY_V3_HEX =
  "2d22fe16ab08926bbfeeca0a1100304c3a5253ddba14b1c692b66d946b034429";

export async function specGitIdentityBytes(
  checkoutRoot: string,
  args: readonly string[]
): Promise<Buffer> {
  const result = await execFileAsync("git", [
    "--no-pager",
    "-C", checkoutRoot,
    ...SPEC_GIT_CONFIG,
    ...args
  ], {
    encoding: "buffer",
    maxBuffer: 64 * 1024 * 1024,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      LC_ALL: "C",
      LANG: "C",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: EMPTY_SOURCE,
      GIT_CONFIG_SYSTEM: EMPTY_SOURCE,
      GIT_TERMINAL_PROMPT: "0",
      GIT_OPTIONAL_LOCKS: "0"
    }
  });
  return result.stdout as Buffer;
}

export function specTrackedDiffArgs(): readonly string[] {
  return SPEC_DIFF_ARGV;
}

export function specUint32Be(length: number): Buffer {
  const encoded = Buffer.alloc(4);
  encoded.writeUInt32BE(length);
  return encoded;
}

export function specLabeled(label: string, payload: Buffer): Buffer {
  const labelBytes = Buffer.from(label, "utf8");
  return Buffer.concat([
    specUint32Be(labelBytes.length),
    labelBytes,
    specUint32Be(payload.length),
    payload
  ]);
}

export function specHashDirtyState(input: {
  readonly head: Buffer;
  readonly porcelain: Buffer;
  readonly trackedDiff: Buffer;
  readonly untrackedFrame: Buffer;
}): string {
  return createHash("sha256").update(Buffer.concat([
    SPEC_STATE_FRAME_TAG,
    specLabeled("head", input.head),
    specLabeled("porcelain", input.porcelain),
    specLabeled("tracked-diff", input.trackedDiff),
    specLabeled("untracked", input.untrackedFrame)
  ])).digest("hex");
}

export async function independentDirtyWorktreeHash(root: string): Promise<string> {
  const head = await specGitIdentityBytes(root, ["rev-parse", "HEAD"]);
  const porcelain = await specGitIdentityBytes(root, [
    "status", "--porcelain=v1", "-z", "--untracked-files=normal"
  ]);
  if (porcelain.length === 0) {
    return createHash("sha256").update(head).digest("hex");
  }
  return specHashDirtyState({
    head,
    porcelain,
    trackedDiff: await specGitIdentityBytes(root, specTrackedDiffArgs()),
    untrackedFrame: await specUntrackedFrameFromWorktree(root)
  });
}

export async function specTrackedDiffBytes(root: string): Promise<Buffer> {
  return specGitIdentityBytes(root, specTrackedDiffArgs());
}

async function specUntrackedFrameFromWorktree(root: string): Promise<Buffer> {
  const listed = await specGitIdentityBytes(root, [
    "ls-files", "-z", "--others", "--exclude-standard", "--"
  ]);
  const files: { readonly path: string; readonly record: Buffer }[] = [];
  for (const relativePath of splitNulUtf8Paths(listed)) {
    const absolute = join(root, relativePath);
    const stat = await lstat(absolute);
    const pathBytes = Buffer.from(relativePath, "utf8");
    const mode = (stat.mode & 0o111) !== 0 ? 0o100755 : 0o100644;
    files.push({
      path: relativePath,
      record: Buffer.concat([
        specUint32Be(pathBytes.length),
        pathBytes,
        specUint32Be(mode),
        createHash("sha256").update(await readFile(absolute)).digest()
      ])
    });
  }
  if (files.length === 0) return Buffer.alloc(0);
  files.sort((left, right) =>
    Buffer.from(left.path, "utf8").compare(Buffer.from(right.path, "utf8"))
  );
  return Buffer.concat([SPEC_UNTRACKED_FRAME_TAG, ...files.map((file) => file.record)]);
}

function splitNulUtf8Paths(buffer: Buffer): readonly string[] {
  const paths: string[] = [];
  let start = 0;
  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] !== 0) continue;
    if (index > start) {
      paths.push(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(start, index)));
    }
    start = index + 1;
  }
  if (start < buffer.length) {
    paths.push(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(start)));
  }
  return paths;
}
