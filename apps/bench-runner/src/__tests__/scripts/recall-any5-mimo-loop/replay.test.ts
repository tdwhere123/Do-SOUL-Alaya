import { access, chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  diagnosticArgs,
  execFileAsync,
  script,
  writeOperatorLoopHarness,
  writeReplayAwareRtk
} from "./fixture.js";

describe("recall-any5-mimo-loop replay guards", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(tmpdir(), "recall-any5-mimo-loop-replay-"));
    await chmod(script, 0o755);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("fails closed on inherited packet trace before history or loop mutation", async () => {
    const harness = await writeOperatorLoopHarness(tmpDir, "packet-trace");
    await expect(execFileAsync("bash", [script, ...diagnosticArgs(harness, false)], {
      env: { ...harness.env, ALAYA_BENCH_RECALL_PACKET_TRACE: "1" },
      timeout: 10_000
    })).rejects.toMatchObject({
      code: 2,
      stderr: expect.stringContaining("PACKET_TRACE")
    });
    await expect(access(harness.argvCapture)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(path.join(harness.workRoot, "history")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("forwards the canonical request manifest to provider-preflight", async () => {
    const harness = await writeOperatorLoopHarness(tmpDir, "replay");
    await writeReplayAwareRtk(harness.binDir);
    const result = await execFileAsync(
      "bash",
      [script, "replay", "--limit", "1"],
      { env: harness.env, timeout: 10_000 }
    );
    expect(result.stdout).toContain('"kind":"provider_preflight_replay_receipt"');
  });
});
