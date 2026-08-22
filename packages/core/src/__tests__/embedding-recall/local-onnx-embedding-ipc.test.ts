import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  LOCAL_ONNX_EMBEDDING_DIMENSIONS,
  LocalOnnxEmbeddingClient
} from "../../embedding-recall/local-onnx-embedding-client.js";
import {
  LocalOnnxEmbeddingChildExitedError,
  createForkLocalOnnxEmbeddingHost
} from "../../embedding-recall/local-onnx-process/ipc-client.js";

const stubChildPath = fileURLToPath(
  new URL("./local-onnx-embedding-ipc-stub-child.mjs", import.meta.url)
);

describe("LocalOnnxEmbeddingClient IPC isolation", () => {
  const clients: LocalOnnxEmbeddingClient[] = [];

  afterEach(async () => {
    const pending = clients.splice(0);
    await Promise.all(pending.map((client) => client.close()));
  });

  it("returns vectors from the child without loading a pipeline in the parent", async () => {
    const client = openClient();
    const vectors = await client.embedTexts(["ok"], { timeoutMs: 5_000 });
    expect(vectors).toHaveLength(1);
    expect(vectors[0]!.length).toBe(LOCAL_ONNX_EMBEDDING_DIMENSIONS);
    expect(parentMapsOnnxRuntime()).toBe(false);
  });

  it("fail-closes when the child exits mid-request", async () => {
    const client = openClient();
    await expect(client.embedTexts(["__crash__"], { timeoutMs: 5_000 })).rejects.toBeInstanceOf(
      LocalOnnxEmbeddingChildExitedError
    );
    await expect(client.embedTexts(["ok"], { timeoutMs: 5_000 })).rejects.toBeInstanceOf(
      LocalOnnxEmbeddingChildExitedError
    );
  });

  it("fail-closes when the child never replies", async () => {
    const client = openClient();
    await expect(client.embedTexts(["__hang__"], { timeoutMs: 40 })).rejects.toThrow(/timed out/);
  });

  it("fail-closes when the child returns no vectors", async () => {
    const client = openClient();
    await expect(client.embedTexts(["__empty__"], { timeoutMs: 5_000 })).rejects.toThrow(
      /0 vectors for 1 inputs/
    );
  });

  it("fail-closes when the child returns an empty row", async () => {
    const client = openClient();
    await expect(client.embedTexts(["__empty_row__"], { timeoutMs: 5_000 })).rejects.toThrow(
      /row 0 was empty/
    );
  });

  function openClient(): LocalOnnxEmbeddingClient {
    const client = new LocalOnnxEmbeddingClient({
      ipcHost: createForkLocalOnnxEmbeddingHost(stubChildPath)
    });
    clients.push(client);
    return client;
  }
});

function parentMapsOnnxRuntime(): boolean {
  if (process.platform !== "linux") return false;
  try {
    const maps = readProcSelfMaps();
    return /onnxruntime/i.test(maps);
  } catch {
    return false;
  }
}

function readProcSelfMaps(): string {
  return readFileSync("/proc/self/maps", "utf8");
}
