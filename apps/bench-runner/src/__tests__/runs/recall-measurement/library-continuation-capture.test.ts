import { afterAll, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../support/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SoulInterpretationResponseSchema } from "@do-soul/alaya-protocol";
import { prepareNativeSourceRecordsSnapshot } from "../../../runs/snapshot/source-records/native.js";
import { readCurrentExtractionAuthorityRevision } from "../../../runs/extraction/authority/inspection.js";
import { parseSemanticProposalWorkset } from "../../../runs/semantic-cache/workset.js";
import { prepareSemanticChain } from "../../../runs/recall-measurement/prepare.js";
import { SemanticChainConfigSchema, readChainArtifact, withSemanticChainDaemon, writeChainArtifact } from "../../../runs/recall-measurement/contract.js";
import { admitSemanticChainLibraryCapture, captureSemanticChainLibrary } from "../../../runs/recall-measurement/library-capture.js";
import { admitSourceSemanticLibraryContinuation, measureSourceSemanticLibraryResponse } from "../../../runs/measurement/source-semantic-library-measurement.js";
import { FirstExposurePageSchema } from "../../../runs/measurement/first-exposure-session.js";
import * as mcp from "../../../harness/daemon/runtime/daemon-mcp-support.js";

const roots: string[] = [];
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); isolation.restore(); });

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "library-continuation-"));
  roots.push(root);
  const snapshot = await prepareNativeSourceRecordsSnapshot({ snapshotPath: join(root, "input.sqlite"),
    dataDirRoot: join(root, "publication"), workspaceId: "stone-library", runId: "stone-library-run",
    producerCommit: "22650b55c4c0e2814b115918ad979a1c0d0dbad6", sources: Array.from({ length: 11 }, (_, n) => ({
      source_id: `stone-note-${n}`, source_version: "1", title: `Stone note ${n}`, content_bytes: `Stone ${n} is blue. Full source message ${n}.`,
      source_observed_at: "2026-09-21T00:00:00.000Z", recorded_at: "2026-09-21T00:00:00.000Z"
    })) });
  const config = SemanticChainConfigSchema.parse({ snapshot_path: snapshot.snapshot_path, snapshot_sha256: snapshot.db_sha256,
    implementation_revision: readCurrentExtractionAuthorityRevision(), interpretation_clock: "2026-09-22T00:00:00.000Z",
    workspace_id: snapshot.workspace_id, run_id: snapshot.run_id,
    query_workset: parseSemanticProposalWorkset({ contract: "source-semantic-proposal-workset-v3", kind: "query",
      model: "gemini-2.5-flash-lite", request_profile: "gemini-2.5-nonthinking-v1", provider_url: "http://127.0.0.1:9",
      items: [{ original_query: "What color are the stones?" }] }),
    query_cache_root: join(root, "unattempted-query-cache"), correspondence_cache_root: join(root, "unattempted-correspondence-cache"),
    max_output_tokens: 4096, discovery_page_cap: 1, correspondence_pair_cap: 0,
    access_policy: "query-conditioned-v1", authorized_scopes: { mode: "named", scopes: ["project"] },
    budget: { schema_version: 1, work_units: 10_000_000, memory_bytes: 60_000_000,
      page_budget: 10_000, finalization_reserve: 50_000, min_envelope: 10 }, output_byte_limit: 1_000_000 });
  const chainRoot = join(root, "chain");
  const plan = await prepareSemanticChain(config, chainRoot);
  expect(plan.queries[0]!.status).toBe("raw_ready");
  return { root, chainRoot, plan, config, key: plan.queries[0]!.query_key };
}

function secondPage(path: string) {
  const value = readChainArtifact(path) as { response: unknown; first_exposure: unknown };
  return { recallResult: SoulInterpretationResponseSchema.parse(value.response), firstExposurePage: FirstExposurePageSchema.parse(value.first_exposure) };
}

