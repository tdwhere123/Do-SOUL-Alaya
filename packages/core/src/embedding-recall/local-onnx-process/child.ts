import { randomUUID } from "node:crypto";
import { CoreError } from "../../shared/errors.js";
import { captureSourceEmbeddingInputs, type SourceEmbeddingBinding } from "../source-embedding-runtime.js";
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
import { encodeLocalOnnxIpcVectors, encodeLocalOnnxSourceResults } from "./vectors.js";

process.title = LOCAL_ONNX_EMBEDDING_CHILD_PROCESS_TITLE;

if (typeof process.send !== "function") {
  throw new Error("local ONNX embedding child requires an IPC channel");
}

let client: LocalOnnxEmbeddingClient | null = null;
let queue: Promise<void> = Promise.resolve();
const sourceBindings = new Map<string, SourceEmbeddingBinding>();

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
    await client?.close();
    return { id: request.id, ok: true };
  }
  const runtime = childClient(request);
  if (request.op === "warmup") {
    await runtime.warmup();
    return { id: request.id, ok: true };
  }
  if (request.op === "bind_source") {
    if (!request.bindingOptions) throw new CoreError("VALIDATION", "missing Source binding options");
    const binding = await runtime.bindSourceEmbedding(structuredClone(request.bindingOptions));
    if (binding.status !== "ready") return { id: request.id, ok: true, sourceBinding: binding };
    const bindingId = randomUUID();
    // Bound retained handles; eviction produces an explicit stale binding, never a vector-only fallback.
    if (sourceBindings.size >= 16) sourceBindings.delete(sourceBindings.keys().next().value!);
    sourceBindings.set(bindingId, binding);
    return { id: request.id, ok: true, sourceBinding: { status: "ready", binding_id: bindingId,
      profile: binding.profile, profile_id: binding.profile_id } };
  }
  if (request.op === "embed_source") {
    const binding = sourceBindings.get(request.binding_id ?? "");
    if (!binding || request.profile_id !== binding.profile_id) throw new CoreError("CONFLICT", "stale or mismatched Source binding");
    if (request.inputs === undefined) throw new CoreError("VALIDATION", "missing Source embedding inputs");
    const inputs = captureSourceEmbeddingInputs(request.inputs);
    const results = await binding.embedInputs(inputs, { timeoutMs: request.timeoutMs ?? 120_000, profile_id: request.profile_id });
    return { id: request.id, ok: true, sourceResults: encodeLocalOnnxSourceResults(results),
      sourceBinding: { status: "ready", binding_id: request.binding_id!, profile: binding.profile, profile_id: binding.profile_id } };
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
  if (client !== null) {
    if (client.modelId !== request.modelId || client.schemaVersion !== request.schemaVersion) throw new CoreError("VALIDATION", "local ONNX child configuration mismatch");
    return client;
  }
  // in_process: this process already is the ORT isolate; do not fork again.
  client = new LocalOnnxEmbeddingClient({
    execution: "in_process",
    env: process.env,
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
