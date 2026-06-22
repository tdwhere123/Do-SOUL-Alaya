import {
  buildMockDaemon,
  buildPriorLocomoPayload,
  describe,
  expect,
  it,
  startBenchDaemonMock,
  tmpDir,
  writeLocomoArchive
} from "./locomo-runner.test-support.js";
import { runLocomo } from "../../locomo/runner.js";

describe("LoCoMo runner", () => {

  it("diffs public-locomo runs against the newest passing baseline", async () => {
    const priorPassingRunAt = "2026-05-19T12:00:00.000Z";
    await writeLocomoArchive(
      tmpDir,
      "2026-05-19T120000Z-aaa1111",
      buildPriorLocomoPayload({
        run_at: priorPassingRunAt,
        alaya_commit: "aaa1111"
      })
    );
    await writeLocomoArchive(
      tmpDir,
      "2026-05-19T130000Z-bbb2222",
      buildPriorLocomoPayload({
        run_at: "2026-05-19T13:00:00.000Z",
        alaya_commit: "bbb2222"
      }),
      "# findings\n- regression\n"
    );
    startBenchDaemonMock.mockResolvedValue(buildMockDaemon({}));

    const result = await runLocomo({
      variant: "locomo10",
      historyRoot: tmpDir
    });

    expect(result.payload.diff_vs_previous?.previous_run).toBe(priorPassingRunAt);
  });
});
