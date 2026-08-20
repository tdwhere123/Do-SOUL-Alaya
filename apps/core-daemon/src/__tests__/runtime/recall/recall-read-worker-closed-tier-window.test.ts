import { describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => {
  const posted: unknown[] = [];
  const findRecallTierWindow = vi.fn();
  let handleRequest: ((message: unknown) => Promise<void>) | undefined;
  class SqliteMemoryEntryRepo {
    public readonly findRecallTierWindow = findRecallTierWindow;
  }
  class UnusedRepo {}
  return {
    posted,
    findRecallTierWindow,
    closeDatabase: vi.fn(),
    parentPort: {
      postMessage(message: unknown) {
        posted.push(message);
      }
    },
    SqliteMemoryEntryRepo,
    UnusedRepo,
    captureHandleRequest(handle: (message: unknown) => Promise<void>) {
      handleRequest = handle;
    },
    capturedHandleRequest() {
      if (handleRequest === undefined) {
        throw new Error("attachRecallReadRequestListener did not receive a handler");
      }
      return handleRequest;
    }
  };
});

vi.mock("node:worker_threads", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:worker_threads")>();
  return {
    ...actual,
    parentPort: hoisted.parentPort,
    workerData: { databaseFilename: "recall-read-worker-closed.db" }
  };
});

vi.mock("@do-soul/alaya-storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@do-soul/alaya-storage")>();
  return {
    ...actual,
    initDatabase: () => ({
      connection: { pragma() {} },
      close: hoisted.closeDatabase
    }),
    SqliteMemoryEntryRepo: hoisted.SqliteMemoryEntryRepo,
    SqliteEvidenceCapsuleRepo: hoisted.UnusedRepo,
    SqliteSynthesisCapsuleRepo: hoisted.UnusedRepo,
    SqliteClaimFormRepo: hoisted.UnusedRepo
  };
});

vi.mock("../../../runtime/recall/recall-path-read-bind.js", () => ({
  createBoundRecallPathReadPorts: () => ({})
}));

vi.mock("../../../runtime/recall-read-worker/unexpected-queue-failure.js", () => ({
  attachRecallReadRequestListener(
    _port: unknown,
    handleRequest: (message: unknown) => Promise<void>
  ) {
    hoisted.captureHandleRequest(handleRequest);
  }
}));

import "../../../runtime/recall/recall-read-worker.js";

describe("recall read worker closed runtime", () => {
  it("rejects a later tier-window request before the chunked special-case can reopen", async () => {
    const handleRequest = hoisted.capturedHandleRequest();
    await handleRequest({ id: 1, operation: "close", payload: {} });
    expect(hoisted.posted[0]).toEqual({ id: 1, ok: true, result: null });
    expect(hoisted.closeDatabase).toHaveBeenCalledTimes(1);

    await handleRequest({
      id: 2,
      operation: "memory.findRecallTierWindow",
      payload: { workspaceId: "workspace-1", tier: "hot", limit: 1 }
    });
    expect(hoisted.posted[1]).toEqual(expect.objectContaining({
      id: 2,
      ok: false,
      error: expect.objectContaining({
        name: "Error",
        message: "recall read worker database is closed"
      })
    }));
    expect(hoisted.findRecallTierWindow).not.toHaveBeenCalled();
  });
});