it("freezes two actual five-slot pages in one session without replacing initial membership or accepting labels", async () => {
  const f = await fixture();
  const output = join(f.root, "two-pages");
  const captured = await captureSemanticChainLibrary(f.chainRoot, output, { maxPages: 2,
    daemonOptions: { sourceSemanticObservations: true }, observeExecution: (work, { daemon }) => {
      if (daemon.observeSourceSemantics === undefined) throw new Error("private observation scope unavailable");
      return daemon.observeSourceSemantics({}, work);
    } });
  const row = captured.rows[0]!;
  expect(row.status).toBe("captured");
  expect(row.execution_observation).toMatchObject({ status: "available", outcome: "success" });
  expect(row.execution_observation.observations).toHaveLength(3);
  expect(row.execution_observation.observations).toEqual(expect.arrayContaining([expect.objectContaining({ execution: "success",
    totals: expect.objectContaining({ debit_work: expect.any(Number) }) })]));
  expect(row.pages.map(page => [page.status, page.occupied_slots])).toEqual([["observed", 5], ["observed", 5]]);
  expect(row.pages.map(page => page.terminal_tail)).toEqual([
    { status: "open", reason: "occupancy_continuation_present" },
    { status: "open", reason: "occupancy_continuation_present" }]);
  expect(row.pages.flatMap(page => page.intervals.map(interval => interval.rank))).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  const initial = row.initial!;
  if (initial.response?.operation !== "recall" || initial.first_exposure == null) throw new Error("initial recall required");
  const next = secondPage(join(output, f.key, "page-2.native.json"));
  expect(next.firstExposurePage.initial).toEqual(initial.first_exposure.initial);
  expect(next.firstExposurePage.request_continuation).toEqual(initial.response.index!.continuation);
  const firstInput = { recallResult: initial.response, firstExposurePage: initial.first_exposure, requestBudget: f.config.budget };
  const continuationInput = { ...next, requestBudget: f.config.budget, previous: firstInput,
    requestContinuation: initial.response.index!.continuation!, requestIdentity: initial.response.request_identity! };
  expect(admitSourceSemanticLibraryContinuation(continuationInput)?.status).toBe("admitted");
  expect(measureSourceSemanticLibraryResponse({ ...next, requestBudget: f.config.budget, goldSourceUnits: [] }).measurement)
    .toMatchObject({ status: "invalid", reason: "missing_first_exposure" });
  expect(admitSourceSemanticLibraryContinuation({ ...continuationInput, previous: { ...firstInput, ...next } })?.status).not.toBe("admitted");
  expect(admitSourceSemanticLibraryContinuation({ ...continuationInput,
    requestContinuation: { ...continuationInput.requestContinuation, capability: "wrong-chain" } })?.status).not.toBe("admitted");
  const frame = readChainArtifact(join(output, f.key, "page-2.mcp.json")) as mcp.BenchMcpToolCapture;
  expect(frame.request.arguments.continuation).toEqual(initial.response.index!.continuation);
  expect(frame.response).toMatchObject({ content: expect.arrayContaining([expect.objectContaining({ type: "text", text: expect.any(String) })]) });
  expect(JSON.stringify(frame)).not.toContain("EVALUATOR_ONLY_GOLD");
  expect(admitSemanticChainLibraryCapture(f.chainRoot, output).rows[0]!.pages).toEqual(row.pages);
  await expect(captureSemanticChainLibrary(f.chainRoot, output, { maxPages: 1 })).rejects.toThrow();
  const single = await captureSemanticChainLibrary(f.chainRoot, join(f.root, "one-page"), { maxPages: 1 });
  expect(single.header.identity).not.toBe(captured.header.identity);
  expect(single.rows[0]!.pages.map(page => page.status)).toEqual(["observed", "not_run"]);
  expect(single.rows[0]!.pages[0]!.terminal_tail).toEqual({ status: "open", reason: "occupancy_continuation_present" });
  expect(single.rows[0]!.pages[1]!.terminal_tail.status).toBe("unknown");
  expect(admitSourceSemanticLibraryContinuation({ ...continuationInput, previous: {
    recallResult: single.rows[0]!.initial!.response, firstExposurePage: single.rows[0]!.initial!.first_exposure!, requestBudget: f.config.budget
  } })?.status).not.toBe("admitted");
  expect(single.rows[0]!.initial!.response?.operation === "recall" && single.rows[0]!.initial!.response.results)
    .toEqual(initial.response.results);
  // The captured cursor is a live daemon/session lease, not a portable request for a new initial page.
  let refusal: mcp.BenchMcpToolCapture | undefined;
  await expect(withSemanticChainDaemon(f.config, join(f.root, "wrong-session"), async daemon =>
    mcp.callMcpTool(daemon.mcpClient, frame.request.name, frame.request.arguments, value => { refusal = value; })))
    .rejects.toThrow("MCP tool soul.interpretation failed:");
  expect(refusal?.response).toMatchObject({ isError: true });
  expect(refusal?.response).not.toHaveProperty("structuredContent.output");
  expect(() => mcp.readBenchMcpToolOutput("soul.interpretation", refusal?.response)).toThrow("MCP tool soul.interpretation failed:");
  expect(isolation.violations).toEqual([]);
}, 120_000);

