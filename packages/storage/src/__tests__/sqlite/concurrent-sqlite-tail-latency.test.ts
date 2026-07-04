import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { measureSqliteBlockingOnEventLoop } from "../../diagnostics/sqlite-blocking-probe.js";

describe("concurrent sqlite tail latency", () => {
  const roots: string[] = [];

  afterEach(() => {
    while (roots.length > 0) {
      rmSync(roots.pop()!, { recursive: true, force: true });
    }
  });

  it("shows interleaved read tail inflation while sync work runs", () => {
    const root = mkdtempSync(join(tmpdir(), "alaya-sqlite-tail-"));
    roots.push(root);
    const db = new Database(join(root, "probe.db"));
    db.exec("CREATE TABLE probe (id INTEGER PRIMARY KEY, payload TEXT NOT NULL)");
    const insert = db.prepare("INSERT INTO probe (payload) VALUES (?)");
    const select = db.prepare("SELECT COUNT(*) AS count FROM probe");
    for (let index = 0; index < 200; index += 1) {
      insert.run(`payload-${index}`);
    }

    const result = measureSqliteBlockingOnEventLoop({
      runSyncWork: () => {
        db.transaction(() => {
          for (let index = 0; index < 50; index += 1) {
            insert.run(`sync-${index}`);
          }
        })();
      },
      runInterleavedRead: () => {
        select.get();
      },
      sampleCount: 16
    });

    expect(result.syncWorkDurationMs).toBeGreaterThan(0);
    expect(result.interleavedReadSamplesMs.length).toBe(16);
    expect(Number.isFinite(result.blockingRatioP99)).toBe(true);
    db.close();
  });
});
