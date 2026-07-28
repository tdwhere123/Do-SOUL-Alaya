import type {
  RecallReadWorkerRequest,
  RecallReadWorkerResponse
} from "./protocol.js";

type WorkerError = Extract<
  RecallReadWorkerResponse,
  { readonly ok: false }
>["error"];

export function serializeWorkerError(error: unknown): WorkerError {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      ...(error.stack === undefined ? {} : { stack: error.stack })
    };
  }
  return { name: "Error", message: String(error) };
}

export function isRecallReadWorkerRequest(value: unknown): value is RecallReadWorkerRequest {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as {
    readonly id?: unknown;
    readonly operation?: unknown;
  };
  return typeof record.id === "number" && typeof record.operation === "string";
}

export function readNumericMessageId(value: unknown): number | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const id = (value as { readonly id?: unknown }).id;
  return typeof id === "number" && Number.isFinite(id) ? id : null;
}
