import { describe, expect, it } from "vitest";

import { parseEvidenceSourceChunkRef } from "../../recall/coarse-filter/coarse-candidates.js";

describe("parseEvidenceSourceChunkRef", () => {
  describe("default (turn/chunk only) — unchanged behavior", () => {
    it("parses session-turn refs", () => {
      expect(parseEvidenceSourceChunkRef("doc-s3-t4")).toEqual({
        sourceKey: "doc|session:3",
        chunkIndex: 4
      });
    });

    it("parses trailing chunk/turn/t refs", () => {
      expect(parseEvidenceSourceChunkRef("doc-chunk7")).toEqual({ sourceKey: "doc", chunkIndex: 7 });
      expect(parseEvidenceSourceChunkRef("doc-turn2")).toEqual({ sourceKey: "doc", chunkIndex: 2 });
    });

    it("does NOT parse round-labeled or per-fact refs (proximity stays inert)", () => {
      expect(parseEvidenceSourceChunkRef("q-s3-r2")).toBeNull();
      expect(parseEvidenceSourceChunkRef("q-s3-r2-f1")).toBeNull();
      expect(parseEvidenceSourceChunkRef("q-s3-t2-f1")).toBeNull();
    });
  });

  describe("robust=true — also round-labeled + per-fact suffix", () => {
    it("keeps every default format byte-identical", () => {
      expect(parseEvidenceSourceChunkRef("doc-s3-t4", true)).toEqual({
        sourceKey: "doc|session:3",
        chunkIndex: 4
      });
      expect(parseEvidenceSourceChunkRef("doc-chunk7", true)).toEqual({ sourceKey: "doc", chunkIndex: 7 });
    });

    it("parses round-labeled session refs", () => {
      expect(parseEvidenceSourceChunkRef("q-s3-r2", true)).toEqual({
        sourceKey: "q|session:3",
        chunkIndex: 2
      });
    });

    it("strips a per-fact suffix so a round's facts share one (sourceKey, chunkIndex)", () => {
      const a = parseEvidenceSourceChunkRef("q-s3-r2-f0", true);
      const b = parseEvidenceSourceChunkRef("q-s3-r2-f7", true);
      expect(a).toEqual({ sourceKey: "q|session:3", chunkIndex: 2 });
      expect(a).toEqual(b);
    });

    it("still returns null for refs without any turn/round marker", () => {
      expect(parseEvidenceSourceChunkRef("a39f9bd8-a785-46d8-8d1f-d36a11095aaa", true)).toBeNull();
    });
  });
});
