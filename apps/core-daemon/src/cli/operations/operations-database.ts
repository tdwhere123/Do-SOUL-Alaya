import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { openReadOnlyDatabase } from "@do-soul/alaya-storage";

/** A SQLite snapshot includes committed WAL pages without checkpointing the live database. */
export async function readDatabaseSnapshot(filename: string): Promise<Buffer | null> {
  try {
    await stat(filename);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
  return await withSnapshotFile(async (snapshotFilename) => {
    const source = openReadOnlyDatabase(filename);
    try {
      await source.connection.backup(snapshotFilename);
      return await readFile(snapshotFilename);
    } finally {
      source.close();
    }
  });
}

/** Caller must hold the destination's runtime and maintenance leases. */
export async function restoreDatabaseSnapshot(filename: string, bytes: Buffer): Promise<void> {
  await withSnapshotFile(async (snapshotFilename) => {
    await writeFile(snapshotFilename, bytes, { mode: 0o600 });
    const source = openReadOnlyDatabase(snapshotFilename);
    try {
      source.connection.pragma("schema_version");
      await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
      await writeFile(filename, Buffer.alloc(0), { flag: "ax", mode: 0o600 }).catch((error: unknown) => {
        if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      });
      // Let SQLite replace the destination transactionally, including its WAL.
      // Renaming a main database file can leave an old WAL attached to new bytes.
      await chmod(filename, 0o600);
      await source.connection.backup(filename);
    } finally {
      source.close();
    }
  });
}

async function withSnapshotFile<T>(operation: (filename: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(path.join(tmpdir(), "alaya-operations-"));
  try {
    return await operation(path.join(directory, "snapshot.db"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
