import { describe, expect, it } from "vitest";
import { hydrateUtf8Chunk, sourceLiteralOccurs } from "../../memory/evidence-create/source-utf8-hydrate.js";

describe("UTF-8 source hydration", () => {
  it("chunks oversized Chinese text on UTF-8 boundaries and resumes", () => {
    const content = "汉".repeat(30_000);
    const first = hydrateUtf8Chunk(content, { byteLimit: 64 });
    expect(first.status).toBe("chunk");
    if (first.status !== "chunk") return;
    expect(first.complete).toBe(false);
    expect(first.next_offset).toBe(first.end_offset);
    expect(Buffer.byteLength(first.text, "utf8")).toBeLessThanOrEqual(64);
    expect(first.end_offset % 3).toBe(0);

    const second = hydrateUtf8Chunk(content, { offset: first.next_offset ?? 0, byteLimit: 64 });
    expect(second.status).toBe("chunk");
    if (second.status !== "chunk") return;
    expect(second.start_offset).toBe(first.end_offset);
    expect(second.text.startsWith("汉")).toBe(true);
  });

  it("fails closed on a broken UTF-8 offset", () => {
    const content = "汉字";
    const broken = hydrateUtf8Chunk(content, { offset: 1, byteLimit: 8 });
    expect(broken).toEqual({ status: "unavailable", reason: "utf8_boundary" });
  });

  it("matches exact NFC literals without NFKC folding", () => {
    expect(sourceLiteralOccurs("café", "café")).toBe(true);
    expect(sourceLiteralOccurs("CAFÉ", "café")).toBe(false);
    expect(sourceLiteralOccurs("e\u0301", "é")).toBe(true);
  });
});
