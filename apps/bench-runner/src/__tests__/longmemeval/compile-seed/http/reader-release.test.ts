import { describe, expect, it, vi } from "vitest";
import { releaseGardenHttpReader } from
  "../../../../bench/compile-seed/http/stream/garden-http-reader-release.js";

describe("garden HTTP reader release", () => {
  it("releases the reader lock when stream cancellation rejects", async () => {
    const stream = new ReadableStream<Uint8Array>({
      cancel: vi.fn(async () => {
        throw new Error("cancel failed");
      })
    });
    const reader = stream.getReader();

    releaseGardenHttpReader(reader, false);

    await vi.waitFor(() => expect(stream.locked).toBe(false));
  });
});
