import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  LOCAL_ONNX_EMBEDDING_DIMENSIONS,
  LocalOnnxEmbeddingClient
} from "../../embedding-recall/local-onnx-embedding-client.js";
import {
  LocalOnnxEmbeddingChildExitedError,
  createForkLocalOnnxEmbeddingHost,
  type LocalOnnxEmbeddingIpcHost
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

  it("recycles a timed-out child before serving the next request", async () => {
    const client = openClient();
    await expect(client.embedTexts(["__hang__"], { timeoutMs: 40 })).rejects.toThrow(/timed out/);
    const vectors = await client.embedTexts(["ok"], { timeoutMs: 5_000 });
    expect(vectors).toHaveLength(1);
  });

  it("waits for the send callback when IPC reports backpressure", async () => {
    const client = openClient(backpressuredHost());
    await expect(client.embedTexts(["ok"], { timeoutMs: 5_000 })).resolves.toHaveLength(1);
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

  function openClient(host?: LocalOnnxEmbeddingIpcHost): LocalOnnxEmbeddingClient {
    const client = new LocalOnnxEmbeddingClient({
      ipcHost: host ?? createForkLocalOnnxEmbeddingHost(stubChildPath)
    });
    clients.push(client);
    return client;
  }

  function backpressuredHost(): LocalOnnxEmbeddingIpcHost {
    const inner = createForkLocalOnnxEmbeddingHost(stubChildPath);
    return {
      spawn() {
        const child = inner.spawn();
        return new Proxy(child, {
          get(target, property, receiver) {
            if (property === "send") {
              return (message: unknown, callback?: (error: Error | null) => void) => {
                target.send(message, callback);
                return false;
              };
            }
            return Reflect.get(target, property, receiver);
          }
        });
      }
    };
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
