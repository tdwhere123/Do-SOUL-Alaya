import fs from "node:fs";
import path from "node:path";
import { StorageError } from "../shared/errors.js";

export function restrictSqliteFileModes(filename: string): void {
  if (filename === ":memory:") return;
  try {
    fs.chmodSync(path.dirname(filename), 0o700);
    fs.chmodSync(filename, 0o600);
    chmodExistingSqliteSidecar(`${filename}-wal`);
    chmodExistingSqliteSidecar(`${filename}-shm`);
  } catch (error) {
    throw new StorageError(
      "DATABASE_OPEN_FAILED",
      `Failed to restrict database file modes: ${filename}`,
      error
    );
  }
}

function chmodExistingSqliteSidecar(filename: string): void {
  try {
    fs.chmodSync(filename, 0o600);
  } catch (error) {
    if (!isEnoent(error)) throw error;
  }
}

function isEnoent(error: unknown): boolean {
  return error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "ENOENT";
}
