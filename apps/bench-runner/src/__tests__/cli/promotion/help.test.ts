import { expect, it, vi } from "vitest";
import { runCli } from "../../../cli/cli.js";

it("documents and dispatches the LongMemEval matrix authorization command", async () => {
  const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  try {
    expect(await runCli(["--help"])).toBe(0);
    expect(stdout.mock.calls.flat().join("")).toContain(
      "authorize-longmemeval-matrix --contract <json> --out <json>"
    );
    expect(await runCli([
      "authorize-longmemeval-matrix", "--contract", "matrix.json"
    ])).toBe(2);
    expect(stderr.mock.calls.flat().join("")).toContain("--out <json> required");
  } finally {
    stdout.mockRestore();
    stderr.mockRestore();
  }
});
