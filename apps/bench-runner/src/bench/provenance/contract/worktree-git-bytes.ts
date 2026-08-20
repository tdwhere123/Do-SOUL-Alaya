import { execFile } from "node:child_process";
import { devNull } from "node:os";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Identity must not inherit user git config or ambient diff/index env.
// Repo .gitignore, .git/info/exclude, and tracked .gitattributes remain authority.
// Local autocrlf is unpinned because checked-out worktree bytes are hashed.
const EMPTY_GIT_IDENTITY_SOURCE = devNull;

const GIT_IDENTITY_CONFIG = [
  "-c", "core.quotepath=false",
  "-c", "core.abbrev=40",
  "-c", `core.excludesFile=${EMPTY_GIT_IDENTITY_SOURCE}`,
  "-c", `core.attributesFile=${EMPTY_GIT_IDENTITY_SOURCE}`,
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

const GIT_DIFF_ARGV = [
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

export async function gitIdentityBytes(
  checkoutRoot: string,
  args: readonly string[]
): Promise<Buffer> {
  const result = await execFileAsync("git", [
    "--no-pager",
    "-C", checkoutRoot,
    ...GIT_IDENTITY_CONFIG,
    ...args
  ], {
    encoding: "buffer",
    maxBuffer: 64 * 1024 * 1024,
    env: gitIdentityEnv()
  });
  return result.stdout as Buffer;
}

export function gitTrackedDiffArgs(): readonly string[] {
  return GIT_DIFF_ARGV;
}

export function splitNulUtf8Paths(buffer: Buffer): readonly string[] {
  const paths: string[] = [];
  let start = 0;
  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] !== 0) continue;
    pushUtf8Path(buffer.subarray(start, index), paths);
    start = index + 1;
  }
  if (start < buffer.length) pushUtf8Path(buffer.subarray(start), paths);
  return paths;
}

function gitIdentityEnv(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    LC_ALL: "C",
    LANG: "C",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: EMPTY_GIT_IDENTITY_SOURCE,
    GIT_CONFIG_SYSTEM: EMPTY_GIT_IDENTITY_SOURCE,
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0"
  };
}

function pushUtf8Path(bytes: Buffer, paths: string[]): void {
  if (bytes.length === 0) return;
  try {
    paths.push(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error("untracked provenance path is not valid UTF-8");
  }
}
