import { readFileSync } from "node:fs";

export const INSPECTOR_LAUNCH_PROOF_FD = 3;

export function readInspectorLaunchProof(
  env: NodeJS.ProcessEnv,
  readFd: (fd: number) => string = readInheritedFd
): string | undefined {
  const fromFd = normalizeSecret(tryReadFd(readFd, INSPECTOR_LAUNCH_PROOF_FD));
  if (fromFd !== undefined) {
    return fromFd;
  }
  // Env is a last-resort for process-local tests that cannot inherit fd 3.
  return normalizeSecret(env.ALAYA_INSPECTOR_LAUNCH_CODE);
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
