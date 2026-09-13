import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { sourceTextDigest as protocolDigest } from "@do-soul/alaya-protocol";
import { sourceTextDigest as coreDigest } from "../../semantic/open-semantic-factor-formation.js";

describe("sourceTextDigest", () => {
  it("is the protocol function at the core call site", () => {
    expect(coreDigest).toBe(protocolDigest);
    expect(coreDigest("source", sha256)).toBe(`sha256:${sha256("source")}`);
  });
});

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
