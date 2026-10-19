import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { ExtractionCacheInvariantError } from "../../cache/cache-invariant-error.js";
import { nonCredentialChildEnv } from "./non-credential-child-env.js";
import { readWindowsProcessStartIdentity } from "./windows-process-start.js";

const MAX_PROCESS_START_IDENTITY_BYTES = 16 * 1024;

export function readProcessStartIdentity(pid: number): string {
  if (pid === process.pid) {
    selfProcessStartIdentity ??= readPlatformProcessStartIdentity(pid);
    return selfProcessStartIdentity;
  }
  return readPlatformProcessStartIdentity(pid);
}

let selfProcessStartIdentity: string | undefined;

function readPlatformProcessStartIdentity(pid: number): string {
  if (process.platform === "linux") return readLinuxProcessStartIdentity(pid);
  if (process.platform === "win32") {
    return readWindowsProcessStartIdentity(pid, nonCredentialChildEnv());
  }
  return readPosixProcessStartIdentity(pid);
}

function readLinuxProcessStartIdentity(pid: number): string {
  const bytes = readFileSync(`/proc/${pid}/stat`);
  if (bytes.byteLength > MAX_PROCESS_START_IDENTITY_BYTES) {
    throw new ExtractionCacheInvariantError("writer process identity exceeds its size limit");
  }
  const stat = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const closing = stat.lastIndexOf(")");
  const startTime = stat.slice(closing + 2).trim().split(/\s+/u)[19];
  if (closing < 0 || startTime === undefined || !/^\d+$/u.test(startTime)) {
    throw new ExtractionCacheInvariantError("writer process start identity is unavailable");
  }
  return startTime;
}

function readPosixProcessStartIdentity(pid: number): string {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw Object.assign(
      new ExtractionCacheInvariantError("writer process start identity is unavailable"),
      { code: "ENOENT" }
    );
  }
  let output: string;
  try {
    output = execFileSync("ps", ["-p", String(pid), "-o", "lstart="], {
      encoding: "utf8",
      timeout: 2_000,
      env: nonCredentialChildEnv(),
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
  } catch (cause) {
    if (typeof cause === "object" && cause !== null && "status" in cause &&
        (cause as { status?: number }).status === 1) {
      throw Object.assign(
        new ExtractionCacheInvariantError("writer process start identity is unavailable"),
        { code: "ENOENT", cause }
      );
    }
    throw new ExtractionCacheInvariantError(
      `writer process start identity is unavailable: ${String(cause)}`,
      { cause }
    );
  }
  if (output.length === 0 || output.length > MAX_PROCESS_START_IDENTITY_BYTES) {
    throw Object.assign(
      new ExtractionCacheInvariantError("writer process start identity is unavailable"),
      { code: "ENOENT" }
    );
  }
  const parsed = Date.parse(output);
  if (!Number.isFinite(parsed)) {
    throw new ExtractionCacheInvariantError("writer process start identity is unavailable");
  }
  return String(parsed);
}
