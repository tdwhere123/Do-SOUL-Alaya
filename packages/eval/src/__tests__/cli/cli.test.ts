import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runCli } from "../../cli/index.js";
import { writeEntry } from "../../history/history.js";
import { buildFullLongMemEvalPayload } from "../history/history-fixture.js";

describe("alaya-eval CLI", () => {
  let originalStdoutWrite: typeof process.stdout.write;
  let originalStderrWrite: typeof process.stderr.write;
  let stdoutBuf: string;
  let stderrBuf: string;

  beforeEach(() => {
    stdoutBuf = "";
    stderrBuf = "";
    originalStdoutWrite = process.stdout.write.bind(process.stdout);
    originalStderrWrite = process.stderr.write.bind(process.stderr);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      stdoutBuf += chunk.toString();
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderrBuf += chunk.toString();
      return true;
    }) as typeof process.stderr.write;
  });

  afterEach(() => {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
  });

  it("lists all supported bench names in help", async () => {
    const exitCode = await runCli(["--help"]);

    expect(exitCode).toBe(0);
    expect(stdoutBuf).toContain(
      "bench-name = self | public | public-multiturn | public-crossquestion | public-locomo | live"
    );
  });

  it("lists all supported bench names in invalid bench errors", async () => {
    const diffExitCode = await runCli(["diff", "unknown"]);

    expect(diffExitCode).toBe(2);
    expect(stderrBuf).toContain(
      "expected self | public | public-multiturn | public-crossquestion | public-locomo | live"
    );

    stderrBuf = "";
    const listExitCode = await runCli(["list", "unknown"]);

    expect(listExitCode).toBe(2);
    expect(stderrBuf).toContain(
      "expected self | public | public-multiturn | public-crossquestion | public-locomo | live"
    );
  });

  it("throws a usage error when --history-root is the final argument", async () => {
    await expect(runCli(["diff", "self", "--history-root"])).rejects.toThrow(
      "--history-root requires a path value"
    );
  });

  it("diffs against the newest comparable cohort instead of the adjacent archive", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "eval-cli-cohort-"));
    try {
      const layout = { historyRoot: root };
      await writeEntry(
        layout, "public", "2026-05-14T080000Z-0aaaaaa",
        buildFullLongMemEvalPayload("public", "0aaaaaa", 0.9), "report\n", null
      );
      await writeEntry(
        layout, "public", "2026-05-15T080000Z-0bbbbbb",
        {
          ...buildFullLongMemEvalPayload("public", "0bbbbbb", 0.99),
          split: "longmemeval-oracle"
        },
        "report\n", null
      );
      await writeEntry(
        layout, "public", "2026-05-16T080000Z-0cccccc",
        buildFullLongMemEvalPayload("public", "0cccccc", 0.95), "report\n", null
      );

      const exitCode = await runCli(["diff", "public", "--history-root", root]);

      expect(exitCode).toBe(0);
      expect(stdoutBuf).toContain("Alaya commit: 0cccccc");
      expect(stdoutBuf).toContain("## Δ vs previous");
      expect(stdoutBuf).toContain("| r_at_5 | 0.9000 | 0.9500 |");
      expect(stdoutBuf).not.toContain("0.9900");

      stdoutBuf = "";
      stderrBuf = "";
      await writeEntry(
        layout, "public-crossquestion", "2026-05-14T080000Z-0dddddd",
        buildFullLongMemEvalPayload("public-crossquestion", "0dddddd", 0.9),
        "report\n", null
      );
      await writeEntry(
        layout, "public-crossquestion", "2026-05-15T080000Z-0eeeeee",
        {
          ...buildFullLongMemEvalPayload("public-crossquestion", "0eeeeee", 0.95),
          split: "longmemeval-oracle"
        },
        "report\n", null
      );

      const refused = await runCli(["diff", "public-crossquestion", "--history-root", root]);

      expect(refused).toBe(2);
      expect(stdoutBuf).toBe("");
      expect(stderrBuf).toContain("no comparable previous entry");
      expect(stderrBuf).toContain("split=longmemeval-oracle");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("throws a usage error when --history-root is followed by another flag", async () => {
    await expect(runCli(["list", "self", "--history-root", "--help"])).rejects.toThrow(
      "--history-root requires a path value"
    );
  });
});
