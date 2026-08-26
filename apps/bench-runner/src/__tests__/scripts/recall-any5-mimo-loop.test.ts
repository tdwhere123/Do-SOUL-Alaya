import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  diagnosticArgs,
  execFileAsync,
  expectCacheOnlyLoopEnv,
  expectRejectedBeforeLoop,
  flagValue,
  invokeDiagnosticLoop,
  script,
  writeCompletedRecallCheckpoint,
  writeFailedRecallCheckpoint,
  writeOperatorLoopHarness,
  writeParseableRecallCheckpoint,
  writeTruncatedRecallCheckpoint
} from "./recall-any5-mimo-loop/fixture.js";

describe("recall-any5-mimo-loop", () => {
  it("refuses a window larger than 3 without an explicit confirm", async () => {
    await chmod(script, 0o755);
    await expect(execFileAsync("bash", [script, "diagnostic", "--limit", "100"], {
      timeout: 10_000
    })).rejects.toMatchObject({
      code: 2,
      stderr: expect.stringContaining("refusing limit=100")
    });
  });

  it("refuses limit>3 with confirm-window but no Canary unlock token", async () => {
    await chmod(script, 0o755);
    await expect(execFileAsync("bash", [
      script, "diagnostic", "--limit", "100", "--confirm-window", "100"
    ], { timeout: 10_000 })).rejects.toMatchObject({
      code: 2,
      stderr: expect.stringContaining("without --canary-unlock")
    });
  });

  describe("diagnostic snapshot reuse", () => {
    let tmpDir: string;

    beforeEach(async () => {
      tmpDir = await mkdtemp(path.join(tmpdir(), "recall-any5-mimo-loop-"));
      await chmod(script, 0o755);
    });

    afterEach(async () => {
      await rm(tmpDir, { recursive: true, force: true });
    });

    it("passes --snapshot to diagnostic-loop and omits --snapshot-out", async () => {
      const harness = await writeOperatorLoopHarness(tmpDir);
      const argv = await invokeDiagnosticLoop(harness, [
        "--limit",
        "1",
        "--snapshot",
        harness.snapshot,
        "--work-root",
        harness.workRoot
      ]);
      expect(flagValue(argv, "--snapshot")).toBe(harness.snapshot);
      expect(argv).not.toContain("--snapshot-out");
      await expectCacheOnlyLoopEnv(harness, argv);
    });

    it("forwards --embedding-cache-overlay to diagnostic-loop", async () => {
      const harness = await writeOperatorLoopHarness(tmpDir);
      const overlay = path.join(tmpDir, "overlay-receipt.json");
      await writeFile(overlay, "{}\n");
      const argv = await invokeDiagnosticLoop(harness, [
        "--limit",
        "1",
        "--snapshot",
        harness.snapshot,
        "--embedding-cache-overlay",
        overlay,
        "--work-root",
        harness.workRoot
      ]);
      expect(flagValue(argv, "--embedding-cache-overlay")).toBe(overlay);
      await expectCacheOnlyLoopEnv(harness, argv);
    });

    it("forwards --canary-unlock on a confirmed 100Q window", async () => {
      const harness = await writeOperatorLoopHarness(tmpDir);
      const unlock = path.join(tmpDir, "canary-3q");
      await writeFile(unlock, "");
      const argv = await invokeDiagnosticLoop(harness, [
        "--limit",
        "100",
        "--confirm-window",
        "100",
        "--canary-unlock",
        unlock,
        "--work-root",
        harness.workRoot
      ]);
      expect(flagValue(argv, "--canary-unlock")).toBe(unlock);
      await expectCacheOnlyLoopEnv(harness, argv);
    });

    it("keeps default diagnostic on --snapshot-out when reuse is not selected", async () => {
      const harness = await writeOperatorLoopHarness(tmpDir);
      const argv = await invokeDiagnosticLoop(harness, [
        "--limit",
        "1",
        "--work-root",
        harness.workRoot
      ]);
      expect(argv).not.toContain("--snapshot");
      expect(flagValue(argv, "--snapshot-out")).toBe(
        path.join(harness.workRoot, "snapshot.db")
      );
      await expectCacheOnlyLoopEnv(harness, argv);
    });

    it("refuses empty --snapshot before diagnostic-loop", async () => {
      const harness = await writeOperatorLoopHarness(tmpDir);
      await expectRejectedBeforeLoop(harness, [
        "diagnostic",
        "--limit",
        "1",
        "--snapshot",
        "",
        "--work-root",
        harness.workRoot
      ], "snapshot");
    });

    it("refuses a missing --snapshot operand before diagnostic-loop", async () => {
      const harness = await writeOperatorLoopHarness(tmpDir);
      await expectRejectedBeforeLoop(harness, [
        "diagnostic",
        "--limit",
        "1",
        "--work-root",
        harness.workRoot,
        "--snapshot"
      ], "snapshot");
    });

    it("refuses --snapshot on inspect-seed rather than ignoring it", async () => {
      const harness = await writeOperatorLoopHarness(tmpDir);
      await expectRejectedBeforeLoop(harness, [
        "inspect-seed",
        "--snapshot",
        harness.snapshot
      ], "snapshot");
    });

    it.each([
      {
        name: "default diagnostic with completed control recall",
        phase: "control_recall" as const,
        reuse: false
      },
      {
        name: "default diagnostic with completed treatment recall",
        phase: "treatment_recall" as const,
        reuse: false
      },
      {
        name: "snapshot reuse with completed control recall",
        phase: "control_recall" as const,
        reuse: true
      },
      {
        name: "snapshot reuse with completed treatment recall",
        phase: "treatment_recall" as const,
        reuse: true
      }
    ])("refuses $name", async ({ phase, reuse }) => {
      const harness = await writeOperatorLoopHarness(tmpDir, `${phase}-${reuse ? "reuse" : "default"}`);
      await writeCompletedRecallCheckpoint(harness.workRoot, phase);
      await expectRejectedBeforeLoop(
        harness,
        diagnosticArgs(harness, reuse),
        "completed recall checkpoint"
      );
    });

    it.each([
      { name: "default diagnostic", reuse: false },
      { name: "snapshot reuse", reuse: true }
    ])("refuses $name when a recall checkpoint is truncated", async ({ reuse }) => {
      const harness = await writeOperatorLoopHarness(tmpDir, `trunc-${reuse ? "reuse" : "default"}`);
      await writeTruncatedRecallCheckpoint(harness.workRoot);
      await expectRejectedBeforeLoop(harness, diagnosticArgs(harness, reuse), "checkpoint");
    });

    it("refuses snapshot reuse when the snapshot path is not a file", async () => {
      const harness = await writeOperatorLoopHarness(tmpDir);
      await expectRejectedBeforeLoop(harness, [
        "diagnostic",
        "--limit",
        "1",
        "--snapshot",
        path.join(tmpDir, "absent-snapshot.db"),
        "--work-root",
        harness.workRoot
      ], "snapshot");
    });

    it.each([
      {
        name: "default diagnostic with schema-less recall checkpoint",
        reuse: false,
        workName: "schema-default-foo",
        payload: { foo: 1 }
      },
      {
        name: "snapshot reuse with a mismatched v2 checkpoint digest",
        reuse: true,
        workName: "schema-reuse-digest",
        payload: {
          schema_version: 2,
          kind: "diagnostic_loop_checkpoint",
          phase: "control_recall",
          status: "failed",
          checkpoint_digest: "ab".repeat(32)
        }
      },
      {
        name: "default diagnostic with stale v1 checkpoint schema",
        reuse: false,
        workName: "schema-default-v1",
        payload: {
          schema_version: 1,
          kind: "diagnostic_loop_checkpoint",
          phase: "control_recall",
          status: "failed",
          checkpoint_digest: "ab".repeat(32)
        }
      }
    ])("refuses $name before diagnostic-loop", async ({ reuse, workName, payload }) => {
      const harness = await writeOperatorLoopHarness(tmpDir, workName);
      await writeParseableRecallCheckpoint(harness.workRoot, payload);
      await expectRejectedBeforeLoop(harness, diagnosticArgs(harness, reuse), "invalid");
    });

    it("rejects a historical v2 recall checkpoint as archive-only", async () => {
      const harness = await writeOperatorLoopHarness(tmpDir, "historical-v2");
      await writeParseableRecallCheckpoint(harness.workRoot, {
        schema_version: 2,
        kind: "diagnostic_loop_checkpoint",
        phase: "control_recall",
        status: "failed"
      });
      await expectRejectedBeforeLoop(
        harness,
        diagnosticArgs(harness, false),
        "historical diagnostic-loop checkpoint"
      );
    });

    it("refuses default diagnostic when work snapshot.db already exists", async () => {
      const harness = await writeOperatorLoopHarness(tmpDir, "existing-work-snapshot");
      await writeFile(path.join(harness.workRoot, "snapshot.db"), "existing-work-snapshot\n");
      await expectRejectedBeforeLoop(
        harness,
        diagnosticArgs(harness, false),
        "snapshot"
      );
    });

    it("keeps snapshot reuse when work snapshot.db already exists", async () => {
      const harness = await writeOperatorLoopHarness(tmpDir, "reuse-existing-work-snapshot");
      await writeFile(path.join(harness.workRoot, "snapshot.db"), "existing-work-snapshot\n");
      const argv = await invokeDiagnosticLoop(harness, [
        "--limit",
        "1",
        "--snapshot",
        harness.snapshot,
        "--work-root",
        harness.workRoot
      ]);
      expect(flagValue(argv, "--snapshot")).toBe(harness.snapshot);
      expect(argv).not.toContain("--snapshot-out");
    });

    it.each([
      { name: "default diagnostic", reuse: false },
      { name: "snapshot reuse", reuse: true }
    ])("forwards $name with a schema-valid failed recall checkpoint", async ({ reuse }) => {
      const harness = await writeOperatorLoopHarness(
        tmpDir,
        `failed-${reuse ? "reuse" : "default"}`
      );
      await writeFailedRecallCheckpoint(harness.workRoot);
      const argv = await invokeDiagnosticLoop(
        harness,
        reuse
          ? ["--limit", "1", "--snapshot", harness.snapshot, "--work-root", harness.workRoot]
          : ["--limit", "1", "--work-root", harness.workRoot]
      );
      if (reuse) {
        expect(flagValue(argv, "--snapshot")).toBe(harness.snapshot);
        expect(argv).not.toContain("--snapshot-out");
      } else {
        expect(argv).not.toContain("--snapshot");
        expect(flagValue(argv, "--snapshot-out")).toBe(
          path.join(harness.workRoot, "snapshot.db")
        );
      }
    });
  });
});
