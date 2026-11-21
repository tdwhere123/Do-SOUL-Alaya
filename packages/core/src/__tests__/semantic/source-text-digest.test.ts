import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { sourceTextDigest as protocolDigest } from "@do-soul/alaya-protocol";
import { materializeOpenSemanticFactorFormation } from "../../semantic/open-semantic-factor-formation.js";

describe("sourceTextDigest", () => {
  it("uses the protocol digest for optional offline semantic formation", () => {
    const source = "source corpus";
    const expected = protocolDigest(source, sha256);
    expect(expected).toBe(`sha256:${sha256(source)}`);

    const coreCapture = materializeOpenSemanticFactorFormation({
      source_kind: "evidence",
      source_text: source,
      negative_status: "ineligible"
    });
    expect(coreCapture.source_sha256).toBe(expected);
  });
});

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
