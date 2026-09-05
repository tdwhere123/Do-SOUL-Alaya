import { access, chmod, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { removeTempDirectory } from "../../support/temp-cleanup.js";
import {
  diagnosticArgs,
  expectCacheOnlyLoopEnv,
  execFileAsync,
  invokeDiagnosticLoop,
  replayReceiptFixture,
  script,
  writeOperatorLoopHarness,
  writeReplayAwareNode
} from "./fixture.js";

describe("recall-any5-mimo-loop replay guards", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(tmpdir(), "recall-any5-mimo-loop-replay-"));
    await chmod(script, 0o755);
  });

  afterEach(async () => {
    await removeTempDirectory(tmpDir);
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

  it("forwards the credentialless product formation route to diagnostic-loop", async () => {
    const harness = await writeOperatorLoopHarness(tmpDir, "credentialless-formation");
    const argv = await invokeDiagnosticLoop(harness, [
      "--limit", "1", "--snapshot", harness.snapshot, "--work-root", harness.workRoot
    ]);

    await expectCacheOnlyLoopEnv(harness, argv);
  });

  it("forwards the canonical request manifest to provider-preflight", async () => {
    const harness = await writeOperatorLoopHarness(tmpDir, "replay");
    await writeReplayAwareNode(harness.binDir);
    const result = await execFileAsync(
      "bash",
      [script, "replay", "--limit", "1"],
      { env: harness.env, timeout: 10_000 }
    );
    expect(result.stdout).toContain('"kind":"provider_preflight_replay_receipt"');
  });

  it.each([
    ["legacy v1", { ...replayReceiptFixture(), schema_version: 1 }],
    ["minimal", {
      schema_version: 2,
      kind: "provider_preflight_replay_receipt",
      provider_port: "absent",
      physical_calls: 0
    }],
    ["extra key", { ...replayReceiptFixture(), note: "loose evidence" }],
    ["wrong model", { ...replayReceiptFixture(), model: "other-model" }],
    ["wrong profile", { ...replayReceiptFixture(), profile: "provider-default-v1" }],
    ["wrong key count", { ...replayReceiptFixture(), key_count: 999 }],
    ["wrong request digest", {
      ...replayReceiptFixture(), request_manifest_sha256: "1".repeat(64)
    }],
    ["wrong cache digest", {
      ...replayReceiptFixture(), cache_manifest_sha256: "2".repeat(64)
    }],
    ["prior template", {
      ...replayReceiptFixture(),
      evidence_request_template_sha256:
        "38fa28af7f5d2a1895cc6cd6879ba3de827800c2713af054f976d3175a348200"
    }]
  ])("rejects a %s provider replay receipt", async (_label, receipt) => {
    const harness = await writeOperatorLoopHarness(tmpDir, "replay-invalid-receipt");
    await writeReplayAwareNode(harness.binDir, receipt);

    await expect(execFileAsync(
      "bash",
      [script, "replay", "--limit", "1"],
      { env: harness.env, timeout: 10_000 }
    )).rejects.toMatchObject({ code: 1 });
  });
});
