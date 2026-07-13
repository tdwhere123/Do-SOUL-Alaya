import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";

/**
 * Cross-process single-flight for local ONNX model work.
 *
 * Parallel processes own separate bi/cross clients; without a host lock their
 * ONNX thread pools can oversubscribe the CPU and inflate tail latency.
 * Opt in with ALAYA_LOCAL_ONNX_HOST_SINGLE_FLIGHT=1 when coordinating local
 * inference across processes; it is not enabled by default.
 *
 * The persistent file is a dedicated SQLite database. BEGIN IMMEDIATE is the
 * ownership primitive: SQLite serializes writers across processes and the OS
 * releases the transaction when an owning process dies. The path is never
 * renamed or unlinked, so ownership cannot cross file generations.
 */

const DEFAULT_RETRY_MS = 25;
const DEFAULT_TIMEOUT_MS = 120_000;
const SQLITE_BUSY_PRIMARY_CODE = 5;

interface HostLockEnvironment {
  readonly ALAYA_LOCAL_ONNX_LOCK_PATH?: string;
  readonly TMPDIR?: string;
}

interface HostLockTarget {
  readonly lockPath: string;
  readonly privateDirectory?: string;
}

export function localOnnxHostSingleFlightEnabled(
  env: { readonly ALAYA_LOCAL_ONNX_HOST_SINGLE_FLIGHT?: string } = process.env
): boolean {
  const raw = env.ALAYA_LOCAL_ONNX_HOST_SINGLE_FLIGHT?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "on" || raw === "yes";
}

export function resolveLocalOnnxHostLockPath(
  env: HostLockEnvironment = process.env
): string {
  return resolveHostLockTarget(env).lockPath;
}

function resolveHostLockTarget(env: HostLockEnvironment = process.env): HostLockTarget {
  const override = env.ALAYA_LOCAL_ONNX_LOCK_PATH?.trim();
  if (override && override.length > 0) {
    return { lockPath: override };
  }
  const tmp = env.TMPDIR?.trim() || os.tmpdir();
  const privateDirectory = path.join(tmp, `do-soul-alaya-${resolveHostUserKey()}`);
  return {
    lockPath: path.join(privateDirectory, "local-onnx-inference.lock"),
    privateDirectory
  };
}

function resolveHostUserKey(): string {
  if (typeof process.getuid === "function") {
    return `uid-${process.getuid()}`;
  }
  const user = os.userInfo();
  const digest = createHash("sha256")
    .update(`${user.username}\0${user.homedir}`)
    .digest("hex")
    .slice(0, 16);
  return `user-${digest}`;
}

export async function withLocalOnnxHostSingleFlight<T>(
  operation: () => Promise<T>,
  options: {
    readonly enabled?: boolean;
    readonly lockPath?: string;
    readonly timeoutMs?: number;
    readonly retryMs?: number;
    readonly now?: () => number;
    readonly sleep?: (ms: number) => Promise<void>;
    readonly signal?: AbortSignal;
  } = {}
): Promise<T> {
  const enabled = options.enabled ?? localOnnxHostSingleFlightEnabled();
  if (!enabled) {
    throwIfAborted(options.signal);
    return operation();
  }
  const target = options.lockPath === undefined
    ? resolveHostLockTarget()
    : { lockPath: options.lockPath };
  return runWithSqliteHostLock(operation, {
    lockPath: target.lockPath,
    privateDirectory: target.privateDirectory,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    retryMs: Math.max(1, options.retryMs ?? DEFAULT_RETRY_MS),
    now: options.now ?? (() => Date.now()),
    sleep: options.sleep ?? defaultSleep,
    signal: options.signal
  });
}

interface HostLockWait {
  readonly lockPath: string;
  readonly privateDirectory?: string;
  readonly timeoutMs: number;
  readonly retryMs: number;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly signal?: AbortSignal;
}

