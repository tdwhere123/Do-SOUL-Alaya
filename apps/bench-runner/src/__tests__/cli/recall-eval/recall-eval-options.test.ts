import { describe, expect, it } from "vitest";
import { parseFlags } from "../../../cli/cli-options.js";
import { buildRecallEvalOptions } from "../../../cli/recall-eval/command.js";

describe("recall-eval CLI options", () => {
  it("forwards the requested working data root", () => {
    const flags = parseFlags([
      "--snapshot", "/tmp/source.db",
      "--data-dir-root", "/tmp/working-root"
    ]);

    expect(buildRecallEvalOptions(flags, flags.snapshot!)).toMatchObject({
      snapshotDbPath: "/tmp/source.db",
      dataDirRoot: "/tmp/working-root"
    });
  });
});
