import type { SourceIndexProfile } from "@do-soul/alaya-protocol";
import type { SourceEmbeddingBindingOptions, SourceEmbeddingInput, SourceEmbeddingResult } from "../source-embedding-runtime.js";

type LocalOnnxSourceBinding = Readonly<{ status: "unsupported"; reason: string }> | Readonly<{
  status: "ready"; profile: SourceIndexProfile; profile_id: string; binding_id: string;
}>;
export type LocalOnnxSourceResult = Omit<Extract<SourceEmbeddingResult, { status: "embedded" }>, "vector"> &
  { readonly vector: readonly number[] } | Extract<SourceEmbeddingResult, { status: "not_embedded" }>;

export const LOCAL_ONNX_EMBEDDING_DIMENSIONS = 384;
export const LOCAL_ONNX_EMBEDDING_CHILD_PROCESS_TITLE = "alaya-local-onnx-embed";

export type LocalOnnxEmbeddingIpcOp = "warmup" | "embed" | "close" | "bind_source" | "embed_source";

export interface LocalOnnxEmbeddingIpcRequest {
  readonly id: number;
  readonly op: LocalOnnxEmbeddingIpcOp;
  readonly modelId: string;
  readonly cacheDir: string | null;
  readonly schemaVersion: number;
  readonly texts?: readonly string[];
  readonly timeoutMs?: number;
  readonly bindingOptions?: SourceEmbeddingBindingOptions;
  readonly binding_id?: string;
  readonly profile_id?: string;
  readonly inputs?: readonly SourceEmbeddingInput[];
}

export type LocalOnnxEmbeddingIpcResponse =
  | LocalOnnxEmbeddingIpcSuccess
  | LocalOnnxEmbeddingIpcFailure;

export interface LocalOnnxEmbeddingIpcSuccess {
  readonly id: number;
  readonly ok: true;
  readonly vectors?: readonly (readonly number[])[];
  readonly sourceBinding?: LocalOnnxSourceBinding;
  readonly sourceResults?: readonly LocalOnnxSourceResult[];
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
  if (!Number.isSafeInteger(record.id) || typeof record.ok !== "boolean") return false;
  if (record.ok) return true;
  const error = (value as Partial<LocalOnnxEmbeddingIpcFailure>).error;
  return typeof error?.name === "string" && typeof error.message === "string";
}

function isLocalOnnxEmbeddingIpcOp(value: unknown): value is LocalOnnxEmbeddingIpcOp {
  return value === "warmup" || value === "embed" || value === "close" || value === "bind_source" || value === "embed_source";
}

export function serializeLocalOnnxIpcError(
  error: unknown
): LocalOnnxEmbeddingIpcFailure["error"] {
  if (error instanceof Error) {
    return { name: error.name, message: error.message };
  }
  return { name: "Error", message: String(error) };
}
