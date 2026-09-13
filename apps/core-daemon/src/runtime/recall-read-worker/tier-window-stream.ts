import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import type { RecallServiceMemoryRepoPort } from "@do-soul/alaya-core";
import type { RecallReadWorkerResponse } from "./protocol.js";

export const RECALL_TIER_WINDOW_IPC_MAX_CHUNK_BYTES = 256 * 1024;
export const RECALL_TIER_WINDOW_IPC_MAX_CHUNK_ROWS = 2_000;
const RECALL_TIER_WINDOW_CHUNK_KIND = "recall-tier-window-chunk";

type TierWindowReader = NonNullable<RecallServiceMemoryRepoPort["findRecallTierWindow"]>;
type TierWindowResult = Awaited<ReturnType<TierWindowReader>>;

export function* chunkTierWindowMemories<T>(
  memories: readonly T[],
  measure: (row: T) => number = (row) => Buffer.byteLength(JSON.stringify(row), "utf8")
): Generator<readonly T[]> {
  if (memories.length === 0) {
    yield [];
    return;
  }
  let batch: T[] = [];
  let batchBytes = 0;
  for (const memory of memories) {
    const size = measure(memory);
    const wouldExceed = batch.length > 0 && (
      batch.length >= RECALL_TIER_WINDOW_IPC_MAX_CHUNK_ROWS
      || batchBytes + size > RECALL_TIER_WINDOW_IPC_MAX_CHUNK_BYTES
    );
    if (wouldExceed) {
      yield batch;
      batch = [];
      batchBytes = 0;
    }
    batch.push(memory);
    batchBytes += size;
  }
  yield batch;
}

export async function postRecallTierWindowChunks(
  id: number,
  result: TierWindowResult,
  post: (response: RecallReadWorkerResponse) => void
): Promise<void> {
  const chunks = [...chunkTierWindowMemories(result.memories)];
  for (let index = 0; index < chunks.length; index += 1) {
    const done = index + 1 >= chunks.length;
    postChunk(id, result, chunks[index] ?? [], done, post);
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
