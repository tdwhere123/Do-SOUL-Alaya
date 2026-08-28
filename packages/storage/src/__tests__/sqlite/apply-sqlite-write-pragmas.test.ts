import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import {
  applySqliteWritePragmas,
  applySqliteWriteQueueSessionPragmas
} from "../../sqlite/apply-sqlite-write-pragmas.js";

describe("applySqliteWritePragmas", () => {
  const roots: string[] = [];

  afterEach(() => {
    while (roots.length > 0) {
      rmSync(roots.pop()!, { recursive: true, force: true });
    }
  });

  function openProbe(): Database.Database {
    const root = mkdtempSync(join(tmpdir(), "alaya-write-pragmas-"));
    roots.push(root);
    return new Database(join(root, "probe.db"));
  }

  it("does not set cache_size or temp_store on the shared write path", () => {
    const db = openProbe();
    applySqliteWritePragmas(db, { busyTimeoutMs: 5_000 });
    expect(Number(db.pragma("cache_size", { simple: true }))).not.toBe(-65_536);
    expect(Number(db.pragma("temp_store", { simple: true }))).toBe(0);
    expect(Number(db.pragma("synchronous", { simple: true }))).toBe(1);
    db.close();
  });

  it("applies session cache_size/temp_store without switching synchronous off", () => {
    const db = openProbe();
    applySqliteWritePragmas(db, { busyTimeoutMs: 5_000 });
    applySqliteWriteQueueSessionPragmas(db, { cacheSizeKib: 65_536, tempStore: "FILE" });
    expect(Number(db.pragma("cache_size", { simple: true }))).toBe(-65_536);
    expect(Number(db.pragma("temp_store", { simple: true }))).toBe(1);
    expect(Number(db.pragma("synchronous", { simple: true }))).toBe(1);
    db.close();
  });
});
