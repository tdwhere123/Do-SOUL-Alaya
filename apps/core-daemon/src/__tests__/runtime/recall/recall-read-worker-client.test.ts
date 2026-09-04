import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import { Worker } from "node:worker_threads";
import { describe, expect, it } from "vitest";
import { initDatabase, SqliteMemoryEntryRepo } from "@do-soul/alaya-storage";
import { createRecallReadWorkerClient } from "../../../runtime/recall/recall-read-worker-client.js";
import {
  assertBuiltWorker,
  builtWorkerUrl,
  createMemoryEntry
} from "./recall-read-worker-client-fixture.js";

describe("RecallReadWorkerClient", () => {
  it("does not attach a leftover dist worker when default-constructed from source", async () => {
    expect(existsSync(fileURLToPath(builtWorkerUrl))).toBe(true);
    const client = createRecallReadWorkerClient({
      databaseFilename: join(tmpdir(), `alaya-source-runtime-${randomUUID()}.db`)
    });
    try {
      expect(client).toBeNull();
    } finally {
      await client?.close();
    }
  });

  it("keeps the daemon event loop available during a file-backed SQLite recall read", async () => {
    assertBuiltWorker();
    const directory = mkdtempSync(join(tmpdir(), "alaya-recall-worker-test-"));
    const databasePath = join(directory, "alaya.db");
    const database = initDatabase({ filename: databasePath });
    const repo = new SqliteMemoryEntryRepo(database);
    const workspaceId = "workspace-1";
    const rowCount = 900;

    try {
      for (let index = 0; index < rowCount; index += 1) {
        await repo.create(createMemoryEntry({
          object_id: randomUUID(),
          workspace_id: workspaceId,
          content: `Worker recall load row ${index}`,
          activation_score: 1 - index / rowCount
        }));
      }
      // Parent must release the file before the worker opens it; Windows can
      // hang worker RPC while the parent still holds the same SQLite handle.
      database.close();

      const client = createRecallReadWorkerClient({
        databaseFilename: databasePath,
        workerUrl: builtWorkerUrl
      });
      expect(client).not.toBeNull();
      if (client === null) {
        return;
      }

      try {
        await expect(client.ready()).resolves.toBeUndefined();
        const startedAt = performance.now();
        const timerDelayPromise = new Promise<number>((resolve) => {
          setTimeout(() => resolve(performance.now() - startedAt), 0);
        });
        const rowsPromise = client.memoryRepo.findByWorkspaceId(workspaceId, "hot", {
          limit: rowCount,
          offset: 0
        });

        await expect(timerDelayPromise).resolves.toBeLessThan(50);
        await expect(rowsPromise).resolves.toHaveLength(rowCount);
      } finally {
        await client.close();
      }
    } finally {
      if (!database.isClosed()) {
        database.close();
      }
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);

  it("rejects worker page requests above the bounded read limit", async () => {
    assertBuiltWorker();
    const directory = mkdtempSync(join(tmpdir(), "alaya-recall-worker-page-test-"));
    const database = initDatabase({ filename: join(directory, "alaya.db") });

    try {
      const client = createRecallReadWorkerClient({
        databaseFilename: database.filename,
        workerUrl: builtWorkerUrl
      });
      expect(client).not.toBeNull();
      if (client === null) {
        return;
      }

      try {
        await expect(
          client.memoryRepo.findByWorkspaceId("workspace-1", "hot", {
            limit: 5001,
            offset: 0
          })
        ).rejects.toThrow("page.limit must be an integer between 0 and 5000");
      } finally {
        await client.close();
      }
    } finally {
      database.close();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);

  it.skipIf(process.platform === "win32")(
    "restarts the worker after a request timeout",
    async () => {
    const directory = mkdtempSync(join(tmpdir(), "alaya-recall-worker-timeout-test-"));
    const workerPath = join(directory, "silent-worker.mjs");
    const databasePath = join(directory, "alaya.db");
    writeFileSync(
      workerPath,
      [
        'import { existsSync, writeFileSync } from "node:fs";',
        'import { parentPort, workerData } from "node:worker_threads";',
        'const marker = `${workerData.databaseFilename}.restart`;',
        'if (!existsSync(marker)) {',
        '  writeFileSync(marker, "ready", "utf8");',
        '  parentPort?.on("message", () => {});',
        '} else {',
        '  parentPort?.on("message", ({ id, operation }) => {',
        '    parentPort?.postMessage({ id, ok: true, result: operation === "close" ? null : [] });',
        '  });',
        '}',
        ''
      ].join("\n")
    );
    const client = createRecallReadWorkerClient({
      databaseFilename: databasePath,
      workerUrl: pathToFileURL(workerPath),
      workerCount: 1,
      requestTimeoutMs: 100
    });

    try {
      expect(client).not.toBeNull();
      if (client === null) {
        return;
      }

      await expect(
        client.memoryRepo.findByWorkspaceId("workspace-1", "hot", {
          limit: 1,
          offset: 0
        })
      ).rejects.toThrow("timed out after 100ms");
      await expect(client.memoryRepo.findByWorkspaceId("workspace-1")).resolves.toEqual([]);
    } finally {
      await client?.close();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);

  it("resolves close when the worker never responds to the close request", async () => {
    const directory = mkdtempSync(join(tmpdir(), "alaya-recall-worker-close-timeout-test-"));
    const workerPath = join(directory, "silent-worker.mjs");
    writeFileSync(
      workerPath,
      `import { parentPort } from "node:worker_threads";\nparentPort?.on("message", () => {});\n`
    );
    const client = createRecallReadWorkerClient({
      databaseFilename: join(directory, "alaya.db"),
      workerUrl: pathToFileURL(workerPath),
      workerCount: 1,
      requestTimeoutMs: 5
    });

    try {
      expect(client).not.toBeNull();
      if (client === null) {
        return;
      }

      await expect(client.close()).resolves.toBeUndefined();
      await expect(client.memoryRepo.findByWorkspaceId("workspace-1")).rejects.toThrow(
        "recall read worker is closed"
      );
    } finally {
      await client?.close();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);

  it("processes concurrent worker requests sequentially with intact request ids", async () => {
    assertBuiltWorker();
    const directory = mkdtempSync(join(tmpdir(), "alaya-recall-worker-serial-test-"));
    const databasePath = join(directory, "alaya.db");
    const database = initDatabase({ filename: databasePath });
    const repo = new SqliteMemoryEntryRepo(database);
    const workspaceId = "workspace-1";

    try {
      for (let index = 0; index < 40; index += 1) {
        await repo.create(createMemoryEntry({
          object_id: randomUUID(),
          workspace_id: workspaceId,
          content: `Serial worker row ${index}`,
          activation_score: 1 - index / 40
        }));
      }
      database.close();

      const worker = new Worker(fileURLToPath(builtWorkerUrl), {
        execArgv: process.execArgv.filter((arg) => !arg.startsWith("--input-type")),
        workerData: { databaseFilename: databasePath }
      });

      try {
        const responses = await collectWorkerResponses(worker, [
          {
            id: 11,
            operation: "memory.findByWorkspaceId",
            payload: {
              workspaceId,
              page: { limit: 40, offset: 0 }
            }
          },
          {
            id: 12,
            operation: "memory.findByWorkspaceId",
            payload: {
              workspaceId,
              page: { limit: 40, offset: 0 }
            }
          },
          { id: 13, operation: "ready", payload: {} }
        ]);

        expect(responses.map((response) => response.id)).toEqual([11, 12, 13]);
        expect(responses[0]).toMatchObject({ ok: true, result: expect.any(Array) });
        expect(responses[1]).toMatchObject({ ok: true, result: expect.any(Array) });
        expect(responses[2]).toMatchObject({ ok: true, result: null });
        expect((responses[0]?.result as readonly unknown[]).length).toBe(40);
        expect((responses[1]?.result as readonly unknown[]).length).toBe(40);
      } finally {
        await worker.terminate();
      }
    } finally {
      if (!database.isClosed()) {
        database.close();
      }
      rmSync(directory, { recursive: true, force: true });
    }
  }, 15_000);

  it("rejects a numeric-id message that fails request validation promptly", async () => {
    assertBuiltWorker();
    const directory = mkdtempSync(join(tmpdir(), "alaya-recall-worker-invalid-msg-"));
    const databasePath = join(directory, "alaya.db");
    const database = initDatabase({ filename: databasePath });
    database.close();

    const worker = new Worker(fileURLToPath(builtWorkerUrl), {
      execArgv: process.execArgv.filter((arg) => !arg.startsWith("--input-type")),
      workerData: { databaseFilename: databasePath }
    });

    try {
      const invalidResponse = await new Promise<unknown>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error("invalid request did not receive a prompt error response")),
          10_000
        );
        worker.once("message", (message: unknown) => {
          clearTimeout(timeout);
          resolve(message);
        });
        worker.postMessage({ id: 42, operation: 123 });
      });

      expect(invalidResponse).toEqual({
        id: 42,
        ok: false,
        error: expect.objectContaining({
          name: "Error",
          message: "invalid recall read worker request"
        })
      });

      const validResponse = await new Promise<unknown>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error("worker did not survive after invalid request")),
          2_000
        );
        worker.once("message", (message: unknown) => {
          clearTimeout(timeout);
          resolve(message);
        });
        worker.postMessage({
          id: 43,
          operation: "memory.findByIds",
          payload: { workspaceId: "workspace-1", objectIds: [] }
        });
      });

      expect(validResponse).toEqual({
        id: 43,
        ok: true,
        result: []
      });
    } finally {
      await worker.terminate();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);
});

async function collectWorkerResponses(
  worker: Worker,
  requests: readonly unknown[]
): Promise<Array<{ readonly id: number; readonly ok: boolean; readonly result?: unknown }>> {
  const responses: Array<{ readonly id: number; readonly ok: boolean; readonly result?: unknown }> = [];
  const done = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("worker responses did not arrive in time")),
      10_000
    );
    const handler = (message: unknown) => {
      const parsed = message as { readonly id: number; readonly ok: boolean; readonly result?: unknown };
      responses.push(parsed);
      if (responses.length >= requests.length) {
        clearTimeout(timeout);
        worker.off("message", handler);
        resolve();
      }
    };
    worker.on("message", handler);
    for (const request of requests) {
      worker.postMessage(request);
    }
  });
  await done;
  return responses;
}
