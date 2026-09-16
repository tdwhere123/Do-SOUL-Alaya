import { readFileSync } from "node:fs";

export const INSPECTOR_LAUNCH_PROOF_FD = 3;

export function readInspectorLaunchProof(
  readFd: (fd: number) => string = readInheritedFd
): string | undefined {
  return normalizeSecret(tryReadFd(readFd, INSPECTOR_LAUNCH_PROOF_FD));
}

function tryReadFd(readFd: (fd: number) => string, fd: number): string | undefined {
  try {
    return readFd(fd);
  } catch {
    return undefined;
  }
}

function readInheritedFd(fd: number): string {
  return readFileSync(fd, { encoding: "utf8" });
}

function normalizeSecret(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}
