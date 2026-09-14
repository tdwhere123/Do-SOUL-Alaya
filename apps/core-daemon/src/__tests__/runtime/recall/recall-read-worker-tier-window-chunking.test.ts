import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { createRecallReadWorkerClient } from "../../../runtime/recall/recall-read-worker-client.js";
import { RECALL_TIER_WINDOW_IPC_PAGE_SIZE } from "../../../runtime/recall-read-worker/tier-window-client.js";

describe("RecallReadWorkerClient tier window IPC", () => {
  it("returns one bounded page with next_cursor instead of aggregating the full window", async () => {
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
      expect(result.memories).toHaveLength(RECALL_TIER_WINDOW_IPC_PAGE_SIZE);
      expect(result.truncated).toBe(true);
      expect(result.next_cursor).toEqual({
        created_at: "2026-01-01T00:00:00.000Z",
        object_id: `m-${RECALL_TIER_WINDOW_IPC_PAGE_SIZE}`
      });
      expect(ticks).toBeGreaterThan(0);
      const requests = readFileSync(`${databasePath}.requests`, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { limit: number; cursor?: { object_id: string } });
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({ limit: RECALL_TIER_WINDOW_IPC_PAGE_SIZE });

      const second = await client.memoryRepo.findRecallTierWindow!({
        workspaceId: "workspace-1",
        tier: "hot",
        limit: 5_001,
        cursor: result.next_cursor!
      });
      expect(second.memories[0]?.object_id).toBe(`m-${RECALL_TIER_WINDOW_IPC_PAGE_SIZE}`);
      expect(second.memories).toHaveLength(RECALL_TIER_WINDOW_IPC_PAGE_SIZE);
      expect(second.next_cursor?.object_id).toBe(`m-${RECALL_TIER_WINDOW_IPC_PAGE_SIZE * 2}`);
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
      })).rejects.toThrow(/recall-tier-window-chunk/u);
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
    'const chunkRows = 500;',
    'parentPort?.on("message", ({ id, operation, payload }) => {',
    '  if (operation === "close") return parentPort?.postMessage({ id, ok: true, result: null });',
    '  appendFileSync(`${workerData.databaseFilename}.requests`, `${JSON.stringify(payload)}\\n`);',
    '  const offset = payload.cursor?.object_id?.startsWith("m-")',
    '    ? Number.parseInt(payload.cursor.object_id.slice(2), 10)',
    '    : 0;',
    '  const count = Math.min(payload.limit, total - offset);',
    '  const done = offset + count >= total;',
    '  for (let chunkOffset = 0; chunkOffset < count; chunkOffset += chunkRows) {',
    '    const chunkCount = Math.min(chunkRows, count - chunkOffset);',
    '    const chunkDone = chunkOffset + chunkCount >= count;',
    '    const memories = Array.from({ length: chunkCount }, (_, index) => ({',
    '      object_id: `m-${offset + chunkOffset + index}`',
    '    }));',
    '    parentPort?.postMessage({ id, ok: true, result: {',
    '      kind: "recall-tier-window-chunk",',
    '      memories,',
    '      next_cursor: chunkDone && !done',
    '        ? { created_at: "2026-01-01T00:00:00.000Z", object_id: `m-${offset + count}` }',
    '        : null,',
    '      truncated: chunkDone && !done,',
    '      done: chunkDone',
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
