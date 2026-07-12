import { rm } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { closeCachedDatabase as closeStorageCachedDatabase } from "@do-soul/alaya-storage";

const TRANSIENT_FS_CODES = new Set(["EBUSY", "EPERM", "ENOTEMPTY"]);

export function closeCachedDatabase(filename: string): void {
  closeStorageCachedDatabase(filename);
}

export function isTransientFsLockError(error: unknown): boolean {
  if (!(error instanceof Error) || !("code" in error)) {
    return false;
  }
  return TRANSIENT_FS_CODES.has(String((error as NodeJS.ErrnoException).code));
}

export async function removeTempDirectory(
  directory: string,
  dbFilenames: readonly string[] = ["alaya.db"]
): Promise<void> {
  for (const dbFilename of dbFilenames) {
    closeCachedDatabase(join(directory, dbFilename));
  }

  // Windows can keep WAL/SHM briefly after better-sqlite3 close(); prune must
  // not open DBs (see closeCachedDatabase), only retry unlink.
  const maxAttempts = process.platform === "win32" ? 40 : 1;
  const retryDelayMs = process.platform === "win32" ? 100 : 0;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      await rm(directory, { recursive: true, force: true });
      return;
    } catch (error) {
      if (!isTransientFsLockError(error) || attempt + 1 >= maxAttempts) {
        throw error;
      }
      await sleep(retryDelayMs);
    }
  }
}
