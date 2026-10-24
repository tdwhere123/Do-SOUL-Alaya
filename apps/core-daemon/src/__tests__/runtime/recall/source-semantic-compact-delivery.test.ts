import { afterAll, afterEach, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../../../../bench-runner/src/__tests__/support/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
afterEach(() => { expect(isolation.violations).toEqual([]); });
afterAll(() => { isolation.restore(); });
import { dirname } from "node:path";
import { REAL_SQLITE_TEST_RUN_ID as RUN } from "../../../../../../packages/core/src/__tests__/shared/real-sqlite.test-support.js";
import { sourceDisclosure, SoulInterpretationResponseSchema, SourceSemanticWorkerResultSchema, sourceSemanticReasonControl,
  type SoulInterpretationResponse, type SourceSemanticWorkerResult } from "@do-soul/alaya-protocol";
import { callAlayaMcpMemoryTool } from "../../../mcp/server/mcp-server.js";
import { createMcpMemoryToolHandler } from "../../../mcp-memory/tool/tool-handler.js";
import { createDeps } from "../../mcp-memory/tool/mcp-memory-tool-handler-fixture.js";
import { withCliInterpretationSession } from "../../support/cli-interpretation-session.test-support.js";
import { ACCESS_BUDGET, CLOCK, WS, accessCall, withAccessLibrary } from "./source-semantic-access.test-support.js";
import { aliceUsesDraft, correspondenceOf, ORIGINAL, queryOf } from "./source-semantic-library-binding-coverage.js";

type Reason = Extract<SourceSemanticWorkerResult, { kind: "reason" }> | Extract<SoulInterpretationResponse, { operation: "reason" }>;
const sourceGap = { kind: "unsupported_meaning" as const, affected_ids: [], support: [], description: "部分含义未编码" };
const sourceId = "multibyte-tool-source";
const sources = [{ id: sourceId, text: "Alice uses 工具箱, a tool.", verbatim: true,
  authoredDraft: (catalog: Parameters<typeof aliceUsesDraft>[0]) => ({ ...aliceUsesDraft(catalog, "工具箱"), gaps: [sourceGap] }) }];
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");
const budget = { ...ACCESS_BUDGET, work_units: 200_000, memory_bytes: 20_000_000 };
const scopes = { mode: "named" as const, scopes: ["project"] };

function requireFull(value: Reason) {
  expect(value.result).toBeDefined();
  if (value.result === undefined) throw new Error("full-fitting reason must retain its result");
  expect(value.result).toMatchObject({ outcome: { status: "interpreted", gaps: [sourceGap] },
    semantic_status: "unreviewed", conclusion_scope: "conditional_on_interpretation", world_claim: "unknown" });
  expect(value.result.consumed_leaves.length).toBeGreaterThan(0);
  expect(value.result.binding_results?.length).toBeGreaterThan(0);
  expect(value.interpretation?.mentions.some(row => row.text === "工具箱")).toBe(true);
  expect(value.query).toEqual(queryOf());
  expect(value.semantic_correspondence).toBeDefined();
  expect(value.context).toBeDefined();
  expect(value).not.toHaveProperty("no_conclusion");
  expect(value.execution).toBe("native_reasoning_only");
  expect(bytes(value)).toBeGreaterThan(JSON.stringify(value).length);
  return value.result;
}

function requireUndelivered(compact: Reason, full: Reason, limit: number) {
  const result = requireFull(full);
  expect(bytes(compact)).toBeLessThanOrEqual(limit);
  expect(compact.no_conclusion).toEqual([result.outcome, [result.source_interpretation_id,
    result.query_semantics_id, result.semantic_correspondence_id, result.conditional_computation_id], result.query_gaps]);
  expect(result.query_gaps).toEqual(queryOf().gaps);
  expect(result.query_gaps?.length).toBeGreaterThan(0);
  const control = sourceSemanticReasonControl(compact);
  expect(control.outcome).toEqual(result.outcome);
  expect(control.query_gaps).toEqual(result.query_gaps);
  expect(control).not.toHaveProperty("attention");
  expect(control).not.toHaveProperty("source_target");
  for (const key of ["result", "interpretation", "query", "semantic_correspondence", "context", "attention", "proofs", "provider_attempts"]) {
    expect(compact).not.toHaveProperty(key);
  }
  expect(compact.coverage).toEqual({ ...full.coverage, payload: "truncated" });
  if (compact.source_disclosure === undefined || full.source_disclosure === undefined) throw new Error("source disclosures required");
  // CLI calls pin their own real clocks; all other source qualifications must remain identical.
  const compactDisclosure = sourceDisclosure(compact.source_disclosure), fullDisclosure = sourceDisclosure(full.source_disclosure);
  expect(compactDisclosure).toEqual({ ...fullDisclosure, evaluated_as_of: compactDisclosure.evaluated_as_of });
  expect(Date.parse(compactDisclosure.evaluated_as_of)).toBeGreaterThanOrEqual(Date.parse(fullDisclosure.evaluated_as_of));
  expect(compactDisclosure.proof_use).toEqual({ kind: "conditional_support", qualification: "not_world_claim" });
  expect(compact.execution).toBe("native_reasoning_only");
  expect(compact.work.native_work).toBeGreaterThan(0);
  expect(compact.work.native_bytes).toBeGreaterThan(0);
  expect(compact.work.logical_work).toBeGreaterThan(compact.work.native_work);
  expect(compact.work.logical_memory_bytes).toBeGreaterThan(0);
  expect(compact.work.rss_bytes).toBeGreaterThan(0);
  expect(compact.work.native_work).toBe(full.work.native_work);
  expect(compact.work.native_bytes).toBe(full.work.native_bytes);
}

it("preserves full multibyte evidence first and undelivered H/Q/C/computation controls through built worker and public MCP", async () => {
  await withAccessLibrary(sources, async ({ execute, ids, port }) => {
    const id = ids.get(sourceId)?.[0];
    if (id === undefined) throw new Error("published interpretation expected");
    const query = queryOf(), correspondence = correspondenceOf(id, query);
    const request = { accepts_unreviewed_conditional_results: true as const, source_interpretation_id: id,
      original_query: ORIGINAL, query_semantics: query, semantic_correspondence: correspondence, budget };
    const full = await accessCall(execute, { kind: "reason", ...request, output_byte_limit: 1_000_000 });
    requireFull(full);
    const native = await accessCall(execute, { kind: "reason", ...request, output_byte_limit: 1600 });
    requireUndelivered(native, full, 1600);
    expect(SourceSemanticWorkerResultSchema.safeParse(native).success).toBe(true);
    const handler = createMcpMemoryToolHandler({ ...createDeps(), now: () => CLOCK, sourceSemanticsPort: port });
    const context = { workspaceId: WS, runId: "compact-reason", agentTarget: "codex", sessionId: "compact-reason" };
    const mcp = async (arguments_: unknown) => {
      const response = await callAlayaMcpMemoryTool({ memoryToolHandler: handler, contextProvider: () => context },
        "soul.interpretation", arguments_);
      if (response.structuredContent?.ok !== true) throw new Error(JSON.stringify(response));
      const output = SoulInterpretationResponseSchema.parse(response.structuredContent.output);
      if (output.operation !== "reason") throw new Error("public reason expected");
      return output;
    };
    const publicRequest = { operation: "reason", ...request, authorized_scopes: scopes };
    const publicFull = await mcp({ ...publicRequest, output_byte_limit: 1_000_000 });
    requireFull(publicFull);
    const publicCompact = await mcp({ ...publicRequest, output_byte_limit: 1600 });
    requireUndelivered(publicCompact, publicFull, 1600);
    expect(publicCompact.no_conclusion).toEqual(native.no_conclusion);
    const { query_semantics: _query, semantic_correspondence: _correspondence, ...preparationRequest } = request;
    const nativePreparation = await accessCall(execute, { kind: "reason", ...preparationRequest, output_byte_limit: 1024 });
    const publicPreparation = await mcp({ operation: "reason", ...preparationRequest, output_byte_limit: 1024, authorized_scopes: scopes });
    for (const preparation of [nativePreparation, publicPreparation]) {
      expect(bytes(preparation)).toBeLessThanOrEqual(1024);
      expect(sourceSemanticReasonControl(preparation).outcome).toEqual({ status: "preparation_required",
        missing: "query_semantics_and_correspondence" });
      expect(preparation.execution).toBe("native_reasoning_only");
      expect(preparation).not.toHaveProperty("provider_attempts");
      expect(preparation).not.toHaveProperty("result");
    }
    console.info("multibyte preparation delivery bytes", { native: bytes(nativePreparation), public: bytes(publicPreparation) });
    console.info("multibyte finished delivery bytes", { nativeFull: bytes(full), native: bytes(native),
      publicFull: bytes(publicFull), public: bytes(publicCompact), measuredWork: publicCompact.work });
  });
}, 30_000);

it("retains original 1024 and 1600 caps through the actual provider-free CLI session without relabelling measured work", async () => {
  await withAccessLibrary(sources, async ({ filename, ids }) => {
    const id = ids.get(sourceId)?.[0];
    if (id === undefined) throw new Error("published interpretation expected");
    await withCliInterpretationSession(dirname(filename), WS, RUN, async call => {
      const request = { operation: "reason", accepts_unreviewed_conditional_results: true,
        source_interpretation_id: id, original_query: ORIGINAL, budget, authorized_scopes: scopes };
      const prepared = await call({ ...request, output_byte_limit: 1024 });
      expect(prepared.exitCode).toBe(0);
      const preparation = SoulInterpretationResponseSchema.parse(prepared.output);
      if (preparation.operation !== "reason") throw new Error("CLI reason expected");
      expect(bytes(preparation)).toBeLessThanOrEqual(1024);
      expect(sourceSemanticReasonControl(preparation).outcome).toEqual({ status: "preparation_required",
        missing: "query_semantics_and_correspondence" });
      expect(preparation.execution).toBe("native_reasoning_only");
      expect(preparation.work.native_work).toBeGreaterThan(0);
      expect(preparation).not.toHaveProperty("result");
      const semanticRequest = { ...request, query_semantics: queryOf(), semantic_correspondence: correspondenceOf(id, queryOf()) };
      const fullRow = await call({ ...semanticRequest, output_byte_limit: 1_000_000 });
      expect(fullRow.exitCode).toBe(0);
      const full = SoulInterpretationResponseSchema.parse(fullRow.output);
      if (full.operation !== "reason") throw new Error("full CLI reason expected");
      requireFull(full);
      const compactRow = await call({ ...semanticRequest, output_byte_limit: 1600 });
      expect(compactRow.exitCode).toBe(0);
      const compact = SoulInterpretationResponseSchema.parse(compactRow.output);
      if (compact.operation !== "reason") throw new Error("compact CLI reason expected");
      requireUndelivered(compact, full, 1600);
      console.info("CLI delivery bytes", { preparation: bytes(preparation), full: bytes(full), compact: bytes(compact), measuredWork: compact.work });
    });
  });
}, 45_000);
