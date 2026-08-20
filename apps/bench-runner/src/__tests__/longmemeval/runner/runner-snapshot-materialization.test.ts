import { beforeEach, describe, expect, it, vi } from "vitest";
import { runLongMemEval } from "../../../longmemeval/runner.js";

const mocks = vi.hoisted(() => ({
  assertAuthority: vi.fn(),
  shouldFanOut: vi.fn(),
  prepare: vi.fn(),
  execute: vi.fn(),
  finalize: vi.fn(),
  withSpool: vi.fn()
}));

vi.mock("../../../longmemeval/promotion/expansion/authority/expansion-run-authority.js", () => ({
  assertExpansionRunAuthority: mocks.assertAuthority
}));
vi.mock("../../../longmemeval/runner/runner-concurrency.js", () => ({
  shouldFanOutLongMemEvalWorkers: mocks.shouldFanOut,
  runLongMemEvalConcurrent: vi.fn()
}));
vi.mock("../../../longmemeval/runner/prepare-context.js", () => ({
  prepareLongMemEvalRun: mocks.prepare
}));
vi.mock("../../../longmemeval/runner/runner-execution.js", () => ({
  executeLongMemEvalRun: mocks.execute
}));
vi.mock("../../../longmemeval/runner/archive/runner-archive.js", () => ({
  finalizeLongMemEvalRun: mocks.finalize
}));
vi.mock("../../../bench/diagnostics/spool.js", () => ({
  withLongMemEvalDiagnosticsSpool: mocks.withSpool
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.shouldFanOut.mockReturnValue(false);
  mocks.withSpool.mockImplementation(async (run) => run({}));
  mocks.prepare.mockResolvedValue({ window: [{}, {}] });
  mocks.execute.mockResolvedValue({ collected: [] });
});

describe("LongMemEval snapshot materialization", () => {
  it("does not route a materialize-only producer through scored archive finalization", async () => {
    const result = await runLongMemEval({
      variant: "longmemeval_s",
      historyRoot: "/tmp/history",
      snapshotOut: "/tmp/snapshot.db"
    });

    expect(result).toEqual({
      snapshotPath: "/tmp/snapshot.db",
      questionCount: 2
    });
    expect(mocks.finalize).not.toHaveBeenCalled();
  });
});
