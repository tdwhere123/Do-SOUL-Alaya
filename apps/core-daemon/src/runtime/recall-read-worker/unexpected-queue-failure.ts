import type { MessagePort } from "node:worker_threads";
import { serializeWorkerError } from "./protocol-validation.js";

/** Terminate the worker after an unexpected serial-queue rejection; client restarts fresh. */
export function reportUnexpectedQueueFailure(
  error: unknown,
  port: MessagePort | null
): void {
  const serialized = serializeWorkerError(error);
  const payload = Object.freeze({
    type: "recall_read_worker_fatal",
    reason: "unexpected_request_queue_failure",
    error: serialized
  });
  try {
    port?.postMessage(payload);
  } catch {
    // parentPort may already be broken; stderr is the fallback signal.
  }
  try {
    process.stderr.write(`${JSON.stringify(payload)}\n`);
  } catch {
    // EPIPE on a closed stderr must not skip process termination.
  } finally {
    process.exit(1);
  }
}

export function attachRecallReadRequestListener(
  port: MessagePort,
  handleRequest: (message: unknown) => Promise<void>,
  enqueue: (
    queue: Promise<void>,
    handle: () => Promise<void>,
    onUnexpectedFailure: (error: unknown) => void
  ) => Promise<void>
): void {
  let requestQueue: Promise<void> = Promise.resolve();
  port.on("message", (message: unknown) => {
    requestQueue = enqueue(
      requestQueue,
      () => handleRequest(message),
      (error) => reportUnexpectedQueueFailure(error, port)
    );
  });
}
