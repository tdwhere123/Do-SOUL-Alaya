import { parentPort, workerData } from "node:worker_threads";
import {
  initDatabase,
  SqliteClaimFormRepo,
  SqliteEvidenceCapsuleRepo,
  SqliteMemoryEntryRepo,
  SqliteSynthesisCapsuleRepo
} from "@do-soul/alaya-storage";
import { verifyOfficialApiSourceLocatorBinding } from "@do-soul/alaya-soul";
import type { RecallReadWorkerResponse } from "../recall-read-worker/protocol.js";
import {
  createBoundRecallPathReadPorts,
  type RecallPathReadBind
} from "./recall-path-read-bind.js";
import {
  isRecallReadWorkerRequest,
  readNumericMessageId,
  serializeWorkerError
} from "../recall-read-worker/protocol-validation.js";
import { enqueueRecallReadRequest } from "../recall-read-worker/request-queue.js";
import { attachRecallReadRequestListener } from "../recall-read-worker/unexpected-queue-failure.js";
import { asPayload, readString } from "../recall-read-worker/payload-readers.js";
import { readRecallTierWindowQuery } from "../recall-read-worker/memory-window.js";
import { postRecallTierWindowChunks } from "../recall-read-worker/tier-window-stream.js";
import { runOperation } from "../recall-read-worker/dispatch.js";
import type { RecallReadWorkerRuntime } from "../recall-read-worker/runtime.js";

if (parentPort === null) {
  throw new Error("recall read worker requires a parent port");
}

const databaseFilename = readDatabaseFilename(workerData);
const database = initDatabase({ filename: databaseFilename });
database.connection.pragma("query_only = ON");
const runtime: RecallReadWorkerRuntime = {
  database,
  memoryEntryRepo: new SqliteMemoryEntryRepo(database),
  evidenceCapsuleRepo: new SqliteEvidenceCapsuleRepo(
    database,
    verifyOfficialApiSourceLocatorBinding
  ),
  synthesisCapsuleRepo: new SqliteSynthesisCapsuleRepo(database),
  claimFormRepo: new SqliteClaimFormRepo(database),
  recallPathReadPorts: createBoundRecallPathReadPorts({
    database,
    pathReadBind: readPathReadBind(workerData)
  }),
  closed: false
};

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
  try {
    if (message.operation === "memory.findRecallTierWindow") {
      const result = await runtime.memoryEntryRepo.findRecallTierWindow(
        readRecallTierWindowQuery(asPayload(message.payload))
      );
      await postRecallTierWindowChunks(message.id, result, postResponse);
      return;
    }
    const result = await runOperation(runtime, message);
    postResponse({ id: message.id, ok: true, result });
  } catch (error) {
    postResponse({
      id: message.id,
      ok: false,
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
