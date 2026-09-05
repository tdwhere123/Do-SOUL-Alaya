import {
  gitIdentityBytes,
  gitTrackedDiffArgs,
  splitNulUtf8Paths
} from "./worktree-git-bytes.js";
import { readContainedWorktreeFile } from "./contained-worktree-file.js";
import {
  encodeUntrackedWorktreeFrame,
  hashUntrackedContent,
  type UntrackedWorktreeRecord
} from "./untracked-worktree-frame.js";
import {
  hashCleanWorktreeState,
  hashDirtyWorktreeState,
  worktreeStateAlgorithmFor,
  type WorktreeStateAlgorithm
} from "./worktree-state-frame.js";
import { samePhysicalLocation } from "../../fs/opened-contained-path.js";

export interface MeasuredGitState {
  readonly commitSha: string;
  readonly commitSha7: string;
  readonly worktreeStateSha256: string;
  readonly worktreeStateAlgorithm: WorktreeStateAlgorithm;
  readonly worktreeClean: boolean;
}

export async function measureGitState(
  checkoutRoot: string,
  options: { readonly allowDirty?: boolean } = {}
): Promise<MeasuredGitState> {
  const [rootResult, head, porcelain] = await Promise.all([
    gitIdentityBytes(checkoutRoot, ["rev-parse", "--show-toplevel"]),
    gitIdentityBytes(checkoutRoot, ["rev-parse", "HEAD"]),
    gitIdentityBytes(checkoutRoot, [
      "status", "--porcelain=v1", "-z", "--untracked-files=normal"
    ])
  ]);
  if (!samePhysicalLocation(rootResult.toString("utf8").trim(), checkoutRoot)) {
    throw new Error("provenance checkout root is not the current git worktree root");
  }
  const commitSha = head.toString("utf8").trim();
  if (!/^[a-f0-9]{40}$/u.test(commitSha)) throw new Error("git HEAD is not a commit SHA");
  const worktreeClean = porcelain.length === 0;
  if (!worktreeClean && options.allowDirty !== true) {
    throw new Error("benchmark worktree is not clean");
  }
  return {
    commitSha,
    commitSha7: commitSha.slice(0, 7),
    worktreeStateSha256: await hashMeasuredWorktree(
      checkoutRoot, head, porcelain, worktreeClean
    ),
    worktreeStateAlgorithm: worktreeStateAlgorithmFor(worktreeClean),
    worktreeClean
  };
}

async function hashMeasuredWorktree(
  checkoutRoot: string,
  head: Buffer,
  porcelain: Buffer,
  worktreeClean: boolean
): Promise<string> {
  if (worktreeClean) return hashCleanWorktreeState(head);
  const [trackedDiff, untracked] = await Promise.all([
    gitIdentityBytes(checkoutRoot, gitTrackedDiffArgs()),
    readNonignoredUntrackedFiles(checkoutRoot)
  ]);
  return hashDirtyWorktreeState({
    head,
    porcelain,
    trackedDiff,
    untrackedFrame: encodeUntrackedWorktreeFrame(untracked)
  });
}

async function readNonignoredUntrackedFiles(
  checkoutRoot: string
): Promise<readonly UntrackedWorktreeRecord[]> {
  const listed = await gitIdentityBytes(checkoutRoot, [
    "ls-files", "-z", "--others", "--exclude-standard", "--"
  ]);
  // Empty directories are not Git objects and cannot execute.
  // --exclude-standard still honors repo .gitignore and .git/info/exclude;
  // tracked .gitattributes remain repository authority.
  // global excludesFile/attributesFile are pinned empty in gitIdentityBytes.
  const files: UntrackedWorktreeRecord[] = [];
  for (const relativePath of splitNulUtf8Paths(listed)) {
    const opened = await readContainedWorktreeFile(checkoutRoot, relativePath);
    files.push({
      relativePath,
      mode: opened.mode,
      contentSha256: hashUntrackedContent(opened.bytes)
    });
  }
  return files;
}
