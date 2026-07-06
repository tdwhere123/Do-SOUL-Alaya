import { rm } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { initDatabase } from "@do-soul/alaya-storage";

export function closeCachedDatabase(filename: string): void {
  try {
    initDatabase({ filename }).close();
  } catch {
    // Path may not exist for a given test; ignore.
  }
}

export async function removeTempDirectory(
  directory: string,
  dbFilenames: readonly string[] = ["alaya.db"]
): Promise<void> {
  for (const dbFilename of dbFilenames) {
    closeCachedDatabase(join(directory, dbFilename));
  }

  const maxAttempts = process.platform === "win32" ? 10 : 1;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      await rm(directory, { recursive: true, force: true });
      return;
    } catch (error) {
      const code =
        error instanceof Error && "code" in error
          ? String((error as NodeJS.ErrnoException).code)
          : undefined;
      if ((code !== "EBUSY" && code !== "EPERM" && code !== "ENOTEMPTY") || attempt + 1 >= maxAttempts) {
        throw error;
      }
      await sleep(50);
    }
  }
}
