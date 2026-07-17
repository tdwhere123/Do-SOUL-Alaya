import {
  acquireTemporalMaintenanceLease,
  type TemporalMaintenanceLease
} from "@do-soul/alaya-storage";
import { randomUUID } from "node:crypto";
import path from "node:path";

const CUTOVER_LOCK_SUFFIX = ".temporal-cutover.lock.sqlite";
const RUNTIME_LOCK_SUFFIX = ".temporal-runtime.lock.sqlite";

interface HeldTemporalCutoverLock {
  readonly filename: string;
  readonly lease: TemporalMaintenanceLease;
}

export interface TemporalCutoverLease {
  readonly configFilename: string;
  readonly candidateFilename: string;
  readonly runtimeFilenames: readonly string[];
  readonly token: string;
}

export interface TemporalCutoverLeaseInput {
  readonly configFilename: string;
  readonly candidateFilename: string;
  /** Every database which must be inactive while this maintenance transaction runs. */
  readonly runtimeFilenames?: readonly string[];
}

export interface TemporalRuntimeLease {
  release(): Promise<void>;
}

/**
 * Serializes all cutovers that share a config, candidate, or active runtime.
 * SQLite's held transaction is released by the OS on process crash, avoiding
 * unsafe PID-based stale-lock deletion.
 */
export async function withTemporalCutoverLease<T>(
  input: TemporalCutoverLeaseInput,
  operation: (lease: TemporalCutoverLease) => Promise<T>
): Promise<T> {
  const lease = createLease(input);
  const locks = acquireLocks(lease);
  let value: T | undefined;
  let operationError: unknown;

  try {
    value = await operation(lease);
  } catch (error) {
    operationError = error;
  }

  try {
    releaseLocks(locks);
  } catch (releaseError) {
    if (operationError !== undefined) {
      throw new Error("Temporal cutover failed and its lease could not be released.", {
        cause: operationError
      });
    }
    throw releaseError;
  }

  if (operationError !== undefined) throw operationError;
  return value as T;
}

export function assertTemporalCutoverLease(
  lease: TemporalCutoverLease,
  input: TemporalCutoverLeaseInput
): void {
  if (
    lease.configFilename !== normalizePath(input.configFilename) ||
    lease.candidateFilename !== normalizePath(input.candidateFilename)
  ) {
    throw new Error("Temporal cutover lease does not own this config and candidate pair.");
  }
}

/** A daemon holds this marker for its open database lifetime. */
export async function acquireTemporalRuntimeLease(databaseFilename: string): Promise<TemporalRuntimeLease> {
  if (databaseFilename === ":memory:") {
    return Object.freeze({ release: async () => undefined });
  }
  const filename = runtimeLockFilename(normalizePath(databaseFilename));
  const lease = acquireLock(filename);
  return Object.freeze({ release: async () => releaseLocks([{ filename, lease }]) });
}

function createLease(input: TemporalCutoverLeaseInput): TemporalCutoverLease {
  const configFilename = normalizePath(input.configFilename);
  const candidateFilename = normalizePath(input.candidateFilename);
  if (configFilename === candidateFilename) {
    throw new Error("Temporal cutover config and candidate paths must differ.");
  }
  const runtimeFilenames = Object.freeze(
    [...new Set(input.runtimeFilenames ?? [])]
      .filter((filename) => filename !== ":memory:")
      .map(normalizePath)
      .sort()
  );
  return Object.freeze({ configFilename, candidateFilename, runtimeFilenames, token: randomUUID() });
}

function acquireLocks(lease: TemporalCutoverLease): readonly HeldTemporalCutoverLock[] {
  const held: HeldTemporalCutoverLock[] = [];
  try {
    for (const filename of lockFilenamesFor(lease)) {
      held.push(Object.freeze({ filename, lease: acquireLock(filename) }));
    }
    return Object.freeze(held);
  } catch (error) {
    releaseLocks(held);
    throw error;
  }
}

function lockFilenamesFor(lease: TemporalCutoverLease): readonly string[] {
  return Object.freeze(
    [
      ...new Set([lease.configFilename, lease.candidateFilename].map(cutoverLockFilename)),
      ...lease.runtimeFilenames.map(runtimeLockFilename)
    ].sort()
  );
}

function acquireLock(filename: string): TemporalMaintenanceLease {
  try {
    return acquireTemporalMaintenanceLease(filename);
  } catch (error) {
    if (isSqliteBusy(error)) throw leaseContentionError(filename);
    throw error;
  }
}

function releaseLocks(locks: readonly HeldTemporalCutoverLock[]): void {
  let failure: unknown;
  for (const lock of [...locks].reverse()) {
    try {
      lock.lease.release();
    } catch (error) {
      failure ??= error;
    }
  }
  if (failure !== undefined) throw failure;
}

function normalizePath(value: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("Temporal cutover lease requires a non-empty path.");
  }
  return path.resolve(value);
}

function cutoverLockFilename(resourceFilename: string): string {
  return `${resourceFilename}${CUTOVER_LOCK_SUFFIX}`;
}

function runtimeLockFilename(databaseFilename: string): string {
  return `${databaseFilename}${RUNTIME_LOCK_SUFFIX}`;
}

function leaseContentionError(filename: string): Error {
  if (filename.endsWith(RUNTIME_LOCK_SUFFIX)) {
    return new Error(`Alaya daemon must be stopped before temporal maintenance: ${filename}.`);
  }
  return new Error(`Temporal cutover is already in progress for ${filename}.`);
}

function isSqliteBusy(error: unknown): boolean {
  const code = readErrorCode(error) ?? readErrorCode(readErrorCause(error));
  return code === "SQLITE_BUSY" || code === "SQLITE_LOCKED";
}

function readErrorCode(error: unknown): string | undefined {
  if (!(error instanceof Error) || !("code" in error)) return undefined;
  const code = (error as NodeJS.ErrnoException).code;
  return typeof code === "string" ? code : undefined;
}

function readErrorCause(error: unknown): unknown {
  return error instanceof Error ? error.cause : undefined;
}
