import {
  existsSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync
} from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { removeTempDirectory } from "../../support/temp-cleanup.js";
import {
  isObserved,
  observedNumber,
  P00_PERFORMANCE_PROOF_CONTRACT
} from "../../../runs/lifecycle/recall-eval/performance-proof/attribution-receipt.js";
import {
  applyMeasuredWorkspaceInstall,
  CLOCK_A_REASON,
  CLONE_REUSE_PROVED,
  forceReflinkCopyFile,
  P02_WORKSPACE_INSTALL_CONTRACT,
  phaseByName,
  PHYSICAL_BYTES_REASON,
  WORKSPACE_INSTALL_PHASES,
  WorkspaceInstallFailClosedError,
  workspaceInstallTargetPath,
  type WorkspaceInstallIoReceipt
} from "../../../runs/lifecycle/recall-eval/workspace-install/install.js";
import {
  measureProviderFreeWorkspaceInstallBothModes,
  plantProviderFreeWorkspaceFixture,
  runProviderFreeWorkspaceInstall
} from "../../../runs/lifecycle/recall-eval/workspace-install/provider-free.js";

const roots: string[] = [];
// Windows cannot rename/replace a source still held O_RDONLY by copy.
const win32OpenCopyReasons = process.platform === "win32" ? ["partial-copy"] : [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => removeTempDirectory(root)));
});

describe("P02 workspace-install contract", () => {
  it("cites the P00 attribution and exact-parity contract", () => {
    expect(P02_WORKSPACE_INSTALL_CONTRACT.cites).toBe(P00_PERFORMANCE_PROOF_CONTRACT.name);
    expect(P02_WORKSPACE_INSTALL_CONTRACT.cites).toBe(
      "recall-eval-performance-attribution-and-exact-parity.v1"
    );
    expect(CLONE_REUSE_PROVED).toBe(false);
  });
});

describe("A1 forced reflink and copy-fallback phase attribution", () => {
  it("reports receipt-read, bytes, fsync, reopen, reload, and cleanup on both modes", async () => {
    const measured = await measureProviderFreeWorkspaceInstallBothModes();
    const reflinkReport = reportPhases(measured.reflink.io);
    const fallbackReport = reportPhases(measured.copyFallback.io, "copy_fallback");

    expect(fallbackReport.cloneMode).toBe("copy_fallback");
    expect(["reflink", "copy_fallback"]).toContain(reflinkReport.cloneMode);
    expect(reflinkReport.counts).toEqual(fallbackReport.counts);
    expect(reflinkReport.counts).toEqual({
      receipt_read: 1,
      clone_copy: 1,
      fsync: 1,
      sqlite_reopen: 1,
      daemon_reload: 1,
      cleanup: 1
    });
    expect(reflinkReport.logicalBytes).toBe(21);
    expect(fallbackReport.logicalBytes).toBe(21);
    expect(reflinkReport.physicalBytesWritten).toEqual({
      status: "not_observed",
      reason: PHYSICAL_BYTES_REASON
    });
    expect(fallbackReport.physicalBytesWritten).toEqual({
      status: "not_observed",
      reason: PHYSICAL_BYTES_REASON
    });
    expect("value" in (reflinkReport.physicalBytesWritten as object)).toBe(false);
    expect("value" in (fallbackReport.physicalBytesWritten as object)).toBe(false);
    expect(measured.decision).toMatchObject({
      status: "NO_OPTIMIZATION_JUSTIFIED",
      cloneReuseProved: false,
      copyFsyncDominant: "not_verified"
    });
    if (measured.decision.status !== "NO_OPTIMIZATION_JUSTIFIED") {
      throw new Error("workspace install must remain unoptimized until clone reuse is proved");
    }
    expect(measured.decision.reason).toMatch(/clone reuse is not independently proved/u);
    expect(measured.decision.reason).toMatch(/NOT_VERIFIED/u);
    expect(measured.reflink.io.clockAMs).toEqual({
      status: "not_observed",
      reason: CLOCK_A_REASON
    });
    expect("value" in measured.reflink.io.clockAMs).toBe(false);
    expect(measured.reflink.io.diskPhaseMs.status).toBe("observed");
    expect(measured.decision.status).toBe("NO_OPTIMIZATION_JUSTIFIED");
    expect(measured.decision.cloneReuseProved).toBe(false);
    expect(measured.reflink.leaks).toEqual({
      liveChildPids: [],
      remainingTempPaths: [],
      remainingWalPaths: [],
      remainingShmPaths: []
    });
  });

  it("keeps injected Clock-A 0 observed and separate from disk phase", async () => {
    const run = await runProviderFreeWorkspaceInstall({
      copyFile: forceReflinkCopyFile(),
      clockAMs: observedNumber(0)
    });
    expect(run.io.clockAMs).toEqual({ status: "observed", value: 0 });
    expect(run.io.diskPhaseMs.status).toBe("observed");
    expect(run.io.role).toBe("diagnostic_only");
  });
});

