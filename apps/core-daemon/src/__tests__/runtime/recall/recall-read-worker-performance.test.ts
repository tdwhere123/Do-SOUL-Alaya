import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../../../../bench-runner/src/__tests__/support/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
afterEach(() => { expect(isolation.violations).toEqual([]); });
afterAll(() => { isolation.restore(); });
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import Database from "better-sqlite3";
import { initDatabase } from "@do-soul/alaya-storage";
import { removeTempDirectorySync } from "../../../../../../packages/storage/src/__tests__/temp-directory.js";
import { createRecallReadWorkerClient } from "../../../runtime/recall/recall-read-worker-client.js";

const builtWorkerUrl = new URL("../../../../dist/runtime/recall/recall-read-worker.js", import.meta.url);

function assertBuiltWorker(): void {
  if (!existsSync(fileURLToPath(builtWorkerUrl))) {
    throw new Error("Built recall-read-worker dist missing. Run `pnpm build` before this test.");
  }
}

describe("RecallReadWorkerClient performance seams", () => {
  it("makes concurrent close callers await the same shutdown", async () => {
    const directory = mkdtempSync(join(tmpdir(), "alaya-recall-worker-close-test-"));
    const filename = join(directory, "alaya.db");
    const database = new Database(filename);
    database.exec("PRAGMA journal_mode=DELETE; CREATE TABLE transport_probe(value TEXT); INSERT INTO transport_probe VALUES ('present')");
    const posts = vi.spyOn(Worker.prototype, "postMessage");
    let client: ReturnType<typeof createRecallReadWorkerClient> = null;
    try {
      client = createRecallReadWorkerClient({
        databaseFilename: filename,
        workerUrl: new URL("./recall-read-native-lock-worker-fixture.mjs", import.meta.url),
        workerCount: 1,
        requestTimeoutMs: 30_000
      });
      expect(client).not.toBeNull();
      if (client === null) return;
      await client.ready();
      const worker = posts.mock.contexts[0] as Worker;
      expect(worker.threadId).toBeGreaterThan(0);
      let exited = false;
      worker.once("exit", () => { exited = true; });
      const events = (): Array<{ kind: string; payload?: { workspaceId?: string } }> =>
        !existsSync(`${filename}.events`) ? []
          : readFileSync(`${filename}.events`, "utf8").trim().split("\n").filter(Boolean)
            .map((line) => JSON.parse(line) as { kind: string; payload?: { workspaceId?: string } });
      database.exec("BEGIN EXCLUSIVE");
      const blocked = client.memoryRepo.findByWorkspaceId("native-lock");
      const blockedResult = expect(blocked).rejects.toThrow(/closed/);
      await expect.poll(() => events().some((event) => event.kind === "sql-enter")).toBe(true);
      const queued = client.memoryRepo.findByWorkspaceId("never-on-close");
      const queuedResult = expect(queued).rejects.toThrow(/closed/);
      let firstClosed = false;
      let secondClosed = false;
      const closing = client.close().then(() => { firstClosed = true; });
      const repeated = client.close().then(() => { secondClosed = true; });
      await Promise.all([blockedResult, queuedResult]);
      expect(database.inTransaction).toBe(true);
      expect(firstClosed).toBe(false);
      expect(secondClosed).toBe(false);
      expect(exited).toBe(false);
      expect(worker.threadId).toBeGreaterThan(0);
      expect(posts.mock.calls.some((args) => (args[0] as { operation?: string }).operation === "close")).toBe(false);
      expect(events().some((event) => event.kind === "dispatch" && event.payload?.workspaceId === "never-on-close")).toBe(false);
      database.exec("ROLLBACK");
      await Promise.all([closing, repeated]);
      expect(firstClosed).toBe(true);
      expect(secondClosed).toBe(true);
      expect(exited).toBe(true);
      expect(worker.threadId).toBe(-1);
      await expect(client.memoryRepo.findByWorkspaceId("after-close")).rejects.toThrow(/closed/);
    } finally {
      if (database.inTransaction) database.exec("ROLLBACK");
      await client?.close();
      posts.mockRestore();
      database.close();
      removeTempDirectorySync(directory);
    }
  }, 30_000);

  it("runs independent recall reads across a bounded worker pool", async () => {
    const directory = mkdtempSync(join(tmpdir(), "alaya-recall-worker-pool-test-"));
    const workerPath = join(directory, "delayed-worker.mjs");
    writeFileSync(workerPath, [
      'import { appendFileSync, readFileSync } from "node:fs";',
      'import { parentPort, workerData } from "node:worker_threads";',
      'const marker = `${workerData.databaseFilename}.requests`;',
      'parentPort?.on("message", ({ id, operation }) => {',
      '  if (operation === "close") return parentPort?.postMessage({ id, ok: true, result: null });',
      '  appendFileSync(marker, "request\\n", "utf8");',
      '  const interval = setInterval(() => {',
      '    if (readFileSync(marker, "utf8").trim().split("\\n").length < 2) return;',
      '    clearInterval(interval);',
      '    parentPort?.postMessage({ id, ok: true, result: [] });',
      '  }, 5);',
      '});',
      ''
    ].join("\n"));
    const client = createRecallReadWorkerClient({
      databaseFilename: join(directory, "alaya.db"),
      workerUrl: pathToFileURL(workerPath),
      workerCount: 2,
      requestTimeoutMs: 1_000
    });
    try {
      expect(client).not.toBeNull();
      if (client === null) return;
      await expect(Promise.all([
        client.memoryRepo.findByWorkspaceId("workspace-1"),
        client.memoryRepo.findByWorkspaceId("workspace-2")
      ])).resolves.toEqual([[], []]);
    } finally {
      await client?.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("reads active constraints through the recall worker", async () => {
    assertBuiltWorker();
    const directory = mkdtempSync(join(tmpdir(), "alaya-recall-worker-constraints-test-"));
    const databasePath = join(directory, "alaya.db");
    initDatabase({ filename: databasePath }).close();
    const client = createRecallReadWorkerClient({
      databaseFilename: databasePath,
      workerUrl: builtWorkerUrl,
      workerCount: 1
    });
    try {
      expect(client).not.toBeNull();
      if (client === null) return;
      await expect(client.activeConstraintsPort.findActiveConstraints({
        workspaceId: "workspace-1",
        cap: 5
      })).resolves.toEqual({ constraints: [], total_count: 0 });
    } finally {
      await client?.close();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);

  it("sends tier-scoped recall reads without an object-id payload", async () => {
    const directory = mkdtempSync(join(tmpdir(), "alaya-recall-worker-tier-payload-"));
    const workerPath = join(directory, "capture-worker.mjs");
    writeFileSync(workerPath, [
      'import { appendFileSync } from "node:fs";',
      'import { parentPort, workerData } from "node:worker_threads";',
      'parentPort?.on("message", ({ id, operation, payload }) => {',
      '  appendFileSync(`${workerData.databaseFilename}.payloads`, `${JSON.stringify({ operation, payload })}\\n`, "utf8");',
      '  const result = operation === "memory.findRecallTierWindow"',
      '    ? { kind: "recall-tier-window-chunk", memories: [], next_cursor: null, truncated: false, done: true }',
      '    : operation === "close" ? null : [];',
      '  parentPort?.postMessage({ id, ok: true, result });',
      '});',
      ''
    ].join("\n"));
    const databasePath = join(directory, "alaya.db");
    const client = createRecallReadWorkerClient({
      databaseFilename: databasePath,
      workerUrl: pathToFileURL(workerPath),
      workerCount: 1
    });
    try {
      expect(client).not.toBeNull();
      if (client === null) return;
      await client.memoryRepo.findRecallTierWindow!({ workspaceId: "workspace-1", tier: "hot", limit: 500 });
      await client.memoryRepo.searchByKeywordWithinTier!("workspace-1", "needle", 5, "hot");
      const messages = readFileSync(`${databasePath}.payloads`, "utf8").trim().split("\n")
        .map((line) => JSON.parse(line) as { operation: string; payload: Record<string, unknown> });
      expect(messages.map((message) => message.operation)).toEqual([
        "memory.findRecallTierWindow",
        "memory.searchByKeywordWithinTier"
      ]);
      expect(messages.every((message) => !("objectIds" in message.payload))).toBe(true);
    } finally {
      await client?.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
