import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { hashMemoryContent } from "../../embedding-recall/helpers.js";
import { hashMemoryContent as sharedHashMemoryContent } from
  "../../embedding-recall/embedding-backfill-handler-shared.js";

describe("hashMemoryContent", () => {
  it("is the single sha256:hex owner used by backfill shared", () => {
    const content = "embedding freshness body";
    const expected = `sha256:${createHash("sha256").update(content).digest("hex")}`;
    expect(hashMemoryContent(content)).toBe(expected);
    expect(sharedHashMemoryContent(content)).toBe(expected);
    expect(sharedHashMemoryContent).toBe(hashMemoryContent);
  });
});