async function runWithSqliteHostLock<T>(
  operation: () => Promise<T>,
  input: HostLockWait
): Promise<T> {
  const deadline = input.now() + Math.max(0, input.timeoutMs);
  const database = await openLockDatabase(input.lockPath, input.privateDirectory);
  let failed = false;
  let failure: unknown;
  try {
    await waitForWriteTransaction(database, input, deadline);
    throwIfAborted(input.signal);
    return await operation();
  } catch (error) {
    failed = true;
    failure = error;
    throw error;
  } finally {
    const releaseError = releaseLockDatabase(database);
    if (releaseError !== undefined) {
      if (failed) {
        throw new AggregateError([failure, releaseError], "ONNX operation and lock release failed");
      }
      throw releaseError;
    }
  }
}

async function openLockDatabase(
  lockPath: string,
  privateDirectory?: string
): Promise<DatabaseSync> {
  if (privateDirectory === undefined) {
    await mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  } else {
    await ensurePrivateLockDirectory(privateDirectory);
  }
  await ensureSqliteLockFile(lockPath);
  const { DatabaseSync } = await import("node:sqlite");
  return new DatabaseSync(lockPath, { timeout: 0 });
}

async function waitForWriteTransaction(
  database: DatabaseSync,
  input: HostLockWait,
  deadline: number
): Promise<void> {
  for (;;) {
    throwIfAborted(input.signal);
    try {
      database.exec("BEGIN IMMEDIATE");
      return;
    } catch (error) {
      if (!isSqliteBusy(error)) throw error;
    }
    if (input.now() >= deadline) {
      throw new Error(
        `Local ONNX host single-flight lock timed out after ${input.timeoutMs}ms ` +
          `(path=${input.lockPath}).`
      );
    }
    await input.sleep(input.retryMs);
  }
}

async function ensureSqliteLockFile(lockPath: string): Promise<void> {
  try {
    const handle = await open(lockPath, lockOpenFlags(), 0o600);
    await handle.close();
  } catch (error) {
    if (!isNodeErrorWithCode(error, "EEXIST")) throw error;
    await assertLockIsRegularFile(lockPath);
  }
}

async function ensurePrivateLockDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stats = await lstat(directory);
  if (!stats.isDirectory()) {
    throw new Error(`Local ONNX private lock path is not a directory: ${directory}`);
  }
  if (typeof process.getuid === "function" && stats.uid !== process.getuid()) {
    throw new Error(`Local ONNX private lock directory has a different owner: ${directory}`);
  }
  if (process.platform !== "win32" && (stats.mode & 0o777) !== 0o700) {
    throw new Error(`Local ONNX private lock directory must have mode 0700: ${directory}`);
  }
}

function releaseLockDatabase(database: DatabaseSync): unknown | undefined {
  const errors: unknown[] = [];
  if (database.isTransaction) {
    try {
      database.exec("ROLLBACK");
    } catch (error) {
      errors.push(error);
    }
  }
  if (database.isOpen) {
    try {
      database.close();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length === 0) return undefined;
  return errors.length === 1
    ? errors[0]
    : new AggregateError(errors, "Local ONNX lock rollback and close failed");
}

function lockOpenFlags(): number {
  const noFollow =
    "O_NOFOLLOW" in fsConstants
      ? (fsConstants.O_NOFOLLOW as number)
      : 0;
  return fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | noFollow;
}

async function assertLockIsRegularFile(lockPath: string): Promise<void> {
  const stats = await lstat(lockPath);
  if (!stats.isFile()) {
    throw new Error(`Local ONNX host lock is not a regular file: ${lockPath}`);
  }
}

function isSqliteBusy(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("errcode" in error)) {
    return false;
  }
  const errcode = (error as { readonly errcode?: unknown }).errcode;
  return typeof errcode === "number" && (errcode & 0xff) === SQLITE_BUSY_PRIMARY_CODE;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted !== true) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new Error("Local ONNX host single-flight wait was aborted.");
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
