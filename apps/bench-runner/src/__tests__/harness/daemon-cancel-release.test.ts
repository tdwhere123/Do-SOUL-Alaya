import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { startBenchDaemon } from "../../harness/daemon.js";
import * as daemonStartup from "../../harness/daemon/daemon-startup.js";
import {
  adoptBenchDaemonShutdown,
  beginBenchDaemonTask,
  bindBenchDaemonTestSignal,
  currentBenchScope,
  removeDataDirWhenBenchDaemonCancelled,
  runBenchDaemonOperation,
  runOutsideBenchDaemonScope,
  scopeForBenchWork,
  settleActiveBenchDaemonTasks,
  trackBenchBody
} from "../../harness/daemon-task.js";

it("refuses work resumed from a cancelled scope after the next scope is current", async () => {
  const first = new AbortController();
  bindBenchDaemonTestSignal(first.signal);
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const resumed = trackBenchBody(scopeForBenchWork(), async () => {
    await gate;
    await startBenchDaemon({
      dataDirRoot: mkdtempSync(join(tmpdir(), "daemon-resume-")),
      embeddingMode: "disabled"
    });
  });
  first.abort();
  const second = new AbortController();
  bindBenchDaemonTestSignal(second.signal);
  release();
  await expect(resumed).rejects.toMatchObject({ code: "CANCELLED" });
  await settleActiveBenchDaemonTasks();
  const dataDir = mkdtempSync(join(tmpdir(), "daemon-resume-next-"));
  const handle = await startBenchDaemon({ dataDirRoot: dataDir, embeddingMode: "disabled" });
  await handle.shutdown();
  rmSync(dataDir, { recursive: true, force: true });
});

it("deletes a cancelled directory only after slow shutdown finishes", async () => {
  const controller = new AbortController();
  bindBenchDaemonTestSignal(controller.signal);
  const dataDir = mkdtempSync(join(tmpdir(), "daemon-dir-"));
  removeDataDirWhenBenchDaemonCancelled(dataDir);
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const task = beginBenchDaemonTask();
  adoptBenchDaemonShutdown(task, async () => {
    await gate;
  });
  const pending = settleActiveBenchDaemonTasks();
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(existsSync(dataDir)).toBe(true);
  release();
  await pending;
  expect(existsSync(dataDir)).toBe(false);
});

it("deletes a cancelled directory only after the body has stopped", async () => {
  const controller = new AbortController();
  bindBenchDaemonTestSignal(controller.signal);
  const dataDir = mkdtempSync(join(tmpdir(), "daemon-body-"));
  removeDataDirWhenBenchDaemonCancelled(dataDir);
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  trackBenchBody(scopeForBenchWork(), async () => {
    await gate;
  });
  const task = beginBenchDaemonTask();
  adoptBenchDaemonShutdown(task, async () => undefined);
  const pending = settleActiveBenchDaemonTasks();
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(existsSync(dataDir)).toBe(true);
  release();
  await pending;
  expect(existsSync(dataDir)).toBe(false);
});

it("settles a cancelled startup before allowing the next scope to start", async () => {
  const first = new AbortController();
  bindBenchDaemonTestSignal(first.signal);
  const dataDir = mkdtempSync(join(tmpdir(), "daemon-start-"));
  const nextDir = mkdtempSync(join(tmpdir(), "daemon-start-next-"));
  let release: () => void = () => undefined;
  let reportBooted: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const booted = new Promise<void>((resolve) => { reportBooted = resolve; });
  const initialize = daemonStartup.initializeBenchDaemon;
  const startup = vi.spyOn(daemonStartup, "initializeBenchDaemon").mockImplementationOnce(async (input) => {
    const resources = await initialize(input);
    reportBooted();
    await gate;
    return resources;
  });
  const pending = startBenchDaemon({ dataDirRoot: dataDir, embeddingMode: "disabled" });
  try {
    await Promise.race([booted, pending]);
    first.abort();
    const outcomes = Promise.allSettled([pending, settleActiveBenchDaemonTasks()]);
    await Promise.resolve();
    release();
    const [started, settled] = await outcomes;
    expect(started).toMatchObject({ status: "rejected", reason: { code: "CANCELLED" } });
    expect(settled).toEqual({ status: "fulfilled", value: undefined });
    const second = new AbortController();
    bindBenchDaemonTestSignal(second.signal);
    const handle = await startBenchDaemon({ dataDirRoot: nextDir, embeddingMode: "disabled" });
    await handle.shutdown();
  } finally {
    release();
    startup.mockRestore();
    await pending.then((handle) => handle.shutdown(), () => undefined);
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(nextDir, { recursive: true, force: true });
  }
});

