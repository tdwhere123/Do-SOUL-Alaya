import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { hashMemoryContent as protocolHashMemoryContent } from "@do-soul/alaya-protocol";
import { hashMemoryContent } from "../../embedding-recall/helpers.js";
import { hashMemoryContent as sharedHashMemoryContent } from
  "../../embedding-recall/embedding-backfill-handler-shared.js";

describe("hashMemoryContent", () => {
  it("uses the protocol sha256:hex format across backfill and storage adapters", () => {
    const content = "embedding freshness body";
    const digestHex = createHash("sha256").update(content, "utf8").digest("hex");
    const expected = `sha256:${digestHex}`;
    expect(hashMemoryContent(content)).toBe(expected);
    expect(sharedHashMemoryContent(content)).toBe(expected);
    expect(protocolHashMemoryContent(content, () => digestHex)).toBe(expected);
    expect(sharedHashMemoryContent).toBe(hashMemoryContent);
  });
});
