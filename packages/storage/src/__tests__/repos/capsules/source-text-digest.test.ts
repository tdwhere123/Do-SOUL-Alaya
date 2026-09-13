import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { sourceTextDigest as protocolDigest } from "@do-soul/alaya-protocol";
import { sourceTextDigest as readDigest } from
  "../../../repos/capsules/reads/qualification/semantic-factor-formation-read.js";
import { sourceTextDigest as writeDigest } from
  "../../../repos/capsules/writes/semantic-factor-formation/capture-store.js";

describe("sourceTextDigest", () => {
  it("is the same protocol function at the storage read and write sites", () => {
    expect(readDigest).toBe(protocolDigest);
    expect(writeDigest).toBe(protocolDigest);
    expect(readDigest("source", sha256)).toBe(`sha256:${sha256("source")}`);
  });
});

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
