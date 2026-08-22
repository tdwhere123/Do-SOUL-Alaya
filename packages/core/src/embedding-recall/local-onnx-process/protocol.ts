export const LOCAL_ONNX_EMBEDDING_DIMENSIONS = 384;
export const LOCAL_ONNX_EMBEDDING_CHILD_PROCESS_TITLE = "alaya-local-onnx-embed";

export type LocalOnnxEmbeddingIpcOp = "warmup" | "embed" | "close";

export interface LocalOnnxEmbeddingIpcRequest {
  readonly id: number;
  readonly op: LocalOnnxEmbeddingIpcOp;
  readonly modelId: string;
  readonly cacheDir: string | null;
  readonly schemaVersion: number;
  readonly texts?: readonly string[];
  readonly timeoutMs?: number;
}

export type LocalOnnxEmbeddingIpcResponse =
  | LocalOnnxEmbeddingIpcSuccess
  | LocalOnnxEmbeddingIpcFailure;

export interface LocalOnnxEmbeddingIpcSuccess {
  readonly id: number;
  readonly ok: true;
  readonly vectors?: readonly (readonly number[])[];
}

export interface LocalOnnxEmbeddingIpcFailure {
  readonly id: number;
  readonly ok: false;
  readonly error: Readonly<{
    readonly name: string;
    readonly message: string;
  }>;
}

export function isLocalOnnxEmbeddingIpcRequest(
  value: unknown
): value is LocalOnnxEmbeddingIpcRequest {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Partial<LocalOnnxEmbeddingIpcRequest>;
  return (
    typeof record.id === "number" &&
    Number.isInteger(record.id) &&
    isLocalOnnxEmbeddingIpcOp(record.op) &&
    typeof record.modelId === "string" &&
    (record.cacheDir === null || typeof record.cacheDir === "string") &&
    typeof record.schemaVersion === "number"
  );
}

export function isLocalOnnxEmbeddingIpcResponse(
  value: unknown
): value is LocalOnnxEmbeddingIpcResponse {
  if (typeof value !== "object" || value === null) return false;
  const record = value as { readonly id?: unknown; readonly ok?: unknown };
  return typeof record.id === "number" && typeof record.ok === "boolean";
}

function isLocalOnnxEmbeddingIpcOp(value: unknown): value is LocalOnnxEmbeddingIpcOp {
  return value === "warmup" || value === "embed" || value === "close";
}

export function serializeLocalOnnxIpcError(
  error: unknown
): LocalOnnxEmbeddingIpcFailure["error"] {
  if (error instanceof Error) {
    return { name: error.name, message: error.message };
  }
  return { name: "Error", message: String(error) };
}
