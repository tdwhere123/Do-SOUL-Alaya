import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { AlayaError } from "@do-soul/alaya-protocol";
import { startBenchDaemon } from "../../harness/daemon.js";
import {
  adoptBenchDaemonShutdown,
  beginBenchDaemonTask,
  bindBenchDaemonTestSignal,
  removeDataDirWhenBenchDaemonCancelled,
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

it("does not return a daemon when the scope is cancelled during start", async () => {
  const first = new AbortController();
  bindBenchDaemonTestSignal(first.signal);
  const dataDir = mkdtempSync(join(tmpdir(), "daemon-start-"));
  const pending = startBenchDaemon({ dataDirRoot: dataDir, embeddingMode: "disabled" });
  first.abort();
  await expect(pending).rejects.toBeInstanceOf(AlayaError);
  const nextDir = mkdtempSync(join(tmpdir(), "daemon-start-next-"));
  const second = new AbortController();
  bindBenchDaemonTestSignal(second.signal);
  const handle = await startBenchDaemon({ dataDirRoot: nextDir, embeddingMode: "disabled" });
  await handle.shutdown();
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(nextDir, { recursive: true, force: true });
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
