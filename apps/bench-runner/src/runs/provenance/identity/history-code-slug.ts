import {
  entrySlug,
  joinSlugDiscriminators
} from "@do-soul/alaya-eval";

export const DIRTY_WORKTREE_HISTORY_TOKEN_PREFIX = "wt";
const WORKTREE_STATE_SHA256_PATTERN = /^[a-f0-9]{64}$/u;

export function dirtyWorktreeHistoryToken(worktreeStateSha256: string): string {
  if (!WORKTREE_STATE_SHA256_PATTERN.test(worktreeStateSha256)) {
    throw new Error("dirty worktree history token requires a sha256 hex digest");
  }
  return `${DIRTY_WORKTREE_HISTORY_TOKEN_PREFIX}-${worktreeStateSha256}`;
}

export function recordedWorktreeIdentityForSlug(code: {
  readonly worktree_clean?: boolean;
  readonly worktree_state_sha256: string | null;
} | null | undefined): { readonly worktreeClean: boolean; readonly worktreeStateSha256: string } {
  if (code == null ||
      code.worktree_state_sha256 === null ||
      !WORKTREE_STATE_SHA256_PATTERN.test(code.worktree_state_sha256)) {
    throw new Error("history slug requires a recorded worktree state digest");
  }
  if (typeof code.worktree_clean !== "boolean") {
    throw new Error(
      "missing worktree_clean is archive-only and cannot mint a current dirty history slug"
    );
  }
  return {
    worktreeClean: code.worktree_clean,
    worktreeStateSha256: code.worktree_state_sha256
  };
}

export function composeBenchHistorySlug(input: {
  readonly runAt: Date;
  readonly commitSha7: string;
  readonly policyDiscriminator?: string;
  readonly worktreeClean: boolean;
  readonly worktreeStateSha256: string;
}): string {
  return entrySlug(
    input.runAt,
    input.commitSha7,
    joinSlugDiscriminators(
      input.policyDiscriminator,
      input.worktreeClean ? undefined : dirtyWorktreeHistoryToken(input.worktreeStateSha256)
    )
  );
}