it("keeps the directory and blocks reuse when shutdown rejects", async () => {
  const controller = new AbortController();
  bindBenchDaemonTestSignal(controller.signal);
  const dataDir = mkdtempSync(join(tmpdir(), "daemon-reject-"));
  removeDataDirWhenBenchDaemonCancelled(dataDir);
  let attempts = 0;
  const task = beginBenchDaemonTask();
  const shutdown = adoptBenchDaemonShutdown(task, async () => {
    attempts += 1;
    if (attempts === 1) throw new Error("shutdown failed");
  });
  await expect(shutdown()).rejects.toThrow("shutdown failed");
  expect(existsSync(dataDir)).toBe(true);
  const next = new AbortController();
  bindBenchDaemonTestSignal(next.signal);
  await expect(startBenchDaemon({
    dataDirRoot: mkdtempSync(join(tmpdir(), "daemon-reject-next-")),
    embeddingMode: "disabled"
  })).rejects.toThrow("a bench scope is still alive");
  await shutdown();
  expect(existsSync(dataDir)).toBe(true);
  const recovered = await startBenchDaemon({
    dataDirRoot: mkdtempSync(join(tmpdir(), "daemon-reject-recovered-")),
    embeddingMode: "disabled"
  });
  await recovered.shutdown();
  rmSync(dataDir, { recursive: true, force: true });
});

it("does not reuse a scope that is still alive when settle hits its cap", async () => {
  const controller = new AbortController();
  bindBenchDaemonTestSignal(controller.signal);
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const task = beginBenchDaemonTask();
  adoptBenchDaemonShutdown(task, async () => {
    await gate;
  });
  await expect(settleActiveBenchDaemonTasks()).rejects.toThrow("bench scope was still alive");
  const next = new AbortController();
  bindBenchDaemonTestSignal(next.signal);
  await expect(startBenchDaemon({
    dataDirRoot: mkdtempSync(join(tmpdir(), "daemon-cap-")),
    embeddingMode: "disabled"
  })).rejects.toThrow("a bench scope is still alive");
  release();
  await settleActiveBenchDaemonTasks();
  const dataDir = mkdtempSync(join(tmpdir(), "daemon-cap-next-"));
  const handle = await startBenchDaemon({ dataDirRoot: dataDir, embeddingMode: "disabled" });
  await handle.shutdown();
  rmSync(dataDir, { recursive: true, force: true });
}, 20_000);

it("starts sequential daemons when no test signal is bound", async () => {
  await runOutsideBenchDaemonScope(async () => {
    expect(currentBenchScope()).toBeUndefined();
    const unboundDir = mkdtempSync(join(tmpdir(), "daemon-unbound-dir-"));
    expect(() => removeDataDirWhenBenchDaemonCancelled(unboundDir)).toThrow("bench work has no owning scope");
    rmSync(unboundDir, { recursive: true, force: true });
    for (const name of ["one", "two", "three"]) {
      const dataDir = mkdtempSync(join(tmpdir(), `daemon-unbound-${name}-`));
      await runBenchDaemonOperation(async () => {
        const handle = await startBenchDaemon({ dataDirRoot: dataDir, embeddingMode: "disabled" });
        removeDataDirWhenBenchDaemonCancelled(dataDir);
        await handle.shutdown();
      });
      expect(existsSync(dataDir)).toBe(true);
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

it("shuts down each later daemon on the same scope", async () => {
  const scope = currentBenchScope();
  const owned = mkdtempSync(join(tmpdir(), "daemon-again-owned-"));
  removeDataDirWhenBenchDaemonCancelled(owned);
  const previousConfig = process.env.ALAYA_CONFIG_DIR;
  try {
    for (const name of ["one", "two", "three"]) {
      const dataDir = mkdtempSync(join(tmpdir(), `daemon-again-${name}-`));
      const handle = await startBenchDaemon({ dataDirRoot: dataDir, embeddingMode: "disabled" });
      let closed = 0;
      const shutdown = handle.shutdown.bind(handle);
      handle.shutdown = async () => {
        closed += 1;
        await shutdown();
      };
      await handle.shutdown();
      expect(closed).toBe(1);
      expect(currentBenchScope()).toBe(scope);
      expect(existsSync(owned)).toBe(true);
      expect(process.env.ALAYA_CONFIG_DIR).toBe(previousConfig);
      rmSync(dataDir, { recursive: true, force: true });
    }
  } finally {
    rmSync(owned, { recursive: true, force: true });
  }
});
