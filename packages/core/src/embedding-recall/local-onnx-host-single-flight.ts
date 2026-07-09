import { open, readFile, unlink, mkdir, lstat } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Cross-process single-flight for local ONNX `embedTexts`.
 *
 * Parallel LongMemEval shards each own a LocalOnnxEmbeddingClient; without a
 * host lock their ONNX thread pools oversubscribe the CPU and inflate p95.
 * Opt in with ALAYA_LOCAL_ONNX_HOST_SINGLE_FLIGHT=1. Parallel LongMemEval
 * concurrency wiring may set it; it is not enabled by default.
 *
 * Uses O_EXCL lock files — same pattern as daemon env-file locks, kept in core
 * so packages/core does not import apps/*.
 */

const DEFAULT_RETRY_MS = 25;
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_RECLAIM_INTERVAL_MS = 1000;

/** True when no reclaim has run yet, or the reclaim interval has elapsed. */
export function shouldAttemptStaleLockReclaim(
  lastReclaimAt: number | undefined,
  nowMs: number,
  intervalMs: number = DEFAULT_RECLAIM_INTERVAL_MS
): boolean {
  return lastReclaimAt === undefined || nowMs - lastReclaimAt >= intervalMs;
}

export function localOnnxHostSingleFlightEnabled(
  env: { readonly ALAYA_LOCAL_ONNX_HOST_SINGLE_FLIGHT?: string } = process.env
): boolean {
  const raw = env.ALAYA_LOCAL_ONNX_HOST_SINGLE_FLIGHT?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "on" || raw === "yes";
}

export function resolveLocalOnnxHostLockPath(
  env: {
    readonly ALAYA_LOCAL_ONNX_LOCK_PATH?: string;
    readonly TMPDIR?: string;
  } = process.env
): string {
  const override = env.ALAYA_LOCAL_ONNX_LOCK_PATH?.trim();
  if (override && override.length > 0) {
    return override;
  }
  const tmp = env.TMPDIR?.trim() || os.tmpdir();
  return path.join(tmp, "alaya-local-onnx-inference.lock");
}

export async function withLocalOnnxHostSingleFlight<T>(
  operation: () => Promise<T>,
  options: {
    readonly enabled?: boolean;
    readonly lockPath?: string;
    readonly timeoutMs?: number;
    readonly retryMs?: number;
    readonly reclaimIntervalMs?: number;
    readonly now?: () => number;
    readonly sleep?: (ms: number) => Promise<void>;
  } = {}
): Promise<T> {
  const enabled = options.enabled ?? localOnnxHostSingleFlightEnabled();
  if (!enabled) {
    return operation();
  }

  const lockPath = options.lockPath ?? resolveLocalOnnxHostLockPath();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retryMs = Math.max(1, options.retryMs ?? DEFAULT_RETRY_MS);
  const reclaimIntervalMs = Math.max(
    0,
    options.reclaimIntervalMs ?? DEFAULT_RECLAIM_INTERVAL_MS
  );
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? defaultSleep;
  const deadline = now() + Math.max(0, timeoutMs);
  let lastReclaimAt: number | undefined;

  for (;;) {
    const shouldReclaim = shouldAttemptStaleLockReclaim(
      lastReclaimAt,
      now(),
      reclaimIntervalMs
    );
    const lock = await tryAcquireLock(lockPath, shouldReclaim);
    if (lock !== null) {
      try {
        return await operation();
      } finally {
        await lock.release();
      }
    }
    if (shouldReclaim) {
      lastReclaimAt = now();
    }
    if (now() >= deadline) {
      throw new Error(
        `Local ONNX host single-flight lock timed out after ${timeoutMs}ms ` +
          `(path=${lockPath}).`
      );
    }
    await sleep(retryMs);
  }
}

async function tryAcquireLock(
  lockPath: string,
  shouldReclaim: boolean
): Promise<{ readonly release: () => Promise<void> } | null> {
  try {
    await mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 });
    const handle = await open(lockPath, lockOpenFlags(), 0o600);
    try {
      await handle.writeFile(`${process.pid}\n${new Date().toISOString()}\n`, "utf8");
      await handle.close();
      return {
        release: async () => {
          await unlink(lockPath).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== "ENOENT") {
              throw error;
            }
          });
        }
      };
    } catch (error) {
      await handle.close().catch(() => undefined);
      await unlink(lockPath).catch(() => undefined);
      throw error;
    }
  } catch (error) {
    if (isNodeErrorWithCode(error, "EEXIST")) {
      await assertLockIsRegularFile(lockPath);
      if (shouldReclaim) {
        await tryReclaimStaleLock(lockPath);
      }
      return null;
    }
    throw error;
  }
}

/**
 * Reclaim only when the lock's first line is a PID that is definitely dead
 * (kill(pid, 0) → ESRCH). Alive, unparsable, or EPERM locks are left alone.
 */
async function tryReclaimStaleLock(lockPath: string): Promise<void> {
  let raw: string;
  try {
    raw = await readFile(lockPath, "utf8");
  } catch (error) {
    if (isNodeErrorWithCode(error, "ENOENT")) {
      return;
    }
    throw error;
  }
  const firstLine = raw.split("\n", 1)[0]?.trim() ?? "";
  if (!/^\d+$/.test(firstLine)) {
    return;
  }
  const pid = Number(firstLine);
  if (!Number.isInteger(pid) || pid <= 0) {
    return;
  }
  try {
    process.kill(pid, 0);
    return;
  } catch (error) {
    if (!isNodeErrorWithCode(error, "ESRCH")) {
      return;
    }
  }
  await unlink(lockPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") {
      throw error;
    }
  });
}

function lockOpenFlags(): number {
  const noFollow =
    "O_NOFOLLOW" in fsConstants
      ? (fsConstants.O_NOFOLLOW as number)
      : 0;
  return fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | noFollow;
}

async function assertLockIsRegularFile(lockPath: string): Promise<void> {
  try {
    const stats = await lstat(lockPath);
    if (!stats.isFile()) {
      throw new Error(`Local ONNX host lock is not a regular file: ${lockPath}`);
    }
  } catch (error) {
    if (isNodeErrorWithCode(error, "ENOENT")) {
      return;
    }
    throw error;
  }
}

function isNodeErrorWithCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
