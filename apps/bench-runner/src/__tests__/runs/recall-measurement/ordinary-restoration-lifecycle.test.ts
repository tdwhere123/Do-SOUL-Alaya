import { afterAll, expect, it, vi } from "vitest";
const boundary = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../support/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { withSemanticChainDaemon } from "../../../runs/recall-measurement/contract.js";
import { hashRegularFileNoFollow } from "../../../runs/snapshot/bound-file.js";
import { nativeRecallFixture } from "./native-recall.test-support.js";

afterAll(() => { expect(boundary.violations).toEqual([]); boundary.restore(); });

it("removes a successful private restore and retains a failed restore after shutdown without changing the sealed original", async () => {
  const fixture = await nativeRecallFixture("Project Aster was mentioned.");
  const config = fixture.admitted.plan.config;
  const home = process.env.HOME;
  try {
    const success = join(fixture.root, "successful-restore");
    await withSemanticChainDaemon(config, success, async daemon => {
      expect(process.env.HOME).not.toBe(home);
      expect((await daemon.mcpClient.listTools()).tools.some(tool => tool.name === "soul.recall")).toBe(true);
    });
    expect(readdirSync(success).filter(name => name.startsWith("native-session-"))).toEqual([]);
    expect(process.env.HOME).toBe(home);
    const failed = join(fixture.root, "failed-restore");
    await expect(withSemanticChainDaemon(config, failed, async daemon => {
      expect((await daemon.mcpClient.listTools()).tools.length).toBeGreaterThan(0);
      throw new Error("authored consumer failure");
    })).rejects.toThrow("authored consumer failure");
    expect(process.env.HOME).toBe(home);
    const retained = readdirSync(failed).filter(name => name.startsWith("native-session-"));
    expect(retained).toHaveLength(1);
    // Actual SQLite reopen, not a mocked shutdown assertion. No active worker
    // may retain the failed restore's write lease after the owner has returned.
    const db = new BetterSqlite3(join(failed, retained[0]!, "alaya.db"), { fileMustExist: true, timeout: 0 });
    try {
      db.exec("BEGIN EXCLUSIVE");
      expect(db.prepare("SELECT COUNT(*) AS count FROM source_records").get()).toEqual({ count: 1 });
      db.exec("ROLLBACK");
    } finally { db.close(); }
    expect(hashRegularFileNoFollow(config.snapshot_path)).toBe(config.snapshot_sha256);
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
}, 120000);
