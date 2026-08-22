import { truncateSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initDatabase, closeCachedDatabase } from "@do-soul/alaya-storage";
import { applyBenchFastPragmaIfRequested } from "../../../harness/daemon.js";
import { removeTempDirectory } from "../../support/temp-cleanup.js";

// Bench-only SQLite tuning is layered on top of the production storage
// hardening (see packages/storage/src/sqlite/db.ts). The production pragmas are
// asserted by packages/storage/src/__tests__/db.test.ts; this file covers
// only the bench-extra ones (temp_store, cache_size, mmap_size) and the env gate.

const tmpRoots: string[] = [];

beforeEach(() => {
  delete process.env.ALAYA_BENCH_FAST_PRAGMA;
  delete process.env.ALAYA_BENCH_TEMP_STORE;
  delete process.env.ALAYA_BENCH_CACHE_SIZE_KIB;
});

afterEach(async () => {
  delete process.env.ALAYA_BENCH_FAST_PRAGMA;
  delete process.env.ALAYA_BENCH_TEMP_STORE;
  delete process.env.ALAYA_BENCH_CACHE_SIZE_KIB;
  for (const root of tmpRoots.splice(0)) {
    await removeTempDirectory(root);
  }
});

async function newDataDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "alaya-bench-pragma-"));
  tmpRoots.push(root);
  // Pre-open so the DB file exists at the path applyBenchFastPragmaIfRequested
  // will reach for. initDatabase caches by path so the subsequent open inside
  // applyBenchFastPragmaIfRequested returns the same handle.
  initDatabase({ filename: join(root, "alaya.db") });
  return root;
}

function readPragmaNumber(dataDir: string, pragma: string): number {
  const db = initDatabase({ filename: join(dataDir, "alaya.db") });
  return Number(db.connection.pragma(pragma, { simple: true }));
}

