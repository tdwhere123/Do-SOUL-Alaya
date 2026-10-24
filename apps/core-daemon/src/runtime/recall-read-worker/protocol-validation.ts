import { CoreError } from "@do-soul/alaya-core";
import { workerFailureDetails } from "../recall/worker-actual-cost.js";
import {
  RecallReadWorkerEnvelopeSchema,
  type RecallReadWorkerRequest,
  type RecallReadWorkerResponse
} from "./protocol.js";

type WorkerError = Extract<
  RecallReadWorkerResponse,
  { readonly ok: false }
>["error"];

/** Serialization is the owning boundary for structured failure evidence. Core keeps
 * its classification; a measured worker snapshot is added to whichever details the
 * error carries, including ordinary and frozen errors whose property write failed.
 */
export function serializeWorkerError(error: unknown): WorkerError {
  if (error instanceof Error) {
    const details = workerFailureDetails(error);
    if (error instanceof CoreError) {
      return {
        name: error.name,
        message: error.message,
        core: { code: error.code, subCode: error.subCode, details },
        ...(error.stack === undefined ? {} : { stack: error.stack })
      };
    }
    return {
      name: error.name,
      message: error.message,
      ...(details === undefined ? {} : { details }),
      ...(error.stack === undefined ? {} : { stack: error.stack })
    };
  }
  return { name: "Error", message: String(error) };
}

export function isRecallReadWorkerRequest(value: unknown): value is RecallReadWorkerRequest {
  return RecallReadWorkerEnvelopeSchema.safeParse(value).success;
}

export function readNumericMessageId(value: unknown): number | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const id = (value as { readonly id?: unknown }).id;
  return isFiniteRequestId(id) ? id : null;
}

function isFiniteRequestId(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
