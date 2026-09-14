import type {
  RecallServiceMemoryRepoPort,
  RecallTierWindowCursor,
  RecallTierWindowResult
} from "@do-soul/alaya-core";
import {
  RECALL_TIER_WINDOW_IPC_MAX_CHUNK_BYTES,
  RECALL_TIER_WINDOW_IPC_MAX_CHUNK_ROWS
} from "./tier-window-stream.js";
import { RecallTierWindowChunkSchema } from "./operation-schemas.js";

const RECALL_TIER_WINDOW_CHUNK_KIND = "recall-tier-window-chunk";

export const RECALL_TIER_WINDOW_IPC_PAGE_SIZE = RECALL_TIER_WINDOW_IPC_MAX_CHUNK_ROWS;

type TierWindowQuery = Parameters<
  NonNullable<RecallServiceMemoryRepoPort["findRecallTierWindow"]>
>[0];

export type TierWindowPageConsumption = Readonly<
  | { readonly done: false }
  | { readonly done: true; readonly value: RecallTierWindowResult }
>;

export type TierWindowPageRequest = (
  pageQuery: TierWindowQuery,
  consumePage?: (value: unknown) => TierWindowPageConsumption
) => Promise<RecallTierWindowResult>;

export function createTierWindowPageAssembler(
  pageLimit: number
): (value: unknown) => TierWindowPageConsumption {
  const memories: RecallTierWindowResult["memories"][number][] = [];
  let cursor = 0;
  return (value) => {
    const chunk = parseTierWindowChunk(value);
    if (chunk.memories.length + cursor > pageLimit) {
      throw new Error("recall tier window page exceeded bounded assembler capacity");
    }
    for (const memory of chunk.memories) {
      memories[cursor] = memory;
      cursor += 1;
    }
    if (!chunk.done) return Object.freeze({ done: false });
    return Object.freeze({
      done: true,
      value: Object.freeze({
        memories: Object.freeze(memories.slice(0, cursor)),
        next_cursor: chunk.next_cursor,
        truncated: chunk.truncated
      })
    });
  };
}

export async function forEachRecallTierWindowPage(
  query: TierWindowQuery,
  requestPage: TierWindowPageRequest,
  onPage: (page: RecallTierWindowResult) => void | Promise<void>
): Promise<Readonly<{
  readonly truncated: boolean;
  readonly next_cursor: Readonly<RecallTierWindowCursor> | null;
}>> {
  let cursor = query.cursor;
  let remaining = query.limit;
  let truncated = false;
  let next_cursor: Readonly<RecallTierWindowCursor> | null = null;

  while (remaining > 0) {
    const pageLimit = Math.min(remaining, RECALL_TIER_WINDOW_IPC_PAGE_SIZE);
    const consumePage = createTierWindowPageAssembler(pageLimit);
    const page = await requestPage(
      {
        workspaceId: query.workspaceId,
        tier: query.tier,
        limit: pageLimit,
        ...(cursor === undefined ? {} : { cursor })
      },
      consumePage
    );
    await onPage(page);
    remaining -= page.memories.length;
    truncated = page.truncated;
    next_cursor = page.next_cursor;
    if (!page.truncated || page.next_cursor === null) break;
    cursor = page.next_cursor;
  }

  return Object.freeze({ truncated, next_cursor });
}

// One bounded page only — callers that need more must advance `next_cursor`.
// Do not reintroduce multi-page aggregation into a single array here.
export async function readRecallTierWindowOverIpc(
  query: TierWindowQuery,
  requestPage: TierWindowPageRequest
): Promise<RecallTierWindowResult> {
  const pageLimit = Math.min(query.limit, RECALL_TIER_WINDOW_IPC_PAGE_SIZE);
  const consumePage = createTierWindowPageAssembler(pageLimit);
  return await requestPage(
    {
      workspaceId: query.workspaceId,
      tier: query.tier,
      limit: pageLimit,
      ...(query.cursor === undefined ? {} : { cursor: query.cursor })
    },
    consumePage
  );
}

function parseTierWindowChunk(value: unknown): TierWindowChunk {
  const parsed = RecallTierWindowChunkSchema.safeParse(value);
  if (!parsed.success || parsed.data.kind !== RECALL_TIER_WINDOW_CHUNK_KIND) {
    throw new Error("invalid recall tier window chunk");
  }
  const chunkBytes = Buffer.byteLength(JSON.stringify(parsed.data.memories), "utf8");
  if (chunkBytes > RECALL_TIER_WINDOW_IPC_MAX_CHUNK_BYTES) {
    throw new Error("recall tier window chunk exceeded byte bound");
  }
  if (parsed.data.memories.length > RECALL_TIER_WINDOW_IPC_MAX_CHUNK_ROWS) {
    throw new Error("recall tier window chunk exceeded row bound");
  }
  return parsed.data as TierWindowChunk;
}

type TierWindowChunk = Readonly<{
  readonly kind: typeof RECALL_TIER_WINDOW_CHUNK_KIND;
  readonly memories: RecallTierWindowResult["memories"];
  readonly next_cursor: RecallTierWindowResult["next_cursor"];
  readonly truncated: boolean;
  readonly done: boolean;
}>;
