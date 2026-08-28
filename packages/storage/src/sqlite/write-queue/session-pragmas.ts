import { StorageError } from "../../shared/errors.js";
import {
  isSqliteWriteQueueSessionPragmas,
  type SqliteWriteQueueSessionPragmas
} from "../apply-sqlite-write-pragmas.js";

export type { SqliteWriteQueueSessionPragmas };

// Process-global for bench/daemon wiring; filename-keyed; prefer ctor injection on the next seam touch.
const sessionPragmasByFilename = new Map<string, SqliteWriteQueueSessionPragmas>();

export function configureSqliteWriteQueueSessionPragmas(
  filename: string,
  pragmas: SqliteWriteQueueSessionPragmas | null
): void {
  if (filename.length === 0 || filename === ":memory:") {
    throw new StorageError(
      "VALIDATION_FAILED",
      "Write-queue session pragmas require a file-backed database path."
    );
  }
  if (pragmas === null) {
    sessionPragmasByFilename.delete(filename);
    return;
  }
  if (!isSqliteWriteQueueSessionPragmas(pragmas)) {
    throw new StorageError(
      "VALIDATION_FAILED",
      "Write-queue session pragmas require a positive cacheSizeKib and FILE or MEMORY tempStore."
    );
  }
  sessionPragmasByFilename.set(
    filename,
    Object.freeze({
      cacheSizeKib: pragmas.cacheSizeKib,
      tempStore: pragmas.tempStore
    })
  );
}

export function getSqliteWriteQueueSessionPragmas(
  filename: string
): SqliteWriteQueueSessionPragmas | undefined {
  return sessionPragmasByFilename.get(filename);
}