describe("A2 sealed source and private WAL/SHM", () => {
  it("leaves sealed bytes unchanged and binds WAL/SHM to one worker and question", async () => {
    const root = await tempRoot();
    const planted = plantProviderFreeWorkspaceFixture(root);
    const sourceBytes = readFileSync(planted.sourcePath);
    const first = applyMeasuredWorkspaceInstall(installInput(planted, "worker-a", "q1"));
    const second = applyMeasuredWorkspaceInstall(installInput(planted, "worker-a", "q2"));

    expect(readFileSync(planted.sourcePath)).toEqual(sourceBytes);
    expect(first.sourceIno).toBe(planted.sourceIno);
    expect(first.targetIno).not.toBe(first.sourceIno);
    expect(second.targetIno).not.toBe(first.targetIno);
    expect(first.walPath).toBe(`${first.targetPath}-wal`);
    expect(first.shmPath).toBe(`${first.targetPath}-shm`);
    expect(first.walPath).not.toBe(second.walPath);
    expect(existsSync(`${planted.sourcePath}-wal`)).toBe(false);
    expect(first.walPath.startsWith(join(root, "working", "worker-a", "q1"))).toBe(true);
    expect(second.walPath.startsWith(join(root, "working", "worker-a", "q2"))).toBe(true);
    expect(() => applyMeasuredWorkspaceInstall(installInput(planted, "worker-a", "q1")))
      .toThrow(WorkspaceInstallFailClosedError);
  });
});

describe("A3 fail-closed cleans temporary state", () => {
  it("fails closed on stale receipt, drift, partial copy, inode replacement, fsync, and reopen", async () => {
    await expectFailClosed("stale-receipt", (planted, questionId) => {
      writeFileSync(planted.receiptPath, JSON.stringify({
        sourceSha256: "0".repeat(64),
        overlaySha256: planted.overlayDigest
      }));
      applyMeasuredWorkspaceInstall(installInput(planted, "worker-a", questionId));
    });
    await expectFailClosed("source-drift", (planted, questionId) => {
      applyMeasuredWorkspaceInstall({
        ...installInput(planted, "worker-a", questionId),
        copyFile: forceReflinkCopyFile((source, dest) => {
          writeFileSync(planted.sourcePath, "drifted-source-bytes\n");
          writeFileSync(dest, readFileSync(source));
        })
      });
    }, win32OpenCopyReasons);
    await expectFailClosed("partial-copy", (planted, questionId) => {
      applyMeasuredWorkspaceInstall({
        ...installInput(planted, "worker-a", questionId),
        copyFile: forceReflinkCopyFile((_source, dest) => {
          writeFileSync(dest, "x");
          throw new Error("partial copy");
        })
      });
    });
    await expectFailClosed("inode-replacement", (planted, questionId) => {
      applyMeasuredWorkspaceInstall({
        ...installInput(planted, "worker-a", questionId),
        copyFile: forceReflinkCopyFile((source, dest) => {
          const original = `${planted.sourcePath}.original`;
          renameSync(planted.sourcePath, original);
          writeFileSync(planted.sourcePath, "untrusted replacement");
          writeFileSync(dest, readFileSync(source));
        })
      });
    }, win32OpenCopyReasons);
    await expectFailClosed("fsync-failure", (planted, questionId) => {
      applyMeasuredWorkspaceInstall({
        ...installInput(planted, "worker-a", questionId),
        fsync: () => {
          throw new Error("fsync failed");
        }
      });
    });
    await expectFailClosed("reopen-failure", (planted, questionId) => {
      applyMeasuredWorkspaceInstall({
        ...installInput(planted, "worker-a", questionId),
        reopenSqlite: () => {
          throw new Error("sqlite reopen failed");
        }
      });
    });
  });
});

