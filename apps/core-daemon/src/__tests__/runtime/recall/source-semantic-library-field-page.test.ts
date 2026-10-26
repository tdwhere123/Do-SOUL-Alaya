import { afterAll, afterEach, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../../../../bench-runner/src/__tests__/support/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
afterEach(() => { expect(isolation.violations).toEqual([]); vi.restoreAllMocks(); });
afterAll(() => isolation.restore());
import {
  SOURCE_SEMANTIC_FIELD_LIBRARY_PROTOCOL_VERSION, SoulInterpretationRequestSchema, SoulInterpretationResponseSchema,
  indexEntryCacheKey, sourceDisclosure, type SoulInterpretationResponse, type SourceSemanticWorkerResult
} from "@do-soul/alaya-protocol";
import { capableRecallConsumerDeclaration, deliveredSourceSemanticLibraryProof,
  type CoreError } from "@do-soul/alaya-core";
import { createMcpMemoryToolHandler } from "../../../mcp-memory/tool/tool-handler.js";
import { callAlayaMcpMemoryTool } from "../../../mcp/server/mcp-server.js";
import { createDeps } from "../../mcp-memory/tool/mcp-memory-tool-handler-fixture.js";
import { runOperation } from "../../../runtime/recall-read-worker/dispatch.js";
import { RECALL_READ_WORKER_PROTOCOL_VERSION } from "../../../runtime/recall-read-worker/protocol.js";
import type { RecallReadWorkerRuntime } from "../../../runtime/recall-read-worker/runtime.js";
import { ACCESS_BUDGET, CLOCK, WS, withAccessLibrary, type AccessFixtureSource }
  from "./source-semantic-access.test-support.js";
import { createRecallRealStorage } from "../../../../../../packages/core/src/__tests__/shared/real-sqlite.test-support.js";
import { closeCachedDatabase } from "@do-soul/alaya-storage";
import { MemoryDimension } from "@do-soul/alaya-protocol";
import { MEM, NOW, openSourceSlice } from "../../../../../../packages/core/src/__tests__/recall/conditional-field/vertical/source-slice.js";
import { createRecallReadWorkerClient } from "../../../runtime/recall/recall-read-worker-client.js";
import { builtWorkerUrl } from "./recall-read-worker-client-fixture.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareIndexedRecallProjection, type StorageDatabase } from "@do-soul/alaya-storage";
import { encodeBytes, fixtureSources, ORIGINAL, queryOf, recallRequest }
  from "./source-semantic-library-binding-coverage.js";
import { publishIndexedGeneration } from "./recall-storage.test-support.js";
import { createSqliteFieldFormationStores } from "../../../runtime/field/sqlite-field-formation-stores.js";
import { createDaemonFieldRepos } from "../../../runtime/field/field-repos.js";
import { createSourceSemanticInterpretationHandler } from "../../../mcp-memory/tool/interpretation-handler.js";

import { captureFieldProofRequests } from "./field-proof-consumer.test-support.js";

const proofRequests = new WeakMap<Recall, ReturnType<typeof captureFieldProofRequests>>();
type Recall = Extract<SoulInterpretationResponse, { operation: "recall" }> & Readonly<{
  index: NonNullable<Extract<SoulInterpretationResponse, { operation: "recall" }>["index"]>;
  results: NonNullable<Extract<SoulInterpretationResponse, { operation: "recall" }>["results"]>;
  slot_qualifiers: NonNullable<Extract<SoulInterpretationResponse, { operation: "recall" }>["slot_qualifiers"]>;
  discovery: NonNullable<Extract<SoulInterpretationResponse, { operation: "recall" }>["discovery"]>;
  query_semantics_status: NonNullable<Extract<SoulInterpretationResponse, { operation: "recall" }>["query_semantics_status"]>;
}>;
type WorkerRecall = Extract<SourceSemanticWorkerResult, { kind: "recall" }> & Readonly<{
  preparation_id?: string; previews?: Readonly<Record<string, string>>; field_execution_receipt?: unknown;
}>;
const SCOPES = { mode: "named" as const, scopes: ["project"] };
const CONTEXT = { workspaceId: WS, runId: "library-field-page", agentTarget: "codex" as const,
  sessionId: "library-field-page" };

function handlerFor(port: Parameters<typeof createMcpMemoryToolHandler>[0]["sourceSemanticsPort"]) {
  return createMcpMemoryToolHandler({ ...createDeps(), now: () => CLOCK, sourceSemanticsPort: port });
}

async function callPublic(port: Parameters<typeof createMcpMemoryToolHandler>[0]["sourceSemanticsPort"],
  request: unknown): Promise<Recall> {
  if (port === undefined) throw new Error("worker port required");
  const captured = captureFieldProofRequests(port);
  const response = await callAlayaMcpMemoryTool({ memoryToolHandler: handlerFor(captured.port), contextProvider: () => CONTEXT },
    "soul.interpretation", SoulInterpretationRequestSchema.parse(request));
  const body = response.structuredContent as { ok?: boolean; output?: unknown };
  if (body.ok !== true) throw new Error(`public recall failed: ${JSON.stringify(body)}`);
  const parsed = SoulInterpretationResponseSchema.parse(body.output);
  if (parsed.operation !== "recall" || parsed.index === undefined || parsed.results === undefined
    || parsed.slot_qualifiers === undefined || parsed.discovery === undefined
    || parsed.query_semantics_status === undefined) throw new Error("completed recall expected");
  const recall = parsed as Recall;
  proofRequests.set(recall, captured);
  return recall;
}

/** The public surface carries the same request under its operation tag. */
function publicRecallRequest(ids: Parameters<typeof recallRequest>[0], limit?: number) {
  const { kind, ...fields } = recallRequest(ids, ACCESS_BUDGET.work_units, limit);
  return { operation: kind, ...fields };
}

/** Disclosure is a codec tuple; its typed accessor owns the qualification fields. */
function disclosureUse(recalled: Recall, entry: Recall["index"]["entries"][number]) {
  const wire = recalled.source_disclosures![indexEntryCacheKey(entry)];
  return wire === undefined ? undefined : sourceDisclosure(wire).proof_use.kind;
}

/** Membership order is native; a page is the bounded prefix the codec can carry. */
function rootsOf(recall: Recall | WorkerRecall): string[] {
  return recall.index.entries.flatMap(entry => entry.target.kind === "source_evidence" ? [entry.target.root_id] : []);
}

const indexed = (sources: readonly AccessFixtureSource[]) => async (database: StorageDatabase) => {
  await publishIndexedGeneration(database, sources.map(row => ({ text: row.text })));
};

async function publicProofPage(port: Parameters<typeof callPublic>[0], ids: Parameters<typeof publicRecallRequest>[0]) {
  const request = publicRecallRequest(ids);
  let page = await callPublic(port, request);
  const visited = new Set<string>();
  // Source records and their retained capsules are distinct roots. A first page
  // need not contain a proof; continue the same lease without increasing its budget.
  for (let remaining = ids.size * 2; remaining > 0; remaining -= 1) {
    if (page.slot_qualifiers.some(slot => slot.evidence_kind === "semantic_proof")) return page;
    if (remaining === 1) break;
    const continuation = page.index.continuation;
    if (continuation == null) throw new Error("delivery ended without a positive proof witness");
    const cursor = `${continuation.continuation_id}:${continuation.cursor}`;
    expect(visited.has(cursor)).toBe(false);
    visited.add(cursor);
    page = await callPublic(port, { ...request, continuation });
  }
  throw new Error("proof witness was not delivered within the fixture's bounded pages");
}

it("delivers the tagged native field page with visible Q/H/C support and no private worker fields", async () => {
  const sources = fixtureSources();
  await withAccessLibrary(sources, async ({ ids, port, filename }) => {
    const recalled = await publicProofPage(port, ids);
    expect(recalled.protocol_version).toBe(SOURCE_SEMANTIC_FIELD_LIBRARY_PROTOCOL_VERSION);
    expect(recalled.index.result_version).toBe("ordinary-native-field.v4");
    expect(recalled.results).toHaveLength(recalled.index.entries.length);
    expect(recalled.total_count).toBe(recalled.index.entries.length);
    // Proofs are side evidence: the shared field delivers tagged source slots only.
    expect(recalled.results.every(row => row.target?.kind === "source_evidence" && row.object_kind === "source_evidence")).toBe(true);
    const proofSlots = recalled.slot_qualifiers.filter(row => row.evidence_kind === "semantic_proof");
    expect(proofSlots.length).toBeGreaterThan(0);
    expect(recalled.proofs?.length).toBeGreaterThan(0);
    const { database } = await createRecallRealStorage(() => undefined, filename);
    const stores = createSqliteFieldFormationStores({ database, repos: createDaemonFieldRepos({ database }) });
    try {
    for (const slot of proofSlots) {
      const entry = recalled.index.entries[slot.index];
      if (entry === undefined) throw new Error("proof slot must reference a delivered entry");
      // A proof claim is admitted only when the delivered interval exposes its own text.
      expect(entry.target.kind === "source_evidence" && entry.target.span?.content_complete).toBe(true);
      expect(disclosureUse(recalled, entry)).toBe("conditional_support");
      const delivered = recalled.proofs?.find(row => row.source_interpretation_id === slot.source_interpretation_id);
      expect(delivered).toBeDefined();
      // Binding presence is not verification: Core re-executes the accepting witness.
      const verified = deliveredSourceSemanticLibraryProof(recalled.index, entry, slot, recalled.proofs!,
        stores.getCurrentRecord(WS, delivered!.source_record.source_id)!, ACCESS_BUDGET,
        proofRequests.get(recalled)!.trust(recalled.delivery_id,
          stores.getStoredRecord(WS, delivered!.source_record.identity)));
      expect(verified.proof).toBeDefined();
    }
    } finally { database.close(); }
    for (const [position, entry] of recalled.index.entries.entries()) {
      if (recalled.slot_qualifiers.some(row => row.index === position && row.evidence_kind === "semantic_proof")) continue;
      expect(disclosureUse(recalled, entry)).toBe("source_only");
    }
    expect(recalled).not.toHaveProperty("preparation_id");
    expect(recalled).not.toHaveProperty("previews");
    expect(recalled.execution).toBeDefined();
  }, { prepareDatabase: indexed(sources) });
}, 60_000);

it("fits the exact public envelope under the caller byte limit or refuses without a zero-width page", async () => {
  const sources = fixtureSources();
  await withAccessLibrary(sources, async ({ ids, port }) => {
    let previous = Number.MAX_SAFE_INTEGER;
    const observed: { limit: number; entries: number }[] = [];
    for (const limit of [1_024, 2_048, 4_096, 1_000_000]) {
      let recalled: WorkerRecall;
      try {
        recalled = await port!.execute({ workspace_id: WS, as_of: CLOCK, authorized_scopes: SCOPES,
          request: { ...recallRequest(ids, ACCESS_BUDGET.work_units, limit), budget: ACCESS_BUDGET } }) as WorkerRecall;
      } catch (error) {
        // Refusal is its own resource outcome, never a silent empty or truncated page.
        expect((error as CoreError).code).toBe("CONFLICT");
        const details = (error as CoreError).details!;
        expect(details.outcome).toBe("resource_exhausted");
        // Work already incurred stays attached to the refusal under the existing work DTO,
        // without payloads and without reporting an unmeasured cost as zero.
        const work = details.work as { logical_work?: number; native_accounting?: string; rss_bytes?: number };
        expect(work.logical_work).toBeGreaterThan(0);
        expect(["complete", "partial"]).toContain(work.native_accounting);
        expect(work.rss_bytes).toBeGreaterThan(0);
        expect(Object.keys(details).some(key => /index|results|preview|source_body|content/u.test(key))).toBe(false);
        continue;
      }
      if (recalled.kind !== "recall") throw new Error("recall expected");
      const { kind: _kind, previews: _previews, preparation_id: _preparation,
        field_execution_receipt: _receipt, ...delivery } = recalled;
      expect(encodeBytes({ operation: "recall", ...delivery })).toBeLessThanOrEqual(limit);
      expect(recalled.index.entries.length).toBeGreaterThan(0);
      expect(recalled.index.entries.length).toBeLessThanOrEqual(previous);
      for (const entry of recalled.index.entries) {
        if (entry.target.kind !== "source_evidence" || entry.target.span === undefined) continue;
        expect(entry.target.span.content_end).toBeGreaterThan(entry.target.span.content_start);
      }
      previous = recalled.index.entries.length;
      observed.push({ limit, entries: recalled.index.entries.length });
    }
    expect(observed.at(-1)).toMatchObject({ limit: 1_000_000 });
  }, { prepareDatabase: indexed(sources) });
}, 60_000);

it("reports unknown native membership instead of a complete empty library page", async () => {
  const sources = fixtureSources();
  await withAccessLibrary(sources, async ({ port }) => {
    const recalled = await callPublic(port, publicRecallRequest(new Map()));
    expect(recalled.total_count).toBe(0);
    expect(recalled.results).toEqual([]);
    // An uninitialized native generation is open discovery, not certified source absence.
    expect(recalled.index.completeness.logical_index).not.toBe("complete");
    expect(recalled.discovery.truncated).toBe(true);
    expect(recalled.discovery.open_residuals).toBe(true);
    expect(recalled.coverage.discovery).not.toBe("complete");
  });
}, 60_000);

it("continues the frozen native membership through worker IPC without duplicating occupancy", async () => {
  const sources = fixtureSources();
  await withAccessLibrary(sources, async ({ ids, port }) => {
    const request = recallRequest(ids);
    const execute = port!.execute;
    const pages: WorkerRecall[] = [];
    const roots: string[] = [];
    for (let page = 0; page < 12; page += 1) {
      const previous = pages.at(-1)?.index.continuation ?? null;
      const recalled = await execute({ workspace_id: WS, as_of: CLOCK, lifetime_now: CLOCK,
        expires_at: "2026-09-18T00:10:00.000Z", authorized_scopes: SCOPES,
        request: { ...request, budget: { ...ACCESS_BUDGET, page_budget: 2 },
          ...(previous === null ? {} : { continuation: previous as never }) } }) as WorkerRecall;
      if (recalled.kind !== "recall") throw new Error("recall expected");
      pages.push(recalled);
      roots.push(...rootsOf(recalled));
      // The frozen page is issued only through the prepared-delivery acknowledgement.
      if (recalled.preparation_id !== undefined) {
        await port!.acknowledge!(recalled.preparation_id, recalled.index,
          new Map(Object.entries(recalled.previews ?? {})));
      }
      if (recalled.index.continuation === null) break;
    }
    expect(pages.at(-1)!.index.continuation).toBeNull();
    expect(pages.length).toBeGreaterThan(1);
    // No page is silently invalidated, and only a terminal page may carry no membership.
    expect(pages.every(page => page.index.completeness.logical_index !== "invalidated")).toBe(true);
    expect(pages.slice(0, -1).every(page => page.index.entries.length > 0)).toBe(true);
    expect(pages.at(-1)!.index.entries.length === 0 ? pages.length : 1).toBeGreaterThan(0);
    expect(new Set(roots).size).toBe(roots.length);
    expect(new Set(roots).size).toBe(fixtureSources().length);
    expect(pages.every(page => page.index.query_id === pages[0]!.index.query_id
      && page.index.snapshot_id === pages[0]!.index.snapshot_id)).toBe(true);
    expect(pages.every(page => page.request_identity === pages[0]!.request_identity)).toBe(true);
    // A frozen page stays bound to its request: a fresh page's continuation cannot be retargeted.
    const probe = await execute({ workspace_id: WS, as_of: CLOCK, lifetime_now: CLOCK,
      expires_at: "2026-09-18T00:10:00.000Z", authorized_scopes: SCOPES,
      request: { ...request, budget: { ...ACCESS_BUDGET, page_budget: 2 } } }) as WorkerRecall;
    const frozen = probe.index.continuation;
    if (frozen === null) throw new Error("probe page must continue");
    await expect(execute({ workspace_id: WS, as_of: CLOCK, lifetime_now: CLOCK, authorized_scopes: SCOPES,
      request: { ...request, budget: { ...ACCESS_BUDGET, page_budget: 2 }, continuation: frozen as never,
        semantic_correspondences: [] } })).rejects.toThrow(/library continuation request changed/u);
    await expect(execute({ workspace_id: WS, as_of: CLOCK, lifetime_now: CLOCK, authorized_scopes: SCOPES,
      request: { ...request, budget: { ...ACCESS_BUDGET, page_budget: 2 }, continuation: frozen as never,
        original_query: `${ORIGINAL} changed` } })).rejects.toThrow(/library continuation request changed/u);
    // A continuation past its frozen lifetime is refused by its lease owner, never silently resumed.
    await expect(execute({ workspace_id: WS, as_of: CLOCK, lifetime_now: "2026-09-18T01:00:00.000Z",
      authorized_scopes: SCOPES, request: { ...request, budget: { ...ACCESS_BUDGET, page_budget: 2 },
        continuation: frozen as never } })).rejects.toThrow(/expired/u);
  }, { prepareDatabase: indexed(sources) });
}, 60_000);


it("settles a prepared page once and retries its acknowledgement without reissuing membership", async () => {
  const sources = fixtureSources();
  await withAccessLibrary(sources, async ({ ids, port }) => {
    const recalled = await port!.execute({ workspace_id: WS, as_of: CLOCK, authorized_scopes: SCOPES,
      request: recallRequest(ids) }) as WorkerRecall;
    if (recalled.kind !== "recall") throw new Error("recall expected");
    const preparationId = recalled.preparation_id;
    if (preparationId === undefined) throw new Error("prepared library page required");
    const previews = new Map(Object.entries(recalled.previews ?? {}));
    await port!.acknowledge!(preparationId, recalled.index, previews);
    // A different envelope cannot be acknowledged against the prepared membership.
    await expect(port!.acknowledge!(preparationId, { ...recalled.index,
      entries: recalled.index.entries.slice(1) }, previews)).rejects.toThrow(/changed prepared membership/u);
    // A transport retry must not advance a successor or retain a second delivery.
    await port!.acknowledge!(preparationId, recalled.index, previews);
    await port!.discard!(preparationId);
    // A discarded preparation can never be re-issued.
    await expect(port!.acknowledge!(preparationId, recalled.index, previews)).rejects.toThrow();
  }, { prepareDatabase: indexed(sources) });
}, 60_000);

it("withdraws a proof claim and keeps the residual when its named premise is absent", async () => {
  const sources = fixtureSources();
  await withAccessLibrary(sources, async ({ ids, port }) => {
    const present = publicRecallRequest(ids);
    const absent = `sha256:${"b".repeat(64)}`;
    const withdrawn = { ...present, semantic_correspondences: present.semantic_correspondences!.map(row => ({
      ...row, source_interpretation_id: absent })) };
    const recalled = await callPublic(port, withdrawn);
    expect(recalled.query_semantics_status.status).toBe("admitted");
    expect(recalled.proofs ?? []).toEqual([]);
    expect(recalled.slot_qualifiers.every(row => row.evidence_kind === "source_evidence")).toBe(true);
    expect(recalled.index.entries.length).toBeGreaterThan(0);
    // The named-but-unread premise stays an explicit residual, and its cost is retained.
    expect(recalled.discovery.examined_source_interpretation_ids).toEqual([]);
    expect(recalled.discovery.unexamined_source_interpretation_count).toBe(1);
    expect(recalled.coverage.conditional_computation).toBe("open");
    expect(recalled.work.logical_work).toBeGreaterThan(0);
  }, { prepareDatabase: indexed(sources) });
}, 60_000);

it("denies an out-of-scope source before delivery while keeping the admitted source", async () => {
  const base = fixtureSources();
  const sources = [...base, { ...base[0]!, id: "global-only", scope: "global_core" as const }];
  await withAccessLibrary(sources, async ({ ids, port }) => {
    const recalled = await callPublic(port, { ...publicRecallRequest(ids), authorized_scopes: SCOPES });
    const globalId = ids.get("global-only")?.[0];
    expect(globalId).toBeDefined();
    expect(recalled.proofs?.some(row => row.source_interpretation_id === globalId) ?? false).toBe(false);
    expect(recalled.discovery.open_residuals).toBe(true);
    expect(rootsOf(recalled).length).toBeGreaterThan(0);
  }, { prepareDatabase: indexed(sources) });
}, 60_000);

it("reports paid envelope refusal before source I/O through the compiled worker", async () => {
  const directory = await mkdtemp(join(tmpdir(), "alaya-refused-page-"));
  const filename = join(directory, "alaya.db");
  const budget = { schema_version: 1 as const, work_units: 200_000, memory_bytes: 4_000_000,
    page_budget: 4, finalization_reserve: 10_000, min_envelope: 10 };
  const request = { workspace_id: WS, query_text: "needle", budget, requested_budget: budget,
    delivery_budget: { max_total_tokens: 2_000, max_encoded_bytes: 1_024 },
    snapshot_id: `sha256:${"d".repeat(64)}`, interpretation_clock: NOW, as_of: NOW,
    expires_at: new Date(Date.parse(NOW) + 600_000).toISOString(), lifetime_now: NOW,
    protocol_version: 1, supported_result_kinds: ["memory_entry" as const], supports_source_evidence: true,
    supports_product_updates: true };
  try {
    const slice = await openSourceSlice(() => {}, filename);
    for (const [index, id] of [MEM.r, MEM.c, MEM.h, MEM.s].entries()) {
      await slice.writeMemory(id, `needle ${index}`, MemoryDimension.FACT);
    }
    slice.database.close();
    closeCachedDatabase(filename);
    const client = createRecallReadWorkerClient({ databaseFilename: filename, workerUrl: builtWorkerUrl, workerCount: 1 })!;
    try {
      await client.ready();
      // Even the required control cannot fit: refuse before source payload reads,
      // while retaining the actual snapshot-pin and framing expenditure.
      const failure = await client.conditionalFieldPort!.recall(request).then(() => undefined,
        (error: unknown) => error as CoreError);
      expect(failure).toBeDefined();
      expect(failure!.code).toBe("CONFLICT");
      const details = failure!.details!;
      expect(details).toMatchObject({ outcome: "resource_exhausted", resource: "encoded_page", available_bytes: 1_024 });
      expect(details.required_bytes).toBeGreaterThan(1_024);
      // Native pin work is not a source-byte or source-row measurement.
      const worker = details.worker as { native_visits?: number; bytes_read?: number; row_visits?: number;
        elapsed_ms?: number; rss_bytes?: number; rss_sampling_method?: string };
      expect(Number.isFinite(worker.native_visits) && worker.native_visits! > 0).toBe(true);
      expect(worker.bytes_read).toBe(0);
      expect(worker.row_visits).toBe(0);
      expect(Number.isFinite(worker.elapsed_ms) && worker.elapsed_ms! >= 0).toBe(true);
      expect(Number.isFinite(worker.rss_bytes) && worker.rss_bytes! > 0).toBe(true);
      expect(worker.rss_sampling_method).toBe("process.memoryUsage().rss");
      // No payload travels with the refusal.
      expect(Object.keys(details)).not.toContain("results");
      expect(Object.keys(details)).not.toContain("index");
    } finally { await client.close(); }
  } finally { closeCachedDatabase(filename); await rm(directory, { recursive: true, force: true }); }
}, 60_000);

it("executes a peer recall payload that predates the optional surface delivery fields", async () => {
  const sources = fixtureSources();
  await withAccessLibrary(sources, async ({ filename }) => {
    const { database } = await createRecallRealStorage(() => undefined, filename);
    prepareIndexedRecallProjection(database);
    try {
      const runtime = { database, closed: false } as unknown as RecallReadWorkerRuntime;
      const result = await runOperation(runtime, { protocol_version: RECALL_READ_WORKER_PROTOCOL_VERSION, id: 1,
        operation: "conditionalField.recall", payload: { workspace_id: WS, query_text: ORIGINAL,
          budget: { ...ACCESS_BUDGET, page_budget: 4 }, snapshot_id: `sha256:${"c".repeat(64)}`,
          interpretation_clock: CLOCK, as_of: CLOCK, expires_at: "2026-09-18T00:10:00.000Z",
          authorized_scopes: SCOPES, ...capableRecallConsumerDeclaration() } });
      // The optional surface fields stay optional on the wire; the field keeps its own default.
      expect(result).toMatchObject({ index: { result_version: "ordinary-native-field.v4" } });
    } finally { database.close(); }
  });
}, 60_000);

it("keeps the continuation lease's frozen interpretation clock across later caller clocks", async () => {
  const sources = fixtureSources();
  await withAccessLibrary(sources, async ({ ids, port }) => {
    const request = recallRequest(ids);
    const clockAt = (page: number) => new Date(Date.parse(CLOCK) + page * 10_000).toISOString();
    const pages: WorkerRecall[] = [];
    let continuation: unknown;
    for (let page = 0; page < 12; page += 1) {
      const now = clockAt(page);
      const recalled = await port!.execute({ workspace_id: WS, as_of: now, lifetime_now: now,
        expires_at: new Date(Date.parse(CLOCK) + 600_000).toISOString(), authorized_scopes: SCOPES,
        request: { ...request, budget: { ...ACCESS_BUDGET, page_budget: 2 },
          ...(page === 0 ? {} : { continuation: continuation as never }) } }) as WorkerRecall;
      if (recalled.kind !== "recall") throw new Error("recall expected");
      pages.push(recalled);
      if (recalled.preparation_id !== undefined) {
        await port!.acknowledge!(recalled.preparation_id, recalled.index,
          new Map(Object.entries(recalled.previews ?? {})));
      }
      if (recalled.index.continuation === null) break;
      continuation = recalled.index.continuation;
    }
    expect(pages.length).toBeGreaterThan(1);
    // The public handler advances its clock, but every resumed page stays on the
    // interpretation clock frozen by its continuation lease.
    expect(pages.every(page => page.index.as_of === CLOCK)).toBe(true);
    expect(pages.every(page => page.request_identity === pages[0]!.request_identity)).toBe(true);
    expect(new Set(pages.flatMap(rootsOf)).size).toBe(fixtureSources().length);
  }, { prepareDatabase: indexed(sources) });
}, 60_000);

it("restricts field membership to the source bound by the query handle", async () => {
  const sources = fixtureSources().slice(0, 2).map((row, index) => ({ ...row, id: `scope-${index}` }));
  await withAccessLibrary(sources, async ({ port }) => {
    const scopes = { mode: "named" as const, scopes: ["project"] };
    const source = await port!.execute({ workspace_id: WS, as_of: CLOCK, authorized_scopes: scopes,
      request: { kind: "prepare_source", source_id: "scope-0", budget: ACCESS_BUDGET } });
    if (source.kind !== "prepare_source" || source.source_handle === undefined) {
      throw new Error("source preparation expected");
    }
    const prepared = await port!.execute({ workspace_id: WS, as_of: CLOCK, authorized_scopes: scopes,
      request: { kind: "prepare_query", source_handle: source.source_handle, original_query: ORIGINAL,
        query_semantics: queryOf(), budget: ACCESS_BUDGET } });
    if (prepared.kind !== "prepare_query" || prepared.query_handle === undefined) {
      throw new Error("query preparation expected");
    }
    const bound = new Set(prepared.access?.source_candidates.map(row => row.record_id));
    expect(bound.size).toBe(1);
    const recalled = await port!.execute({ workspace_id: WS, as_of: CLOCK, authorized_scopes: scopes,
      request: { kind: "recall", accepts_unreviewed_conditional_results: true, query_handle: prepared.query_handle,
        semantic_correspondences: [], budget: ACCESS_BUDGET, output_byte_limit: 1_000_000 } }) as WorkerRecall;
    if (recalled.kind !== "recall") throw new Error("recall expected");
    // Membership, not only request identity, is the prepared source.
    expect(recalled.index.entries.length).toBeGreaterThan(0);
    expect(recalled.index.entries.every(entry => entry.target.kind === "source_evidence"
      && bound.has(entry.target.root_id))).toBe(true);
    expect(recalled.discovery.eligible_source_count).toBe(1);
    expect(recalled.total_count).toBe(recalled.index.entries.length);
  }, { prepareDatabase: indexed(sources) });
}, 60_000);

it("discards a prepared page cancelled before settlement and keeps its incurred work", async () => {
  const sources = fixtureSources();
  await withAccessLibrary(sources, async ({ ids, port }) => {
    const controller = new AbortController(), calls: string[] = [];
    const wrapped = {
      ...port!,
      execute: async (input: Parameters<NonNullable<typeof port>["execute"]>[0]) => {
        const result = await port!.execute(input);
        if (input.request.kind === "recall") controller.abort(new Error("cancelled after worker preparation"));
        return result;
      },
      acknowledge: async (preparationId: string, index: Parameters<NonNullable<NonNullable<typeof port>["acknowledge"]>>[1],
        previews: Parameters<NonNullable<NonNullable<typeof port>["acknowledge"]>>[2]) => {
        calls.push("acknowledge");
        return port!.acknowledge!(preparationId, index, previews);
      },
      discard: async (preparationId: string) => {
        calls.push("discard");
        return port!.discard!(preparationId);
      }
    };
    const handler = createSourceSemanticInterpretationHandler({ now: () => CLOCK, sourceSemanticsPort: wrapped });
    const failure = await handler(SoulInterpretationRequestSchema.parse(publicRecallRequest(ids)),
      { ...CONTEXT, abortSignal: controller.signal }).then(() => undefined, (error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(calls).toEqual(["discard"]);
    // The worker already executed; cancellation keeps that measured work on the refusal.
    const work = (failure as Error & { details?: { work?: { logical_work?: number } } }).details?.work;
    expect(work?.logical_work).toBeGreaterThan(0);
  }, { prepareDatabase: indexed(sources) });
}, 60_000);

it("keeps measured worker cost on an ordinary settlement refusal through worker IPC", async () => {
  const sources = fixtureSources();
  await withAccessLibrary(sources, async ({ ids, port }) => {
    const recalled = await port!.execute({ workspace_id: WS, as_of: CLOCK, authorized_scopes: SCOPES,
      request: recallRequest(ids) }) as WorkerRecall;
    const preparationId = recalled.preparation_id;
    if (preparationId === undefined) throw new Error("prepared library page required");
    // Changing the prepared membership is an ordinary Error in the worker owner, not a CoreError.
    const failure = await port!.acknowledge!(preparationId, { ...recalled.index,
      entries: recalled.index.entries.slice(1) }, new Map(Object.entries(recalled.previews ?? {})))
      .then(() => undefined, (error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error & { code?: string }).code).toBeUndefined();
    const detail = (failure as Error & { details?: Readonly<Record<string, unknown>> }).details;
    const worker = detail?.worker as { native_visits?: number; bytes_read?: number } | undefined;
    expect(worker?.native_visits).toBeGreaterThan(0);
    expect(worker?.bytes_read).toBeGreaterThan(0);
    // Cost metadata carries measurements only, never a payload.
    expect(Object.keys(detail!).sort()).toEqual(["worker"]);
  }, { prepareDatabase: indexed(sources) });
}, 60_000);

it("refuses the retired private comparison family instead of relabelling a field page", async () => {
  const sources = fixtureSources();
  await withAccessLibrary(sources, async ({ port }) => {
    expect(port).not.toHaveProperty("executeComparison");
    const failure = await port!.execute({ workspace_id: WS, as_of: CLOCK, authorized_scopes: SCOPES,
      comparison: { profile: { contract: "source-semantic-access-v3", result_version: "source-semantic-library-v7",
        protocol_version: 9, order_policy: "native-route-round-robin-v1",
        acquisition_policy: "source-index-grouped-round-robin.v1", channels: "dual",
        declared_allowance: { max_attempts: 64, max_roots: 18, max_vector_windows: 64 } } },
      request: { kind: "recall", original_query: ORIGINAL, query_semantics: queryOf(), budget: ACCESS_BUDGET,
        accepts_unreviewed_conditional_results: true, semantic_correspondences: [], output_byte_limit: 1_000_000 } } as never)
      .then(() => undefined, (error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(/comparison/u);
  }, { prepareDatabase: indexed(sources) });
}, 60_000);

it("rejects a delivered field proof bound to a foreign field query", async () => {
  const sources = fixtureSources();
  await withAccessLibrary(sources, async ({ ids, port, filename }) => {
    const recalled = await publicProofPage(port, ids);
    const slot = recalled.slot_qualifiers.find(row => row.evidence_kind === "semantic_proof");
    if (slot === undefined) throw new Error("proof slot required");
    const entry = recalled.index.entries[slot.index];
    const delivered = recalled.proofs?.find(row => row.source_interpretation_id === slot.source_interpretation_id);
    if (entry === undefined || delivered === undefined) throw new Error("delivered proof required");
    const { database } = await createRecallRealStorage(() => undefined, filename);
    try {
      const stores = createSqliteFieldFormationStores({ database, repos: createDaemonFieldRepos({ database }) });
      const trusted = stores.getCurrentRecord(WS, delivered.source_record.source_id)!;
      // The unmodified delivery verifies first; the denial below is not a vacuous
      // failure of an unrelated binding.
      const trust = proofRequests.get(recalled)!.trust(recalled.delivery_id,
        stores.getStoredRecord(WS, delivered.source_record.identity));
      expect(deliveredSourceSemanticLibraryProof(recalled.index, entry, slot, recalled.proofs!, trusted,
        ACCESS_BUDGET, trust).proof)
        .toBeDefined();
      // A proof admitted under another field query is not this page's premise, even
      // when every other delivered binding is unchanged.
      const foreign = { ...recalled.index, query_id: `sha256:${"f".repeat(64)}` };
      expect(deliveredSourceSemanticLibraryProof(foreign, entry, slot, recalled.proofs!, trusted,
        ACCESS_BUDGET, trust).proof)
        .toBeUndefined();
    } finally { database.close(); }
  }, { prepareDatabase: indexed(sources) });
}, 60_000);
