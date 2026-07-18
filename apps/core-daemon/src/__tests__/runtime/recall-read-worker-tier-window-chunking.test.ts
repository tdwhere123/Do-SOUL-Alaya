import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { createRecallReadWorkerClient } from "../../runtime/recall-read-worker-client.js";

describe("RecallReadWorkerClient tier window IPC", () => {
  it("clones a large exact window through bounded chunks while yielding the event loop", async () => {
    const directory = mkdtempSync(join(tmpdir(), "alaya-recall-window-ipc-"));
    const workerPath = join(directory, "window-worker.mjs");
    const databasePath = join(directory, "alaya.db");
    writeFileSync(workerPath, workerSource());
    const client = createRecallReadWorkerClient({
      databaseFilename: databasePath,
      workerUrl: pathToFileURL(workerPath),
      workerCount: 1
    });
    let ticks = 0;
    const ticker = setInterval(() => {
      ticks += 1;
    }, 0);
    try {
      expect(client).not.toBeNull();
      if (client === null) return;
      const result = await client.memoryRepo.findRecallTierWindow!({
        workspaceId: "workspace-1",
        tier: "hot",
        limit: 5_001
      });
      expect(result.memories).toHaveLength(5_001);
      expect(result).toMatchObject({ next_cursor: null, truncated: false });
      expect(ticks).toBeGreaterThan(0);
      const requests = readFileSync(`${databasePath}.requests`, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { limit: number; cursor?: { object_id: string } });
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({ limit: 5_001 });
    } finally {
      clearInterval(ticker);
      await client?.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects a malformed chunk and recovers with a fresh worker", async () => {
    const directory = mkdtempSync(join(tmpdir(), "alaya-recall-window-protocol-"));
    const workerPath = join(directory, "window-worker.mjs");
    writeFileSync(workerPath, malformedWorkerSource());
    const client = createRecallReadWorkerClient({
      databaseFilename: join(directory, "alaya.db"),
      workerUrl: pathToFileURL(workerPath),
      workerCount: 1
    });
    try {
      expect(client).not.toBeNull();
      if (client === null) return;
      await expect(client.memoryRepo.findRecallTierWindow!({
        workspaceId: "malformed",
        tier: "hot",
        limit: 1
      })).rejects.toThrow("invalid recall tier window chunk");
      await expect(client.memoryRepo.findRecallTierWindow!({
        workspaceId: "healthy",
        tier: "hot",
        limit: 1
      })).resolves.toMatchObject({ memories: [{ object_id: "memory-1" }] });
    } finally {
      await client?.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

function workerSource(): string {
  return [
    'import { appendFileSync } from "node:fs";',
    'import { parentPort, workerData } from "node:worker_threads";',
    'const total = 5001;',
    'parentPort?.on("message", ({ id, operation, payload }) => {',
    '  if (operation === "close") return parentPort?.postMessage({ id, ok: true, result: null });',
    '  appendFileSync(`${workerData.databaseFilename}.requests`, `${JSON.stringify(payload)}\n`);',
    '  for (let offset = 0; offset < total; offset += 2000) {',
    '    const count = Math.min(2000, total - offset);',
    '    const done = offset + count >= total;',
    '    const memories = Array.from({ length: count }, (_, index) => ({ object_id: `m-${offset + index}` }));',
    '    parentPort?.postMessage({ id, ok: true, result: {',
    '      kind: "recall-tier-window-chunk", memories, next_cursor: null, truncated: false, done',
    '    } });',
    '  }',
    '});',
    ''
  ].join("\n");
}

function malformedWorkerSource(): string {
  return [
    'import { parentPort } from "node:worker_threads";',
    'parentPort?.on("message", ({ id, operation, payload }) => {',
    '  if (operation === "close") return parentPort?.postMessage({ id, ok: true, result: null });',
    '  const result = payload.workspaceId === "malformed"',
    '    ? { kind: "old-tier-window-result" }',
    '    : { kind: "recall-tier-window-chunk", memories: [{ object_id: "memory-1" }],',
    '        next_cursor: null, truncated: false, done: true };',
    '  parentPort?.postMessage({ id, ok: true, result });',
    '});',
    ''
  ].join("\n");
}
