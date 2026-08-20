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

  it("forwards the explicit local experiment mode", () => {
    const flags = parseFlags([
      "--snapshot", "/tmp/source.db",
      "--experiment"
    ]);

    expect(buildRecallEvalOptions(flags, flags.snapshot!)).toMatchObject({
      snapshotDbPath: "/tmp/source.db",
      experiment: true
    });
  });

  it("forwards the immutable query semantic factor cache", () => {
    const flags = parseFlags([
      "--snapshot", "/tmp/source.db",
      "--query-semantic-factor-cache", "/tmp/query-cache.json"
    ]);

    expect(buildRecallEvalOptions(flags, flags.snapshot!)).toMatchObject({
      querySemanticFactorCachePath: "/tmp/query-cache.json"
    });
  });
});
