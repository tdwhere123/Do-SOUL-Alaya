import {
  LocalOnnxEmbeddingClient
} from "../local-onnx-embedding-client.js";
import {
  LOCAL_ONNX_EMBEDDING_CHILD_PROCESS_TITLE,
  isLocalOnnxEmbeddingIpcRequest,
  serializeLocalOnnxIpcError,
  type LocalOnnxEmbeddingIpcRequest,
  type LocalOnnxEmbeddingIpcResponse
} from "./protocol.js";
import { encodeLocalOnnxIpcVectors } from "./vectors.js";

process.title = LOCAL_ONNX_EMBEDDING_CHILD_PROCESS_TITLE;

if (typeof process.send !== "function") {
  throw new Error("local ONNX embedding child requires an IPC channel");
}

let client: LocalOnnxEmbeddingClient | null = null;
let queue: Promise<void> = Promise.resolve();

process.on("disconnect", () => {
  process.exit(0);
});

process.on("message", (message: unknown) => {
  queue = queue.then(
    () => handleChildMessage(message),
    () => handleChildMessage(message)
  );
});

async function handleChildMessage(message: unknown): Promise<void> {
  if (!isLocalOnnxEmbeddingIpcRequest(message)) {
    const id = readMessageId(message);
    if (id !== null) {
      sendChildResponse({
        id,
        ok: false,
        error: { name: "Error", message: "invalid local ONNX embedding child request" }
      });
    }
    return;
  }
  try {
    sendChildResponse(await runChildRequest(message));
    if (message.op === "close") {
      process.exit(0);
    }
  } catch (error) {
    sendChildResponse({
      id: message.id,
      ok: false,
      error: serializeLocalOnnxIpcError(error)
    });
  }
}

async function runChildRequest(
  request: LocalOnnxEmbeddingIpcRequest
): Promise<LocalOnnxEmbeddingIpcResponse> {
  if (request.op === "close") {
    return { id: request.id, ok: true };
  }
  const runtime = childClient(request);
  if (request.op === "warmup") {
    await runtime.warmup();
    return { id: request.id, ok: true };
  }
  const texts = request.texts ?? [];
  const vectors = await runtime.embedTexts(texts, {
    timeoutMs: request.timeoutMs ?? 120_000
  });
  return {
    id: request.id,
    ok: true,
    vectors: encodeLocalOnnxIpcVectors(vectors)
  };
}

function childClient(request: LocalOnnxEmbeddingIpcRequest): LocalOnnxEmbeddingClient {
  if (client !== null) return client;
  // in_process: this process already is the ORT isolate; do not fork again.
  client = new LocalOnnxEmbeddingClient({
    execution: "in_process",
    modelId: request.modelId,
    cacheDir: request.cacheDir,
    schemaVersion: request.schemaVersion
  });
  return client;
}

function sendChildResponse(response: LocalOnnxEmbeddingIpcResponse): void {
  if (typeof process.send !== "function") {
    throw new Error("local ONNX embedding child lost its IPC channel");
  }
  process.send(response);
}

function readMessageId(message: unknown): number | null {
  if (typeof message !== "object" || message === null) return null;
  const id = (message as { readonly id?: unknown }).id;
  return typeof id === "number" && Number.isInteger(id) ? id : null;
}
