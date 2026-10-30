import { expect, it } from "vitest";
import { parseAuthorizeExtractionFlags } from "../../../cli/extraction-authority/args.js";

it("separates command-owned values in both forms while preserving common options", () => {
  const expected = parseAuthorizeExtractionFlags(["--variant", "s"]);
  expect(parseAuthorizeExtractionFlags([
    "--variant", "s", "--extraction-action", "fill", "--extraction-output-token-cap=512",
    "--repair-invalid-shards", "--extraction-receipt-out", "/tmp/authority.json"
  ])).toEqual(expected);
});

it("does not silently accept unknown or misspelled authority flags", () => {
  expect(() => parseAuthorizeExtractionFlags(["--extraction-output-token-cpa", "512"]))
    .toThrow("Unknown benchmark argument");
  expect(() => parseAuthorizeExtractionFlags(["--repair-invalid-shards=true"]))
    .toThrow("Unknown benchmark argument");
});

it("rejects missing values and duplicate command-owned options before filtering", () => {
  for (const args of [
    ["--extraction-action"], ["--extraction-action", "--unknown-flag"],
    ["--extraction-action="], ["--extraction-action=--unknown-flag"]
  ]) expect(() => parseAuthorizeExtractionFlags(args)).toThrow("requires a value");
  for (const args of [
    ["--extraction-action", "fill", "--extraction-action", "--unknown-flag"],
    ["--extraction-action=fill", "--extraction-action=invalid"],
    ["--repair-invalid-shards", "--repair-invalid-shards"]
  ]) expect(() => parseAuthorizeExtractionFlags(args)).toThrow("may be provided only once");
});
