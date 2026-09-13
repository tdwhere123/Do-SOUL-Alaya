#!/usr/bin/env node
// Consistent SQLite snapshot for installer rollback. VACUUM INTO copies a
// self-contained database even when the live file uses WAL.
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

const source = process.argv[2];
const destination = process.argv[3];
if (typeof source !== "string" || source.length === 0 || typeof destination !== "string" || destination.length === 0) {
  process.stderr.write("usage: vacuum-into.mjs <source.db> <dest.db>\n");
  process.exit(1);
}

mkdirSync(dirname(destination), { recursive: true });
const db = new Database(source, { readonly: true, fileMustExist: true });
try {
  db.exec(`VACUUM INTO ${sqlStringLiteral(destination)}`);
} finally {
  db.close();
}

function sqlStringLiteral(value) {
  return `'${value.replaceAll("'", "''")}'`;
}
