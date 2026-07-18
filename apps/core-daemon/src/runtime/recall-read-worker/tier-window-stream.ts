import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import type { RecallServiceMemoryRepoPort } from "@do-soul/alaya-core";
import type { RecallReadWorkerResponse } from "./protocol.js";

const RECALL_TIER_WINDOW_IPC_CHUNK_SIZE = 2_000;
const RECALL_TIER_WINDOW_CHUNK_KIND = "recall-tier-window-chunk";

type TierWindowReader = NonNullable<RecallServiceMemoryRepoPort["findRecallTierWindow"]>;
type TierWindowResult = Awaited<ReturnType<TierWindowReader>>;

export async function postRecallTierWindowChunks(
  id: number,
  result: TierWindowResult,
  post: (response: RecallReadWorkerResponse) => void
): Promise<void> {
  if (result.memories.length === 0) {
    postChunk(id, result, [], true, post);
    return;
  }
  for (let offset = 0; offset < result.memories.length; offset += RECALL_TIER_WINDOW_IPC_CHUNK_SIZE) {
    const memories = result.memories.slice(offset, offset + RECALL_TIER_WINDOW_IPC_CHUNK_SIZE);
    const done = offset + memories.length >= result.memories.length;
    postChunk(id, result, memories, done, post);
    if (!done) await yieldToEventLoop();
  }
}

function postChunk(
  id: number,
  result: TierWindowResult,
  memories: TierWindowResult["memories"],
  done: boolean,
  post: (response: RecallReadWorkerResponse) => void
): void {
  post({
    id,
    ok: true,
    result: {
      kind: RECALL_TIER_WINDOW_CHUNK_KIND,
      memories,
      next_cursor: done ? result.next_cursor : null,
      truncated: done && result.truncated,
      done
    }
  });
}
