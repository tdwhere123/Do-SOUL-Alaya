import { afterAll, afterEach, expect, it, vi } from "vitest";
const boundary = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../support/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chainIdentity, writeChainArtifact } from "../../../runs/semantic-chain/contract.js";
const require = createRequire(import.meta.url);
const owner = require("../../../runs/semantic-chain/source-acquisition-launch.mjs");
const { acquisitionRuntimeChannel, observerBootstrapEnvelope, OBSERVER_BOOTSTRAP_MODE, contextBootstrapEnvelope,
  CONTEXT_BOOTSTRAP_BYTES } =
  require("../../../runs/semantic-chain/source-acquisition-runtime-channel.mjs");
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
afterAll(() => { expect(boundary.violations).toEqual([]); boundary.restore(); });

it.each(["malformed", "missing", "pid", "identity", "deadline", "oversized", "disconnect", "cancel"])(
  "stops an actual owned guarded launcher on %s bootstrap without application fallback", async failure => {
    const root = mkdtempSync(join(tmpdir(), "acquisition-bootstrap-")); roots.push(root);
    // Only the built-ins launch phase may run: this deliberately has no application config.
    const allocation = { source_inputs: 0, utf8_bytes: 0 };
    const input = { contract: "source-acquisition-experiment-v1", root, guard_allocation: allocation,
      launch: owner.captureAcquisitionLaunchBinding() };
    const identity = chainIdentity(input), deadline = Date.now() + 2000;
    writeChainArtifact(join(root, "source-experiment-input.json"), input);
    const paths = owner.acquisitionLaunchPaths(allocation);
    const args = ["--import", paths.preload, paths.launcher, root, identity, String(deadline), OBSERVER_BOOTSTRAP_MODE];
    expect(args.join(" ")).not.toContain("private observation text");
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/iu.test(key)));
    delete env.NODE_OPTIONS;
    Object.assign(env, { ALAYA_SOURCE_EMBEDDING_OFFLINE_ALLOW_GIT: "1",
      ALAYA_SOURCE_EMBEDDING_OFFLINE_GUARD_RECEIPT_DIR: join(root, "receipts") });
    const evidence = await new Promise<{ code: number | null; stderr: string; acknowledged: boolean }>((resolve, reject) => {
      const child = spawn(process.execPath, args, { env, stdio: ["ignore", "pipe", "pipe", "ipc"] });
      let stderr = "", acknowledged = false;
      const kill = setTimeout(() => child.kill("SIGKILL"), 10000);
      child.stderr!.on("data", chunk => { stderr += chunk; });
      child.on("message", () => {
        acknowledged = true;
        if (failure === "missing") return;
        if (failure === "disconnect") { child.disconnect(); return; }
        if (failure === "cancel") { child.send({ kind: "cancel_source_acquisition" }); return; }
        const message = { kind: OBSERVER_BOOTSTRAP_MODE, identity, pid: child.pid, deadline, view: { text: "private observation text" } };
        if (failure === "malformed") child.send({ unexpected: true });
        else child.send({ ...message, ...(failure === "pid" ? { pid: child.pid! + 1 } : {}),
          ...(failure === "identity" ? { identity: "wrong" } : {}), ...(failure === "deadline" ? { deadline: deadline + 1 } : {}),
          ...(failure === "oversized" ? { view: { text: "private observation text".repeat(1000) } } : {}) });
      });
      child.on("error", reject); child.on("exit", code => { clearTimeout(kill); resolve({ code, stderr, acknowledged }); });
    });
    expect(evidence.acknowledged).toBe(true); expect(evidence.code).toBe(1);
    expect(evidence.stderr).not.toContain("private observation text");
    expect(evidence.stderr).not.toContain("ZodError"); // Application import/admission must not substitute for bootstrap rejection.
    expect(evidence.stderr).toContain(failure === "missing" ? "deadline expired" : failure === "cancel" ? "caller cancelled"
      : failure === "disconnect" ? "channel disconnected" : "invalid acquisition runtime bootstrap");
  }, 15000);

it("keeps context and observer payloads separate, bounded and one-shot on the same private channel", async () => {
  const channel = Object.assign(new EventEmitter(), { pid: process.pid }), identity = "context-experiment", deadline = Date.now() + 2000;
  const context = { additional_interpretation: { text: "x".repeat(20000) } }, observer = { observation: "separate observer" };
  expect(() => observerBootstrapEnvelope(identity, process.pid, deadline, context)).toThrow();
  expect(() => contextBootstrapEnvelope(identity, process.pid, deadline, { text: "x".repeat(CONTEXT_BOOTSTRAP_BYTES) })).toThrow();
  const runtime = acquisitionRuntimeChannel({ identity, deadline, context: true, channel });
  const message = contextBootstrapEnvelope(identity, process.pid, deadline, context, observer);
  channel.emit("message", message);
  expect(await runtime.view).toEqual({ correspondenceGenerationContext: context, queryRevisionObserverView: observer });
  channel.emit("message", message); expect(runtime.signal.aborted).toBe(true); runtime.dispose();
  const misbound = acquisitionRuntimeChannel({ identity, deadline, context: true, channel });
  channel.emit("message", { ...message, identity: "another-root" });
  await expect(misbound.view).rejects.toThrow("invalid acquisition runtime bootstrap"); misbound.dispose();
});

it("retains duplicate detection and cancellation after accepting bootstrap, then releases lifecycle listeners", async () => {
  const channel = Object.assign(new EventEmitter(), { pid: process.pid }), identity = "private-experiment", deadline = Date.now() + 2000;
  const runtime = acquisitionRuntimeChannel({ identity, deadline, observer: true, channel });
  const message = observerBootstrapEnvelope(identity, process.pid, deadline, { observation: "private" });
  channel.emit("message", message);
  expect(await runtime.view).toEqual(message.view); expect(runtime.signal.aborted).toBe(false);
  channel.emit("message", message);
  expect(runtime.signal.aborted).toBe(true);
  runtime.dispose(); expect(channel.listenerCount("message")).toBe(0); expect(channel.listenerCount("disconnect")).toBe(0);
  const cancelled = acquisitionRuntimeChannel({ identity, deadline, observer: true, channel });
  channel.emit("message", { kind: "cancel_source_acquisition" });
  await expect(cancelled.view).rejects.toThrow("caller cancelled"); cancelled.dispose();
});
