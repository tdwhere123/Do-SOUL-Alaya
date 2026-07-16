import { describe, expect, it } from "vitest";
import { parseLongMemEvalMatrixPromotionCommandOptions } from
  "../../../cli/promotion/options.js";

describe("LongMemEval matrix promotion CLI options", () => {
  it("parses only the command-specific contract and output paths", () => {
    expect(parseLongMemEvalMatrixPromotionCommandOptions([
      "--contract", "matrix.json", "--out=authorization.json"
    ])).toEqual({ contractPath: "matrix.json", outputPath: "authorization.json" });
  });

  it.each([
    [[], /--contract <json> required/u],
    [["--contract", "matrix.json"], /--out <json> required/u],
    [["--contract", "matrix.json", "--out"], /--out requires a value/u],
    [["--contract", "a", "--contract", "b", "--out", "c"], /duplicate --contract/u],
    [["--contract", "a", "--out", "b", "--force"], /unknown option '--force'/u],
    [["matrix.json", "--out", "b"], /unexpected argument 'matrix.json'/u]
  ])("rejects malformed argv %#", (argv, message) => {
    expect(() => parseLongMemEvalMatrixPromotionCommandOptions(argv as string[]))
      .toThrow(message as RegExp);
  });
});
