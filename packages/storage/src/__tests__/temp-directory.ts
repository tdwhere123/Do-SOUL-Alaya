import fs from "node:fs";

export interface ClosableDatabase {
  isClosed(): boolean;
  close(): void;
}

export function removeTempDirectorySync(
  directory: string,
  databases: Iterable<ClosableDatabase> = []
): void {
  for (const database of databases) {
    if (!database.isClosed()) {
      database.close();
    }
  }

  const maxAttempts = process.platform === "win32" ? 10 : 1;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      fs.rmSync(directory, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = error instanceof Error && "code" in error
        ? String((error as NodeJS.ErrnoException).code)
        : undefined;
      if (code !== "EBUSY" || attempt + 1 >= maxAttempts) {
        throw error;
      }
      sleepSync(50);
    }
  }
}

function sleepSync(milliseconds: number): void {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    // Windows may keep SQLite WAL handles briefly after close.
  }
}
