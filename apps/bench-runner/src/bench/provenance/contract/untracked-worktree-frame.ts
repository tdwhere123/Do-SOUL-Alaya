import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { encodeUint32Be } from "./worktree-binary.js";

export type UntrackedWorktreeRecord = {
  readonly relativePath: string;
  readonly mode: number;
  readonly contentSha256: Buffer;
};

export const UNTRACKED_WORKTREE_FRAME_TAG = Buffer.from(
  "alaya.bench.worktree-untracked.v2\0",
  "utf8"
);
export const GIT_REGULAR_FILE_MODE = 0o100644;
export const GIT_EXECUTABLE_FILE_MODE = 0o100755;

export function encodeUntrackedFrameUint32Be(length: number): Buffer {
  return encodeUint32Be(length);
}

export function gitRegularFileMode(executable: boolean): number {
  return executable ? GIT_EXECUTABLE_FILE_MODE : GIT_REGULAR_FILE_MODE;
}

export function fileModeFromStatMode(statMode: number): number {
  return gitRegularFileMode((statMode & 0o111) !== 0);
}

export function encodeUntrackedWorktreeFrame(
  files: readonly UntrackedWorktreeRecord[]
): Buffer {
  if (files.length === 0) return Buffer.alloc(0);
  const sorted = [...files].sort((left, right) =>
    Buffer.from(left.relativePath, "utf8").compare(Buffer.from(right.relativePath, "utf8"))
  );
  const chunks: Buffer[] = [UNTRACKED_WORKTREE_FRAME_TAG];
  let previousPath: string | undefined;
  for (const file of sorted) {
    if (file.relativePath === previousPath) {
      throw new Error("untracked provenance paths must be unique");
    }
    previousPath = file.relativePath;
    chunks.push(encodeUntrackedWorktreeRecord(file));
  }
  return Buffer.concat(chunks);
}

export function assertSafeUntrackedRelativePath(
  rawPath: string,
  checkoutRoot: string
): string {
  const segments = rawPath.split("/");
  if (rawPath.length === 0 || rawPath.includes("\0") || rawPath.startsWith("/") ||
      rawPath.includes("\\") || segments.some((segment) =>
        segment.length === 0 || segment === "." || segment === "..")) {
    throw new Error("untracked provenance path is not a normalized relative git path");
  }
  const root = resolve(checkoutRoot);
  const absolute = resolve(root, rawPath);
  const contained = relative(root, absolute);
  if (contained.length === 0 || isAbsolute(contained) || contained.split(sep).includes("..")) {
    throw new Error("untracked provenance path escapes the worktree");
  }
  return rawPath;
}

export function hashUntrackedContent(bytes: Buffer): Buffer {
  return createHash("sha256").update(bytes).digest();
}

function encodeUntrackedWorktreeRecord(file: UntrackedWorktreeRecord): Buffer {
  if (file.contentSha256.length !== 32) {
    throw new Error("untracked provenance content digest must be 32 bytes");
  }
  if (file.mode !== GIT_REGULAR_FILE_MODE && file.mode !== GIT_EXECUTABLE_FILE_MODE) {
    throw new Error("untracked provenance mode must be a git regular file mode");
  }
  const pathBytes = Buffer.from(file.relativePath, "utf8");
  return Buffer.concat([
    encodeUint32Be(pathBytes.length),
    pathBytes,
    encodeUint32Be(file.mode),
    file.contentSha256
  ]);
}
