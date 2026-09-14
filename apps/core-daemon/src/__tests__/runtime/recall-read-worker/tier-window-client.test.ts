import { describe, expect, it } from "vitest";
import type { RecallTierWindowResult } from "@do-soul/alaya-core";
import {
  RECALL_TIER_WINDOW_IPC_PAGE_SIZE,
  createTierWindowPageAssembler,
  forEachRecallTierWindowPage,
  readRecallTierWindowOverIpc
} from "../../../runtime/recall-read-worker/tier-window-client.js";
import {
  RECALL_TIER_WINDOW_IPC_MAX_CHUNK_BYTES,
  RECALL_TIER_WINDOW_IPC_MAX_CHUNK_ROWS
} from "../../../runtime/recall-read-worker/tier-window-stream.js";

function stubTierWindowPage(
  memories: ReadonlyArray<{ readonly object_id: string }>,
  next_cursor: RecallTierWindowResult["next_cursor"],
  truncated: boolean
): RecallTierWindowResult {
  return {
    memories: memories as unknown as RecallTierWindowResult["memories"],
    next_cursor,
    truncated
  };
}

describe("recall tier window IPC client pagination", () => {
  it("returns one bounded page and leaves further pages to the caller cursor", async () => {
    const requests: Array<{ limit: number; cursor?: { object_id: string } }> = [];
    const result = await readRecallTierWindowOverIpc(
      { workspaceId: "workspace-1", tier: "hot", limit: 5_001 },
      async (pageQuery) => {
        requests.push({
          limit: pageQuery.limit,
          ...(pageQuery.cursor === undefined ? {} : { cursor: pageQuery.cursor })
        });
        return stubTierWindowPage(
          Array.from({ length: pageQuery.limit }, (_, index) => ({
            object_id: `m-${index}`
          })),
          { created_at: "2026-01-01T00:00:00.000Z", object_id: "cursor" },
          true
        );
      }
    );

    expect(result.memories).toHaveLength(RECALL_TIER_WINDOW_IPC_PAGE_SIZE);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ limit: RECALL_TIER_WINDOW_IPC_PAGE_SIZE });
    expect(result.next_cursor).toEqual({
      created_at: "2026-01-01T00:00:00.000Z",
      object_id: "cursor"
    });
  });

  it("assembles one bounded page from IPC chunks without exceeding row or byte caps", () => {
    const consume = createTierWindowPageAssembler(3);
    const first = consume({
      kind: "recall-tier-window-chunk",
      memories: [{ object_id: "m-1" }, { object_id: "m-2" }],
      next_cursor: null,
      truncated: false,
      done: false
    });
    expect(first.done).toBe(false);

    const second = consume({
      kind: "recall-tier-window-chunk",
      memories: [{ object_id: "m-3" }],
      next_cursor: null,
      truncated: false,
      done: true
    });
    expect(second.done).toBe(true);
    if (!second.done) throw new Error("expected terminal page");
    expect(second.value.memories).toHaveLength(3);
    expect(() => createTierWindowPageAssembler(1)({
      kind: "recall-tier-window-chunk",
      memories: Array.from({ length: RECALL_TIER_WINDOW_IPC_MAX_CHUNK_ROWS + 1 }, (_, index) => ({
        object_id: `m-${index}`
      })),
      next_cursor: null,
      truncated: false,
      done: true
    })).toThrow(/byte bound|row bound|bounded assembler/u);

    const chunkBytes = Buffer.byteLength(JSON.stringify(
      Array.from({ length: RECALL_TIER_WINDOW_IPC_MAX_CHUNK_ROWS }, () => ({ object_id: "x".repeat(512) }))
    ), "utf8");
    expect(chunkBytes).toBeGreaterThan(RECALL_TIER_WINDOW_IPC_MAX_CHUNK_BYTES);
  });

  it("forwards page callbacks without requiring callers to aggregate IPC chunks", async () => {
    const pages: number[] = [];
    await forEachRecallTierWindowPage(
      { workspaceId: "workspace-1", tier: "hot", limit: 2_500 },
      async (pageQuery) => {
        const isFirstPage = pageQuery.cursor === undefined;
        const count = isFirstPage ? RECALL_TIER_WINDOW_IPC_PAGE_SIZE : pageQuery.limit;
        return stubTierWindowPage(
          Array.from({ length: count }, () => ({ object_id: "m-1" })),
          isFirstPage
            ? { created_at: "2026-01-01T00:00:00.000Z", object_id: "cursor" }
            : null,
          isFirstPage
        );
      },
      (page) => {
        pages.push(page.memories.length);
      }
    );
    expect(pages).toEqual([RECALL_TIER_WINDOW_IPC_PAGE_SIZE, 500]);
  });
});
