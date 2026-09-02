import { describe, expect, it } from "vitest";
import { runExtractionFill } from "../../../runs/extraction/extraction-fill.js";

describe("lazy_field fill isolation", () => {
  it("rejects mixing v3 fill authority", async () => {
    await expect(runExtractionFill({
      variant: "longmemeval_s",
      ingestionMode: "lazy_field",
      semanticArtifactRoot: "/tmp/semantic-overlay",
      authorityReceiptPath: "/tmp/receipt.json"
    })).rejects.toThrow(/cannot mix v3 fill authority/u);
  });

  it("rejects overlay without a semantic artifact root", async () => {
    await expect(runExtractionFill({
      variant: "longmemeval_s",
      ingestionMode: "lazy_field"
    })).rejects.toThrow(/semantic artifact root/u);
  });
});
