import { afterAll, afterEach, expect, it, vi } from "vitest";
const boundary = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../support/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { AlayaError } from "@do-soul/alaya-protocol";
import { withSemanticChainDaemon } from "../../../runs/recall-measurement/contract.js";
import { discoverSemanticChainQuery } from "../../../runs/recall-measurement/prepare.js";
import { nativeRecallFixture, QUESTION } from "./native-recall.test-support.js";
const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
afterAll(() => { expect(boundary.violations).toEqual([]); boundary.restore(); });

it.each(["context_rejection", "cancellation"] as const)("preserves %s and shutdown failure after real native discovery", async failure => {
  const base = await nativeRecallFixture("Project Aster was mentioned."); roots.push(base.root);
  const config = base.admitted.plan.config, root = join(base.root, "failed-discovery");
  const operation = new AlayaError(failure === "cancellation" ? "CANCELLED" : "CONFLICT", `authored ${failure}`);
  const cleanup = new Error("shutdown fault after real shutdown", { cause: new Error("authored cleanup root cause") });
  let shutdowns = 0, discovered = false, caught = false, diagnostic: unknown;
  try {
    await withSemanticChainDaemon(config, root, async daemon => {
      const shutdown = daemon.shutdown.bind(daemon);
      vi.spyOn(daemon, "shutdown").mockImplementation(async () => { await shutdown(); shutdowns++; throw cleanup; });
      const native = await discoverSemanticChainQuery(daemon, config, QUESTION);
      expect(native.discovery.discovery_trace.length).toBeGreaterThan(0);
      discovered = true;
      if (failure === "cancellation") { const caller = new AbortController(); caller.abort(operation); caller.signal.throwIfAborted(); }
      throw operation;
    }, { embeddingStartupProbe: "omit" });
  } catch (error) { caught = true; diagnostic = error; }
  expect(discovered).toBe(true); expect(caught).toBe(true); expect(shutdowns).toBe(1);
  expect(diagnostic).toMatchObject({ cause: { earlier: operation, cleanup } });
  expect(readdirSync(root).filter(name => name.startsWith("native-session-"))).toHaveLength(1);
}, 60000);

it("preserves single failures, thrown undefined, and success-only directory cleanup", async () => {
  const base = await nativeRecallFixture("Project Aster was mentioned."); roots.push(base.root);
  const operation = new AlayaError("CONFLICT", "operation only"), cleanup = new Error("cleanup only");
  for (const mode of ["operation", "undefined_operation", "cleanup", "undefined_with_cleanup", "success"] as const) {
    const root = join(base.root, mode);
    let caught = false, actual: unknown;
    try {
      await withSemanticChainDaemon(base.admitted.plan.config, root, async daemon => {
        if (mode === "cleanup" || mode === "undefined_with_cleanup") {
          const shutdown = daemon.shutdown.bind(daemon);
          vi.spyOn(daemon, "shutdown").mockImplementation(async () => { await shutdown(); throw cleanup; });
        }
        if (mode === "operation") throw operation;
        if (mode === "undefined_operation" || mode === "undefined_with_cleanup") throw undefined;
        return "complete";
      }, { embeddingStartupProbe: "omit" });
    } catch (error) { caught = true; actual = error; }
    expect(caught).toBe(mode !== "success");
    if (mode === "operation") expect(actual).toBe(operation);
    if (mode === "cleanup") expect(actual).toBe(cleanup);
    if (mode === "undefined_operation") expect(actual).toBeUndefined();
    if (mode === "undefined_with_cleanup") expect(actual).toMatchObject({ cause: { earlier: undefined, cleanup } });
    expect(readdirSync(root).filter(name => name.startsWith("native-session-"))).toHaveLength(mode === "success" ? 0 : 1);
  }
}, 60000);
