import { afterAll, afterEach, expect, it, vi } from "vitest";
const boundary = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../support/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AlayaError } from "@do-soul/alaya-protocol";
import { chainIdentity, withSemanticChainDaemon, writeChainArtifact } from "../../../runs/semantic-chain/contract.js";
import { publishSourceExperimentResult, readSourceExperiment, SOURCE_EXPERIMENT_ACTION } from "../../../runs/semantic-chain/source-experiment.js";
import { freezeRecoveryAllowance, reserveRecoveryHostEffect } from "../../../runs/semantic-chain/recovery-allowance.js";
import { admitSourceQualifiedSelection } from "../../../runs/semantic-chain/source-qualified-selection-input.js";
import { qualifiedSelectionFixture } from "./source-qualified-selection.test-support.js";
import { buildSourceSemanticWorkerPayload } from "../../../../../core-daemon/src/mcp-memory/tool/interpretation-handler.js";
import { compareResearchSourceQualifiedSelection, researchSourceAcquisitionClient }
  from "../../../../../core-daemon/src/runtime/recall/source-semantic-research-acquisition-controls.js";
const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
afterAll(() => { expect(boundary.violations).toEqual([]); boundary.restore(); });
async function fixture() {
  vi.stubEnv("ALAYA_CONFLICT_LLM_PROVIDER_URL", ""); vi.stubEnv("ALAYA_CONFLICT_LLM_MODEL", "");
  const directory = mkdtempSync(join(tmpdir(), "semantic-chain-daemon-failure-")); roots.push(directory);
  return qualifiedSelectionFixture(directory);
}

it.each(["context_rejection", "cancellation"] as const)("persists both %s and shutdown failure after a real native comparison", async failure => {
  const h = await fixture(), identity = chainIdentity(h.input);
  const producer = admitSourceQualifiedSelection(h.input.config, h.input.qualified_selection!);
  if (producer.status !== "ready") throw new Error("native producer required");
  freezeRecoveryAllowance(h.root, identity, h.input.host_admission, h.input.config.snapshot_path);
  writeChainArtifact(join(h.root, "source-experiment-input.json"), h.input);
  reserveRecoveryHostEffect(h.root, SOURCE_EXPERIMENT_ACTION, identity, false, true);
  const operation = new AlayaError(failure === "cancellation" ? "CANCELLED" : "CONFLICT", `authored ${failure}`);
  const cleanup = new Error("shutdown fault after real shutdown", { cause: new Error("authored cleanup root cause") });
  let comparison: Awaited<ReturnType<typeof compareResearchSourceQualifiedSelection>> | undefined, shutdowns = 0;
  let caught = false, diagnostic: unknown;
  try {
    await withSemanticChainDaemon(h.input.config, h.root, async daemon => {
      const shutdown = daemon.shutdown.bind(daemon);
      vi.spyOn(daemon, "shutdown").mockImplementation(async () => { await shutdown(); shutdowns++; throw cleanup; });
      const payload = buildSourceSemanticWorkerPayload({ now: () => "2026-09-26T00:00:00.000Z", interpretationClock: h.input.config.interpretation_clock },
        { workspaceId: h.input.config.workspace_id, runId: h.input.config.run_id, sessionId: identity, agentTarget: "bench" },
        { kind: "recall", accepts_unreviewed_conditional_results: true, original_query: h.input.original_query,
          query_semantics: producer.query_semantics, semantic_correspondences: producer.semantic_correspondences,
          access_policy: "query-conditioned-v1", budget: h.input.config.budget, output_byte_limit: h.input.config.output_byte_limit }, h.input.config.authorized_scopes);
      comparison = await compareResearchSourceQualifiedSelection(researchSourceAcquisitionClient(daemon.runtime), payload, producer.population, { timeoutMs: 60000 });
      expect(comparison.outcome).toBe("complete");
      if (failure === "cancellation") { const caller = new AbortController(); caller.abort(operation); caller.signal.throwIfAborted(); }
      throw operation;
    }, { embeddingStartupProbe: "omit" });
  } catch (error) { caught = true; diagnostic = error; }
  expect(caught).toBe(true); expect(shutdowns).toBe(1);
  expect(diagnostic).toMatchObject({ cause: { earlier: operation, cleanup } });
  expect(comparison!.selection!.work.logical_work).toBeGreaterThan(0);
  publishSourceExperimentResult(h.root, identity, { qualified_failure: { phase: "comparison", population: h.input.qualified_selection!, diagnostic, comparison } });
  const state = readSourceExperiment(h.root);
  expect(state.execution).not.toHaveProperty("qualified_comparison");
  expect(state.execution).toMatchObject({ qualified_failure: { diagnostic: { cause: {
    earlier: { code: operation.code, message: operation.message },
    cleanup: { message: cleanup.message, cause: { message: "authored cleanup root cause" } } } },
    comparison: { outcome: "complete", selection: { work: { logical_work: comparison!.selection!.work.logical_work } } } } });
  expect(readdirSync(h.root).filter(name => name.startsWith("native-session-"))).toHaveLength(1);
  rmSync(h.input.config.snapshot_path);
  expect(readSourceExperiment(h.root).execution).toEqual(state.execution);
}, 60000);

it("preserves single failures, a thrown undefined operation, and success-only directory cleanup", async () => {
  const h = await fixture();
  const operation = new AlayaError("CONFLICT", "operation only"), cleanup = new Error("cleanup only");
  for (const mode of ["operation", "undefined_operation", "cleanup", "undefined_with_cleanup", "success"] as const) {
    const root = join(h.directory, mode);
    let caught = false, actual: unknown;
    try {
      await withSemanticChainDaemon(h.input.config, root, async daemon => {
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
