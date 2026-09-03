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

  it("forwards process-shard concurrency", () => {
    const flags = parseFlags([
      "--snapshot", "/tmp/source.db",
      "--concurrency", "2"
    ]);

    expect(buildRecallEvalOptions(flags, flags.snapshot!)).toMatchObject({
      snapshotDbPath: "/tmp/source.db",
      concurrency: 2
    });
  });

  it("forwards --skip-recycle as a recall-eval opt-in", () => {
    const flags = parseFlags([
      "--snapshot", "/tmp/source.db",
      "--skip-recycle"
    ]);
    expect(buildRecallEvalOptions(flags, flags.snapshot!)).toMatchObject({
      skipRecycle: true
    });
  });

  it("defaults snapshot consume to promotion by omitting the option", () => {
    const flags = parseFlags(["--snapshot", "/tmp/source.db"]);
    expect(flags.snapshotConsumeAuthority).toBeUndefined();
    expect(buildRecallEvalOptions(flags, flags.snapshot!))
      .not.toHaveProperty("snapshotConsumeAuthority");
  });

  it("forwards diagnostic snapshot consume for ineligible replay", () => {
    const flags = parseFlags([
      "--snapshot", "/tmp/source.db",
      "--snapshot-consume-authority", "diagnostic"
    ]);
    expect(buildRecallEvalOptions(flags, flags.snapshot!)).toMatchObject({
      snapshotConsumeAuthority: "diagnostic"
    });
  });

  it("fail-closes unknown snapshot consume authority", () => {
    expect(() => parseFlags([
      "--snapshot", "/tmp/source.db",
      "--snapshot-consume-authority", "release"
    ])).toThrow(/must be promotion or diagnostic/);
  });
});
