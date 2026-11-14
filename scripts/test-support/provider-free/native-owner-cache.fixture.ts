import cp from "node:child_process";
import fs from "node:fs";
import { join } from "node:path";
import workers from "node:worker_threads";
import { expect, it, vi } from "vitest";
import { installProviderFreeBoundary } from "./provider-free-boundary.js";
import { installStrictProviderFreeBoundary } from "./strict-provider-free-boundary.js";

// These builtins were already wrapped by the native --import, outside Vitest's cache.
const nativeOwner = { spawn: cp.spawn, fork: cp.fork, worker: workers.Worker };
const mode = process.env.PROVIDER_FREE_OWNER_PROBE;

it("shares native descendant ownership across cache re-entry and nested restoration", async () => {
  const outer = installProviderFreeBoundary();
  vi.resetModules();
  const { installProviderFreeBoundary: reenter } = await import("./provider-free-boundary.js");
  const inner = reenter();
  const read = (member: string, name: string) => JSON.parse(fs.readFileSync(join(outer.evidence.root, member, name), "utf8"));
  const members = () => fs.readFileSync(join(outer.evidence.root, "members.jsonl"), "utf8").trim().split("\n")
    .map(line => JSON.parse(line).member as string).filter(member => read(member, "entry.json").parent === outer.evidence.member);
  const expectOwner = () => {
    expect(cp.spawn).toBe(nativeOwner.spawn);
    expect(cp.fork).toBe(nativeOwner.fork);
    expect(workers.Worker).toBe(nativeOwner.worker);
  };
  const launch = async () => {
    const before = members();
    // Every application body reads readiness itself: no parent may manufacture it.
    const body = `const fs=require('node:fs'),path=require('node:path');
      const binding=JSON.parse(process.env.ALAYA_PROVIDER_FREE_ISOLATION);
      const ready=JSON.parse(fs.readFileSync(path.join(binding.root,binding.member,'ready.json'),'utf8'));
      if(ready.pid!==process.pid||ready.thread!==require('node:worker_threads').threadId)throw Error('not ready');`;
    const spawn = cp.spawn(process.execPath, ["-e", body], { env: {}, stdio: "pipe" });
    const fork = cp.fork(new URL("./native-owner-child.fixture.cjs", import.meta.url), [], { env: {}, execArgv: [], silent: true });
    const worker = new workers.Worker(`${body}
      require('node:worker_threads').parentPort.postMessage('ready');setInterval(()=>{},1000);`, { eval: true, env: {}, execArgv: [] });
    await Promise.all([
      ...[spawn, fork].map(actor => new Promise<void>((resolve, reject) => {
        actor.once("error", reject); actor.once("exit", code => code === 0 ? resolve() : reject(new Error(`child exit ${code}`)));
      })),
      new Promise<void>((resolve, reject) => { worker.once("error", reject); worker.once("message", () => resolve()); })
        .then(async () => { expect(await worker.terminate()).toBe(1); })
    ]);
    const added = members().filter(member => !before.includes(member));
    expect(added).toHaveLength(3);
    expect(added.map(member => read(member, "entry.json").kind).sort()).toEqual(["fork", "spawn", "worker"]);
    for (const member of added) {
      expect(read(member, "ready.json").pid).toBeGreaterThan(0);
      expect(read(member, "exit.json").signal).toBeNull();
      if (read(member, "entry.json").kind === "worker") expect(read(member, "cancellation.json")).toEqual({ requested: true });
    }
    outer.assertSafe(true);
  };
  let innerActive = true;
  try {
    expectOwner();
    expect(() => outer.restore()).toThrow("reverse installation order");
    const strict = installStrictProviderFreeBoundary();
    try { expect(() => fetch("http://127.0.0.1:1")).toThrow("forbids fetch"); }
    finally { strict.restore(); }
    await launch();
    inner.restore(); innerActive = false;
    expectOwner();
    await launch();
  } finally {
    if (innerActive) inner.restore();
    outer.restore();
  }
  expectOwner(); // Releasing Vitest's entries must not release the permanent native owner.
  await launch();
  if (mode === "denial") {
    const caught = reenter();
    try {
      expect(() => fs.readFileSync("/nonexistent-isolation-fixture/auth.json")).toThrow("credential file");
      caught.violations.length = 0;
    } finally { caught.restore(); }
    expect(() => outer.assertSafe(true)).toThrow("violation:credential file");
  } else if (mode === "unconfirmed") {
    cp.spawnSync(process.execPath, ["--invalid-isolation-fixture-flag"], { env: {}, stdio: "pipe" });
    expect(() => outer.assertSafe(true)).toThrow("unconfirmed_descendant");
  }
  fs.writeFileSync(process.env.PROVIDER_FREE_OWNER_EVIDENCE!, JSON.stringify({ root: outer.evidence.root, mode }));
});
