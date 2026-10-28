import { parentPort, workerData } from "node:worker_threads";
import { openReadOnlyDatabase } from "@do-soul/alaya-storage";
import { readCjkSegmentationStatus, warmCjkSegmentation } from "@do-soul/alaya-cjk-segmentation";
import type { RecallReadWorkerResponse } from "../recall-read-worker/protocol.js";
import type { RecallPathReadBind } from "./recall-path-read-bind.js";
import {
  isRecallReadWorkerRequest,
  readNumericMessageId,
  serializeWorkerError
} from "../recall-read-worker/protocol-validation.js";
import { enqueueRecallReadRequest } from "../recall-read-worker/request-queue.js";
import { attachRecallReadRequestListener } from "../recall-read-worker/unexpected-queue-failure.js";
import { asPayload, readString } from "../recall-read-worker/payload-readers.js";
import {
  parseWorkerOperationPayload,
  type WorkerOperationPayload
} from "../recall-read-worker/operation-schemas.js";
import { readRecallTierWindowQuery } from "../recall-read-worker/memory-window.js";
import { postRecallTierWindowChunks } from "../recall-read-worker/tier-window-stream.js";
import { runOperation } from "../recall-read-worker/dispatch.js";
import { createRecallReadWorkerRuntime } from "../recall-read-worker/runtime.js";
import { SourceSemanticObserver, SourceSemanticObservationRequestSchema } from "../recall-read-worker/source-semantic-observation.js";

if (parentPort === null) {
  throw new Error("recall read worker requires a parent port");
}

const databaseFilename = readDatabaseFilename(workerData);
const pathReadBind = readPathReadBind(workerData);
let runtime: ReturnType<typeof createRecallReadWorkerRuntime> | undefined;

function openRuntime(): ReturnType<typeof createRecallReadWorkerRuntime> {
  // Open on the first request so a parent close can release the Windows share lock first.
  runtime ??= createRecallReadWorkerRuntime(openReadOnlyDatabase(databaseFilename), pathReadBind);
  return runtime;
}

attachRecallReadRequestListener(parentPort, handleRequest, enqueueRecallReadRequest);

async function handleRequest(message: unknown): Promise<void> {
  if (!isRecallReadWorkerRequest(message)) {
    const id = readNumericMessageId(message);
    if (id !== null) {
      // Bound rejection to this id so the client does not wait for timeout cascade.
      postResponse({
        id,
        ok: false,
        error: {
          name: "Error",
          message: "invalid recall read worker request"
        }
      });
    }
    return;
  }
  const observer = message.observation === undefined ? undefined : new SourceSemanticObserver(message.id, SourceSemanticObservationRequestSchema.parse(message.observation));
  try {
    const active = openRuntime();
    // Chunked window bypasses runOperation; reject closed before a reopenable statement.
    if (active.closed && message.operation !== "close") {
      throw new Error("recall read worker database is closed");
    }
    // Native module initialization must settle before BEGIN, never from a snapshot-bound tokenizer.
    // This indexed one-row administrative probe is not source enumeration or query-time repair.
    // Unavailable initialization stays explicit at the strict reader; raw/default consumers remain fail-soft.
    if ((message.operation === "ready" || message.operation === "snapshot.beginDeferred" ||
        message.operation === "conditionalField.sourceSemantics" || message.operation === "conditionalField.recall") &&
        !active.database.connection.inTransaction &&
        readCjkSegmentationStatus() === "uninitialized" && active.database.connection.prepare(
          `SELECT 1 FROM source_index_lexical_selections WHERE representation IN ('segmented-unicode61.v1','segmented-unicode61.v2')
            AND active_generation_id IS NOT NULL LIMIT 1`).get() !== undefined) {
      await warmCjkSegmentation();
    }
    if (message.operation === "memory.findRecallTierWindow") {
      const payload: WorkerOperationPayload<"memory.findRecallTierWindow"> =
        parseWorkerOperationPayload(message.operation, message.payload);
      const result = await active.memoryEntryRepo.findRecallTierWindow(
        readRecallTierWindowQuery(payload)
      );
      await postRecallTierWindowChunks(message.id, result, postResponse);
      return;
    }
    const result = await runOperation(active, message, observer);
    postResponse({ id: message.id, ok: true, result, ...(observer === undefined ? {} : { observation: observer.finish("success") }) });
  } catch (error) {
    postResponse({
      id: message.id,
      ok: false,
      ...(observer === undefined ? {} : { observation: observer.finish("failure") }),
      error: serializeWorkerError(error)
    });
  }
}

function postResponse(response: RecallReadWorkerResponse): void {
  parentPort?.postMessage(response);
}

function readDatabaseFilename(value: unknown): string {
  const payload = asPayload(value);
  return readString(payload.databaseFilename, "databaseFilename");
}

function readPathReadBind(value: unknown): RecallPathReadBind | undefined {
  const payload = asPayload(value);
  const bind = payload.pathReadBind;
  if (bind === undefined) {
    return undefined;
  }
  if (bind !== "temporal") {
    throw new Error("worker payload pathReadBind must be temporal");
  }
  return bind;
}
