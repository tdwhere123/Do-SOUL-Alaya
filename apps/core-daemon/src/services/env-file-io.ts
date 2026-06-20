import { constants as fsConstants } from "node:fs";
import { lstat, open, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { CoreError } from "@do-soul/alaya-core";
import {
  ensurePrivateDirectory,
  isNodeErrorWithCode,
  syncDirectory,
  writePrivateTextAtomic
} from "./private-file-service.js";
import type { AlayaConfigPaths } from "../cli/config-files.js";

export async function readOptional(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (isNodeErrorWithCode(error, "ENOENT")) {
      return null;
    }
    throw error;
  }
}

export async function restoreRuntimeEmbeddingFiles(
  paths: AlayaConfigPaths,
  previousEnv: string | null,
  pastedSecret: Readonly<{ readonly path: string; readonly value: string }> | null,
  previousSecret: string | null,
  generateTempId: () => string
): Promise<void> {
  await restoreTextFile(paths.envPath, previousEnv, 0o600, generateTempId);
  if (pastedSecret !== null) {
    await restoreTextFile(pastedSecret.path, previousSecret, 0o600, generateTempId);
  }
}

async function restoreTextFile(
  filePath: string,
  previousContent: string | null,
  mode: number,
  generateTempId: () => string
): Promise<void> {
  if (previousContent === null) {
    await unlink(filePath).catch((error) => {
      if (!isNodeErrorWithCode(error, "ENOENT")) {
        throw error;
      }
    });
    await syncDirectory(path.dirname(filePath)).catch(() => undefined);
    return;
  }

  await writeTextAtomicLocked(filePath, previousContent, mode, generateTempId);
}

export function setOrDelete(map: Map<string, string>, key: string, value: string | null): void {
  if (value === null) {
    map.delete(key);
  } else {
    map.set(key, value);
  }
}

const pathWriteLocks = new Map<string, Promise<unknown>>();
const runtimeEmbeddingConfigLocks = new Map<string, Promise<unknown>>();
const RUNTIME_EMBEDDING_CONFIG_LOCK_SUFFIX = ".runtime-embedding.lock";
const DEFAULT_RUNTIME_EMBEDDING_LOCK_TIMEOUT_MS = 10_000;
const DEFAULT_RUNTIME_EMBEDDING_LOCK_RETRY_MS = 10;

export async function withRuntimeEmbeddingConfigLock<T>(lockKey: string, operation: () => Promise<T>): Promise<T> {
  const previous = runtimeEmbeddingConfigLocks.get(lockKey) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  runtimeEmbeddingConfigLocks.set(lockKey, current);
  try {
    return await current;
  } finally {
    if (runtimeEmbeddingConfigLocks.get(lockKey) === current) {
      runtimeEmbeddingConfigLocks.delete(lockKey);
    }
  }
}

export async function withRuntimeEmbeddingFileLock<T>(
  lockKey: string,
  options: {
    readonly timeoutMs?: number;
    readonly retryMs?: number;
  },
  operation: () => Promise<T>
): Promise<T> {
  const lockPath = `${lockKey}${RUNTIME_EMBEDDING_CONFIG_LOCK_SUFFIX}`;
  const lock = await acquireRuntimeEmbeddingFileLock(lockPath, {
    timeoutMs: options.timeoutMs ?? DEFAULT_RUNTIME_EMBEDDING_LOCK_TIMEOUT_MS,
    retryMs: options.retryMs ?? DEFAULT_RUNTIME_EMBEDDING_LOCK_RETRY_MS
  });
  try {
    return await operation();
  } finally {
    await lock.release();
  }
}

async function acquireRuntimeEmbeddingFileLock(
  lockPath: string,
  options: {
    readonly timeoutMs: number;
    readonly retryMs: number;
  }
): Promise<{ readonly release: () => Promise<void> }> {
  const deadline = Date.now() + Math.max(0, options.timeoutMs);
  const retryMs = Math.max(1, options.retryMs);

  for (;;) {
    const created = await tryCreateRuntimeEmbeddingFileLock(lockPath);
    if (created !== null) {
      return created;
    }
    await handleRuntimeEmbeddingFileLockContention(lockPath, deadline, retryMs);
  }
}

async function assertRuntimeEmbeddingFileLockIsRegular(lockPath: string): Promise<void> {
  try {
    const stats = await lstat(lockPath);
    if (!stats.isFile()) {
      throw new CoreError("CONFLICT", "Runtime embedding config lock is not a regular file");
    }
  } catch (error) {
    if (isNodeErrorWithCode(error, "ENOENT")) {
      return;
    }
    throw error;
  }
}

export async function writeTextAtomicLocked(
  filePath: string,
  content: string,
  mode: number,
  generateTempId: () => string
): Promise<void> {
  await withPathWriteLock(
    filePath,
    async () => await writePrivateTextAtomic(filePath, content, mode, generateTempId)
  );
}

async function withPathWriteLock<T>(filePath: string, operation: () => Promise<T>): Promise<T> {
  const previous = pathWriteLocks.get(filePath) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  pathWriteLocks.set(filePath, current);
  try {
    return await current;
  } finally {
    if (pathWriteLocks.get(filePath) === current) {
      pathWriteLocks.delete(filePath);
    }
  }
}

export function trimTrailingLineBreaks(value: string): string {
  return value.replace(/[\r\n]+$/u, "");
}

async function tryCreateRuntimeEmbeddingFileLock(
  lockPath: string
): Promise<{ readonly release: () => Promise<void> } | null> {
  try {
    await ensurePrivateDirectory(path.dirname(lockPath));
    const handle = await open(lockPath, lockOpenFlags(), 0o600);
    try {
      await handle.writeFile(`${process.pid}\n${new Date().toISOString()}\n`, "utf8");
      await handle.sync();
      await handle.close();
      await syncDirectory(path.dirname(lockPath));
      return { release: async () => await releaseRuntimeEmbeddingFileLock(lockPath) };
    } catch (error) {
      await handle.close().catch(() => undefined);
      await unlink(lockPath).catch(() => undefined);
      throw error;
    }
  } catch (error) {
    if (isNodeErrorWithCode(error, "EEXIST")) {
      return null;
    }
    throw error;
  }
}

function lockOpenFlags(): number {
  const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
  return fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | noFollow;
}

async function releaseRuntimeEmbeddingFileLock(lockPath: string): Promise<void> {
  await unlink(lockPath).catch((error) => {
    if (!isNodeErrorWithCode(error, "ENOENT")) {
      throw error;
    }
  });
  await syncDirectory(path.dirname(lockPath)).catch(() => undefined);
}

async function handleRuntimeEmbeddingFileLockContention(
  lockPath: string,
  deadline: number,
  retryMs: number
): Promise<void> {
  await assertRuntimeEmbeddingFileLockIsRegular(lockPath);
  if (Date.now() >= deadline) {
    throw new CoreError("CONFLICT", "Runtime embedding config write is already in progress");
  }
  await sleep(retryMs);
}
