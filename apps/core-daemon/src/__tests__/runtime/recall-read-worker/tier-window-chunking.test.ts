import { describe, expect, it } from "vitest";
import {
  RECALL_TIER_WINDOW_IPC_MAX_CHUNK_BYTES,
  chunkTierWindowMemories
} from "../../../runtime/recall-read-worker/tier-window-stream.js";

describe("recall tier window IPC chunks", () => {
  it("caps each multi-row chunk by encoded bytes", () => {
    const rows = Array.from({ length: 8 }, (_, index) => ({ id: index, blob: "x".repeat(80_000) }));
    const chunks = [...chunkTierWindowMemories(rows)];
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      if (chunk.length <= 1) continue;
      expect(Buffer.byteLength(JSON.stringify(chunk), "utf8"))
        .toBeLessThanOrEqual(RECALL_TIER_WINDOW_IPC_MAX_CHUNK_BYTES);
    }
  });

  it("still emits a single oversized row so the cursor can advance", () => {
    const huge = { blob: "y".repeat(RECALL_TIER_WINDOW_IPC_MAX_CHUNK_BYTES + 32) };
    const chunks = [...chunkTierWindowMemories([huge, { blob: "z" }])];
    expect(chunks[0]).toEqual([huge]);
    expect(chunks[1]).toEqual([{ blob: "z" }]);
  });
});