describe("applyBenchFastPragmaIfRequested", () => {
  it("applies bench-fast pragmas with temp_store=FILE default when env is unset", async () => {
    const dataDir = await newDataDir();
    const result = applyBenchFastPragmaIfRequested(dataDir);
    expect(result.applied).toBe(true);
    expect(result.pragmas).toContain("temp_store=FILE");
    expect(result.pragmas).toContain("cache_size=-65536");
    expect(result.pragmas.some((pragma) => pragma.startsWith("mmap_size="))).toBe(false);

    // Verify the bench-only pragmas actually took effect on the cached
    // connection. SQLite returns ints: temp_store FILE == 1,
    // cache_size negative -65536 stored verbatim. Tiny DBs stay at the 64 MiB
    // floor and leave mmap at SQLite's default.
    expect(readPragmaNumber(dataDir, "temp_store")).toBe(1);
    expect(readPragmaNumber(dataDir, "cache_size")).toBe(-65536);
  });

  it("opts back into temp_store=MEMORY when ALAYA_BENCH_TEMP_STORE=memory", async () => {
    process.env.ALAYA_BENCH_TEMP_STORE = "memory";
    const dataDir = await newDataDir();
    const result = applyBenchFastPragmaIfRequested(dataDir);
    expect(result.applied).toBe(true);
    expect(result.pragmas).toContain("temp_store=MEMORY");

    // SQLite returns temp_store MEMORY == 2.
    expect(readPragmaNumber(dataDir, "temp_store")).toBe(2);
  });

  it("applies ALAYA_BENCH_CACHE_SIZE_KIB as a negative cache_size pragma", async () => {
    process.env.ALAYA_BENCH_CACHE_SIZE_KIB = "131072";
    const dataDir = await newDataDir();
    const result = applyBenchFastPragmaIfRequested(dataDir);
    expect(result.applied).toBe(true);
    expect(result.pragmas).toContain("cache_size=-131072");
    expect(readPragmaNumber(dataDir, "cache_size")).toBe(-131072);
  });

  it("ignores invalid ALAYA_BENCH_CACHE_SIZE_KIB and keeps the auto floor", async () => {
    const dataDir = await newDataDir();
    for (const spelling of ["", "nope", "0", "-65536", "65536.5", "1e6"]) {
      process.env.ALAYA_BENCH_CACHE_SIZE_KIB = spelling;
      const result = applyBenchFastPragmaIfRequested(dataDir);
      expect(result.pragmas).toContain("cache_size=-65536");
    }
    expect(readPragmaNumber(dataDir, "cache_size")).toBe(-65536);
  });

  it("scales cache_size from file size and sets mmap once the DB is large", async () => {
    const dataDir = await newDataDir();
    truncateSync(join(dataDir, "alaya.db"), 512 * 1024 * 1024);
    const result = applyBenchFastPragmaIfRequested(dataDir);
    expect(result.pragmas).toContain("cache_size=-131072");
    expect(result.pragmas).toContain("mmap_size=536870912");
    expect(readPragmaNumber(dataDir, "cache_size")).toBe(-131072);
    expect(readPragmaNumber(dataDir, "mmap_size")).toBe(536870912);
  });

  it("caps auto cache_size at 1 GiB and mmap_size at SQLite's mmap ceiling", async () => {
    const dataDir = await newDataDir();
    truncateSync(join(dataDir, "alaya.db"), 8 * 1024 * 1024 * 1024);
    const result = applyBenchFastPragmaIfRequested(dataDir);
    expect(result.pragmas).toContain("cache_size=-1048576");
    expect(result.pragmas).toContain("mmap_size=2147418112");
    expect(readPragmaNumber(dataDir, "cache_size")).toBe(-1048576);
    expect(readPragmaNumber(dataDir, "mmap_size")).toBe(2147418112);
  });

  it("sizes cache and mmap from the restored working path after a larger replace", async () => {
    const dataDir = await newDataDir();
    closeCachedDatabase(join(dataDir, "alaya.db"));
    truncateSync(join(dataDir, "alaya.db"), 512 * 1024 * 1024);
    const result = applyBenchFastPragmaIfRequested(dataDir);
    expect(result.pragmas).toContain("cache_size=-131072");
    expect(result.pragmas).toContain("mmap_size=536870912");
    expect(readPragmaNumber(dataDir, "cache_size")).toBe(-131072);
  });

  it("applies when env is explicitly truthy", async () => {
    process.env.ALAYA_BENCH_FAST_PRAGMA = "1";
    const dataDir = await newDataDir();
    const result = applyBenchFastPragmaIfRequested(dataDir);
    expect(result.applied).toBe(true);
  });

  it("skips when env is 0", async () => {
    process.env.ALAYA_BENCH_FAST_PRAGMA = "0";
    const dataDir = await newDataDir();
    const result = applyBenchFastPragmaIfRequested(dataDir);
    expect(result.applied).toBe(false);
    expect(result.pragmas).toHaveLength(0);
  });

  it("skips on common falsy spellings", async () => {
    // One migrated DB is enough: the gate only reads env. Opening five fresh
    // file DBs on Windows CI exceeds the default 5s timeout under load.
    const dataDir = await newDataDir();
    for (const spelling of ["false", "FALSE", "off", "no", " 0 "]) {
      process.env.ALAYA_BENCH_FAST_PRAGMA = spelling;
      const result = applyBenchFastPragmaIfRequested(dataDir);
      expect(result.applied).toBe(false);
    }
  });

  it("does not weaken production hardening (WAL + synchronous=NORMAL stay set)", async () => {
    const dataDir = await newDataDir();
    applyBenchFastPragmaIfRequested(dataDir);
    const db = initDatabase({ filename: join(dataDir, "alaya.db") });
    // journal_mode pragma returns string "wal" when WAL is active.
    const journalMode = db.connection.pragma("journal_mode", { simple: true });
    expect(String(journalMode).toLowerCase()).toBe("wal");
    // synchronous NORMAL = 1.
    const synchronous = db.connection.pragma("synchronous", { simple: true });
    expect(Number(synchronous)).toBe(1);
  });
});
