import { createHash } from "node:crypto";
import fs from "node:fs";

export const SQLITE_DATABASE_FILE_WITNESS_ROLES = Object.freeze(["database", "journal", "wal"] as const);

export type SqliteDatabaseFileWitnessRole = (typeof SQLITE_DATABASE_FILE_WITNESS_ROLES)[number];

export interface SqliteDatabaseFileWitness {
  readonly role: SqliteDatabaseFileWitnessRole;
  readonly bytes: number;
  readonly sha256: string;
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
