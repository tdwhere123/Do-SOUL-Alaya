import { createHash } from "node:crypto";
import fs from "node:fs";
import { StorageError } from "../shared/errors.js";

export const SQLITE_DATABASE_FILE_WITNESS_ROLES = Object.freeze(["database", "journal", "wal"] as const);

type SqliteDatabaseFileWitnessRole = (typeof SQLITE_DATABASE_FILE_WITNESS_ROLES)[number];

export interface SqliteDatabaseFileWitness {
  readonly role: SqliteDatabaseFileWitnessRole;
  readonly bytes: number;
  readonly sha256: string;
}

export function assertEmptySqliteWal(filename: string): void {
  const wal = fs.lstatSync(`${filename}-wal`, { throwIfNoEntry: false });
  if (wal !== undefined && (!wal.isFile() || wal.size !== 0)) {
    throw new StorageError("CONFLICT", "Temporal candidate has a non-empty or invalid SQLite WAL sidecar.");
  }
}

export function readSealedSqliteDatabaseDigest(filename: string): string {
  assertEmptySqliteWal(filename);
  const digest = createHash("sha256").update(fs.readFileSync(filename)).digest("hex");
  assertEmptySqliteWal(filename);
  return digest;
}

function sqliteDatabaseFileWitnessPath(
  filename: string,
  role: SqliteDatabaseFileWitnessRole
): string {
  return role === "database" ? filename : `${filename}-${role}`;
}

export function readSqliteDatabaseFileWitnessSet(
  filename: string
): readonly SqliteDatabaseFileWitness[] {
  return Object.freeze(SQLITE_DATABASE_FILE_WITNESS_ROLES.flatMap((role) => {
    const partFilename = sqliteDatabaseFileWitnessPath(filename, role);
    if (!fs.existsSync(partFilename)) return [];
    const bytes = fs.readFileSync(partFilename);
    return [Object.freeze({
      role,
      bytes: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex")
    })];
  }));
}
