import {
  RECALL_EVAL_PAGER_CHILD_PROCESS_TITLE,
  isRecallEvalPagerIpcRequest,
  serializeRecallEvalPagerIpcError,
  type RecallEvalPagerIpcRequest,
  type RecallEvalPagerIpcResponse
} from "./protocol.js";
import {
  childMapsHint,
  closeRecallEvalPagerChild,
  openRecallEvalPagerChild,
  recallRecallEvalPagerChild
} from "./child-runtime.js";
import type {
  RecallEvalPagerOpenPayload,
  RecallEvalPagerRecallPayload
} from "./payload.js";

process.title = RECALL_EVAL_PAGER_CHILD_PROCESS_TITLE;

if (typeof process.send !== "function") {
  throw new Error("recall-eval pager child requires an IPC channel");
}

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
  if (!isRecallEvalPagerIpcRequest(message)) {
    const id = readMessageId(message);
    if (id !== null) {
      await sendChildResponse({
        id,
        ok: false,
        error: { name: "Error", message: "invalid recall-eval pager child request" }
      });
    }
    return;
  }
  try {
    await sendChildResponse(await runChildRequest(message));
    if (message.op === "close") process.exit(0);
  } catch (error) {
    await sendChildResponse({
      id: message.id,
      ok: false,
      error: serializeRecallEvalPagerIpcError(error)
    });
  }
}

async function runChildRequest(
  request: RecallEvalPagerIpcRequest
): Promise<RecallEvalPagerIpcResponse> {
  if (request.op === "close") {
    const closed = await closeRecallEvalPagerChild();
    return { id: request.id, ok: true, selectionArtifact: closed.selectionArtifact };
  }
  if (request.op === "open") {
    const opened = await openRecallEvalPagerChild(
      request.open as RecallEvalPagerOpenPayload
    );
    return {
      id: request.id,
      ok: true,
      pid: process.pid,
      mapsHint: childMapsHint(),
      evidenceProjectionRebuild: opened.evidenceProjectionRebuild,
      embeddingCacheOverlay: opened.embeddingCacheOverlay
    };
  }
  const pack = await recallRecallEvalPagerChild(
    request.recall as RecallEvalPagerRecallPayload
  );
  return {
    id: request.id,
    ok: true,
    pack,
    pid: process.pid,
    mapsHint: childMapsHint()
  };
}

function sendChildResponse(response: RecallEvalPagerIpcResponse): Promise<void> {
  if (typeof process.send !== "function") {
    throw new Error("recall-eval pager child lost its IPC channel");
  }
  return new Promise((resolve, reject) => {
    process.send?.(response, (error) => {
      if (error !== null) reject(error);
      else resolve();
    });
  });
}

function readMessageId(message: unknown): number | null {
  if (typeof message !== "object" || message === null) return null;
  const id = (message as { readonly id?: unknown }).id;
  return typeof id === "number" && Number.isInteger(id) ? id : null;
}