it("refuses frozen error and non-ok MCP envelopes even when their native output is unchanged", async () => {
  const f = await fixture();
  const output = join(f.root, "envelope-admission");
  await captureSemanticChainLibrary(f.chainRoot, output, { maxPages: 1 });
  const path = join(output, f.key, "page-1.mcp.json");
  const frame = readChainArtifact(path) as mcp.BenchMcpToolCapture;
  const envelope = frame.response as { structuredContent: { ok: boolean; output: unknown } };
  for (const [response, message] of [
    [{ ...envelope, isError: true }, "MCP tool soul.interpretation failed:"],
    [{ ...envelope, structuredContent: { ...envelope.structuredContent, ok: false } }, "MCP tool soul.interpretation returned non-ok structured content"]
  ] as const) {
    rmSync(path);
    writeChainArtifact(path, { ...frame, response });
    expect(() => admitSemanticChainLibraryCapture(f.chainRoot, output)).toThrow(message);
  }
  expect(isolation.violations).toEqual([]);
}, 120_000);

it("aborts a failed raw-envelope archive and retains the first page and the unresolved continuation reservation", async () => {
  const f = await fixture();
  const output = join(f.root, "partial");
  const original = mcp.callMcpTool;
  // The actual SQLite/MCP continuation runs; a real conflicting filesystem object refuses its mandatory archive write.
  const spy = vi.spyOn(mcp, "callMcpTool").mockImplementation(async (client, name, args, capture) => original(client, name, args, frame => {
    if (args.continuation !== undefined) mkdirSync(join(output, f.key, "page-2.mcp.json"));
    capture?.(frame);
  }));
  try {
    await expect(captureSemanticChainLibrary(f.chainRoot, output, { maxPages: 2,
      daemonOptions: { sourceSemanticObservations: true }, observeExecution: (work, { daemon }) => {
        if (daemon.observeSourceSemantics === undefined) throw new Error("private observation scope unavailable");
        return daemon.observeSourceSemantics({}, work);
      } })).rejects.toThrow("archive write failed");
  } finally { spy.mockRestore(); }
  expect(readChainArtifact(join(output, f.key, "execution-observation.json"))).toMatchObject({ outcome: "failure", status: "available",
    error: { message: "library MCP archive write failed" } });
  expect(readChainArtifact(join(output, f.key, "initial.json.reserved"))).toHaveProperty("replay_identity");
  expect(readChainArtifact(join(output, f.key, "page-2.reserved"))).toMatchObject({ page: 2, query_key: f.key });
  expect(readChainArtifact(join(output, f.key, "page-2.native.json"))).toBeUndefined();
  const retained = admitSemanticChainLibraryCapture(f.chainRoot, output).rows[0]!;
  expect(retained.status).toBe("partial");
  expect(retained.pages.map(page => page.status)).toEqual(["observed", "unobserved"]);
  expect(retained.pages[0]!.occupied_slots).toBe(5);
  expect(retained.pages[0]!.terminal_tail).toEqual({ status: "open", reason: "occupancy_continuation_present" });
  expect(retained.pages[1]!.terminal_tail.status).toBe("unknown");
  await expect(captureSemanticChainLibrary(f.chainRoot, output, { maxPages: 2 })).rejects.toThrow();
  expect(isolation.violations).toEqual([]);
}, 120_000);