function reportPhases(
  io: WorkspaceInstallIoReceipt,
  mode?: "reflink" | "copy_fallback"
): {
  readonly cloneMode: string | undefined;
  readonly logicalBytes: number | undefined;
  readonly physicalBytesWritten: unknown;
  readonly counts: Record<string, number | "not_observed">;
} {
  expect(io.contract).toBe(P00_PERFORMANCE_PROOF_CONTRACT.name);
  expect(io.phases.map((phase) => phase.name)).toEqual([...WORKSPACE_INSTALL_PHASES]);
  const counts = Object.fromEntries(WORKSPACE_INSTALL_PHASES.map((name) => {
    const row = phaseByName(io.phases, name);
    if (row === undefined || !isObserved(row.count)) return [name, "not_observed"];
    return [name, row.count.value];
  }));
  const clone = io.clone.status === "observed" ? io.clone : undefined;
  if (mode !== undefined) expect(clone?.mode).toBe(mode);
  return {
    cloneMode: clone?.mode,
    logicalBytes: clone?.logicalBytes,
    physicalBytesWritten: clone?.physicalBytesWritten,
    counts
  };
}

async function expectFailClosed(
  reason: string,
  run: (
    planted: ReturnType<typeof plantProviderFreeWorkspaceFixture>,
    questionId: string
  ) => void,
  alsoAccept: readonly string[] = []
): Promise<void> {
  const root = await tempRoot();
  const planted = plantProviderFreeWorkspaceFixture(root);
  const questionId = `q-${reason}`;
  const targetPath = workspaceInstallTargetPath(join(root, "working"), "worker-a", questionId);
  try {
    run(planted, questionId);
    throw new Error(`expected fail-closed ${reason}`);
  } catch (error) {
    expect(error).toMatchObject({ name: "WorkspaceInstallFailClosedError" });
    expect([reason, ...alsoAccept]).toContain(
      (error as WorkspaceInstallFailClosedError).reason
    );
  }
  expect(existsSync(targetPath)).toBe(false);
  expect(existsSync(`${targetPath}-wal`)).toBe(false);
  expect(existsSync(`${targetPath}-shm`)).toBe(false);
  expect(listTmpFiles(dirname(targetPath))).toEqual([]);
  expect(existsSync(planted.sourcePath)).toBe(true);
}

function installInput(
  planted: ReturnType<typeof plantProviderFreeWorkspaceFixture>,
  workerId: string,
  questionId: string
) {
  return {
    workerId,
    questionId,
    sourcePath: planted.sourcePath,
    overlayPath: planted.overlayPath,
    receiptPath: planted.receiptPath,
    targetDir: join(dirname(planted.sourcePath), "working"),
    copyFile: forceReflinkCopyFile()
  };
}

function listTmpFiles(directory: string): readonly string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory).filter((name) => name.includes(".tmp"));
}

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "p02-workspace-install-test-"));
  roots.push(root);
  return root;
}
