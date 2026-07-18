import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { initDatabase } from "@do-soul/alaya-storage";
import { createRecallReadWorkerClient } from "../../runtime/recall-read-worker-client.js";

const builtWorkerUrl = new URL("../../../dist/runtime/recall-read-worker.js", import.meta.url);

function assertBuiltWorker(): void {
  if (!existsSync(fileURLToPath(builtWorkerUrl))) {
    throw new Error("Built recall-read-worker dist missing. Run `rtk pnpm build` before this test.");
  }
}

describe("RecallReadWorkerClient performance seams", () => {
  it("makes concurrent close callers await the same shutdown", async () => {
    const directory = mkdtempSync(join(tmpdir(), "alaya-recall-worker-close-test-"));
    const workerPath = join(directory, "slow-close-worker.mjs");
    writeFileSync(workerPath, [
      'import { parentPort } from "node:worker_threads";',
      'parentPort?.on("message", ({ id, operation }) => {',
      '  if (operation === "close") {',
      '    setTimeout(() => parentPort?.postMessage({ id, ok: true, result: null }), 100);',
      '    return;',
      '  }',
      '  parentPort?.postMessage({ id, ok: true, result: [] });',
      '});',
      ''
    ].join("\n"));
    const client = createRecallReadWorkerClient({
      databaseFilename: join(directory, "alaya.db"),
      workerUrl: pathToFileURL(workerPath),
      workerCount: 1
    });
    try {
      expect(client).not.toBeNull();
      if (client === null) return;
      const first = client.close();
      let secondSettled = false;
      const second = client.close().finally(() => {
        secondSettled = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(secondSettled).toBe(false);
      await Promise.all([first, second]);
      expect(secondSettled).toBe(true);
    } finally {
      await client?.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

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
  });

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
