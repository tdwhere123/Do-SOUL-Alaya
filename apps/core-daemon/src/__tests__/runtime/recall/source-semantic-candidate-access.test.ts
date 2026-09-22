import { expect, it } from "vitest";
import { closeCachedDatabase } from "@do-soul/alaya-storage";
import { encodeSourceSemanticLibraryResponse } from "@do-soul/alaya-core";
import { createSourceSemanticInterpretationHandler } from "../../../mcp-memory/tool/interpretation-handler.js";
import { createRecallRealStorage } from "../../../../../../packages/core/src/__tests__/shared/real-sqlite.test-support.js";
import { ACCESS_BUDGET, CLOCK, WS, accessCall, accessQuery, withAccessLibrary } from "./source-semantic-access.test-support.js";

const orchid = "orchid irrigation", jasmine = "jasmine pruning";
const prepare = (original: string) => ({ kind: "prepare_query" as const, original_query: original,
  query_semantics: accessQuery(original), budget: ACCESS_BUDGET });

it("orders the complete observed pool for two queries before native descriptor pages and keeps raw sources without interpretations", async () => {
  await withAccessLibrary([
    { id: "filler", text: "Granite walls surround the courtyard.", reading: "surround", count: 128 },
    { id: "orchard", text: "Orchid irrigation.", reading: orchid },
    { id: "garden", text: "Jasmine pruning.", reading: jasmine },
    { id: "raw", text: "Orchid irrigation notes remain available." },
    { id: "private", text: "Orchid irrigation.", reading: orchid, scope: "global_core" }
  ], async ({ execute, ids }) => {
    const canonical = await accessCall(execute, { ...prepare(orchid), access_policy: "canonical-v1" });
    const canonicalIds = canonical.access!.interpretation_candidates.map((row) => row.interpretation_id);
    let cursor = canonical.continuation_handle;
    while (cursor !== undefined) {
      const page = await accessCall(execute, { ...prepare(orchid), access_policy: "canonical-v1", continuation_handle: cursor });
      expect(page.access?.pool_id).toBe(canonical.access?.pool_id);
      canonicalIds.push(...page.access!.interpretation_candidates.map((row) => row.interpretation_id));
      cursor = page.continuation_handle;
    }
    const first = await accessCall(execute, prepare(orchid)), second = await accessCall(execute, prepare(jasmine));
    expect(first.candidates[0]?.source_id).toBe("orchard");
    expect(second.candidates[0]?.source_id).toBe("garden");
    expect(first.access?.observed_interpretation_count).toBe(130);
    expect(first.access?.interpretation_candidates).toHaveLength(16);
    expect(first.access?.unvisited_interpretations).toBe(false);
    expect(first.access?.unvisited_sources).toBe(false);
    expect(first.access?.source_candidates.some((row) => row.source_id === "raw")).toBe(true);
    expect(first.access?.source_candidates.some((row) => row.source_id === "private")).toBe(false);
    expect(first.access?.interpretation_candidates.some((row) => ids.get("private")?.includes(row.interpretation_id))).toBe(false);
    expect(canonicalIds).toEqual([...canonicalIds].sort());
    expect(Math.max(canonicalIds.indexOf(ids.get("orchard")![0]!), canonicalIds.indexOf(ids.get("garden")![0]!))).toBeGreaterThan(32);
    expect(first.access?.pool_id).not.toBe(second.access?.pool_id);
    expect(first.access?.input_id).not.toBe(canonical.access?.input_id);
    const continued = await accessCall(execute, { ...prepare(orchid), continuation_handle: first.continuation_handle! });
    expect(continued.access?.pool_id).toBe(first.access?.pool_id);
    expect(continued.access?.trace).toMatchObject({ kind: "preparation_page", interpretation_offset: 16 });
    expect(continued.candidates).toHaveLength(16);
    expect(continued.candidates.every((row) => !first.candidates.some((prior) => prior.interpretation_id === row.interpretation_id))).toBe(true);
    const recalled = await accessCall(execute, { kind: "recall", accepts_unreviewed_conditional_results: true,
      query_handle: first.query_handle!, semantic_correspondences: [], budget: ACCESS_BUDGET, output_byte_limit: 1_000_000 });
    expect(recalled.discovery.visited_source_interpretation_descriptors).toBe(130);
    expect(recalled.discovery.access?.pool_id).toBe(first.access?.pool_id);
    expect(recalled.discovery.access?.trace).toMatchObject({ kind: "library_selection", omitted_interpretation_count: 130 });
    expect(recalled.proofs ?? []).toHaveLength(0);
    expect(recalled.slot_qualifiers.some((row) => row.evidence_kind === "source_evidence")).toBe(true);
    const direct = await accessCall(execute, { kind: "recall", accepts_unreviewed_conditional_results: true,
      original_query: orchid, query_semantics: accessQuery(orchid), semantic_correspondences: [], budget: ACCESS_BUDGET, output_byte_limit: 1_000_000 });
    expect(direct.discovery.access).toEqual(recalled.discovery.access);
    expect(first.work.native_bytes).toBeGreaterThan(0);
    expect(first.work.logical_work).toBeLessThanOrEqual(ACCESS_BUDGET.work_units);
    expect(first.work.logical_memory_bytes).toBeLessThanOrEqual(ACCESS_BUDGET.memory_bytes);
  });
});

it("rejects changed query, budget, policy, scope and stale revision instead of borrowing a frozen access cursor", async () => {
  await withAccessLibrary([{ id: "orchard", text: "Orchid irrigation.", reading: orchid, count: 20 }], async ({ execute, filename }) => {
    const request = prepare(orchid), first = await accessCall(execute, request);
    const continued = { ...request, continuation_handle: first.continuation_handle! };
    await expect(accessCall(execute, { ...continued, original_query: jasmine, query_semantics: accessQuery(jasmine) })).rejects.toThrow(/query|retarget/u);
    await expect(accessCall(execute, { ...continued, budget: { ...ACCESS_BUDGET, work_units: ACCESS_BUDGET.work_units - 1 } })).rejects.toThrow(/budget/u);
    await expect(accessCall(execute, { ...continued, access_policy: "canonical-v1" })).rejects.toThrow(/policy/u);
    await expect(accessCall(execute, continued, ["global_core"])).rejects.toThrow(/scope/u);
    const current = await createRecallRealStorage(() => undefined, filename);
    current.database.connection.prepare("UPDATE source_records SET scope_class = 'global_core' WHERE source_id = 'orchard'").run();
    current.database.close(); closeCachedDatabase(filename);
    await expect(accessCall(execute, continued)).rejects.toThrow(/snapshot/u);
  });
});

it("uses verified predicate readings as an access-only paraphrase bridge and leaves unsupported paraphrases unranked", async () => {
  await withAccessLibrary([
    { id: "s01", text: "The launch was put off.", reading: "postpone" },
    { id: "s02", text: "The launch went ahead.", reading: "proceed" }
  ], async ({ execute, ids }) => {
    const query = "defer", bridged = await accessCall(execute, { ...prepare(query), query_semantics: accessQuery(query, "postpone") });
    const blind = await accessCall(execute, prepare(query));
    const positive = bridged.access!.interpretation_candidates.find((row) => row.interpretation_id === ids.get("s01")![0])!;
    const foil = bridged.access!.interpretation_candidates.find((row) => row.interpretation_id === ids.get("s02")![0])!;
    expect(positive.signal.source_text_score).toBe(foil.signal.source_text_score);
    expect(positive.signal.interpretation_reading_score).toBeGreaterThan(foil.signal.interpretation_reading_score);
    expect(positive.signal.reading).toEqual({ query_alternative: 0, query_frame: "qStatement", source_frame: "fStatement" });
    expect(bridged.candidates[0]?.source_id).toBe("s01");
    expect(blind.access?.interpretation_candidates.every((row) => row.signal.interpretation_reading_score === 0)).toBe(true);
    expect(bridged.coverage.semantic_correspondence).toBe("unexercised");
    expect(bridged.coverage.conditional_computation).toBe("unexercised");
  });
});

it("preserves lexical role foils and query order under source ID and insertion order changes through the public handler", async () => {
  for (const reversed of [false, true]) {
    const sources = [{ id: reversed ? "z9" : "a1", text: "Alice helps Bob.", reading: "help" },
      { id: reversed ? "a1" : "z9", text: "Bob helps Alice.", reading: "help" },
      { id: "middle", text: "Granite walls surround the courtyard.", reading: "surround" }];
    await withAccessLibrary(reversed ? sources.reverse() : sources, async ({ execute }) => {
      const handler = createSourceSemanticInterpretationHandler({ now: () => CLOCK, sourceSemanticsPort: { execute } });
      const original = "Who helps whom: Alice or Bob?";
      const result = await handler({ operation: "prepare_query", original_query: original,
        query_semantics: accessQuery(original, "help"), budget: ACCESS_BUDGET, access_policy: "query-conditioned-v1",
        authorized_scopes: { mode: "named", scopes: ["project"] } },
      { workspaceId: WS, runId: "access-test", agentTarget: "codex", sessionId: "access-test" });
      if (result.operation !== "prepare_query") throw new Error("public preparation expected");
      expect(result.access?.source_candidates).toHaveLength(3);
      const scores = result.access!.interpretation_candidates.map((row) => row.signal);
      expect(scores[0]!.source_text_score).toBe(scores[1]!.source_text_score);
      expect(scores[1]!.source_text_score!).toBeGreaterThan(scores[2]!.source_text_score!);
      expect(scores[0]!.interpretation_reading_score).toBe(scores[1]!.interpretation_reading_score);
      expect(result.provider_attempts).toBe(0);
      expect(result.coverage.conditional_computation).toBe("unexercised");
    });
  }
});

it.each([80_000, 200_000])("keeps unvisited growth and body tails open within %i work units", async (workUnits) => {
  await withAccessLibrary([{ id: "many", text: "Orchid irrigation.", reading: orchid, count: 60 },
    { id: "tail", text: "granite ".repeat(20_000) }], async ({ execute }) => {
    const budget = { ...ACCESS_BUDGET, work_units: workUnits, memory_bytes: 4_000_000 };
    const result = await accessCall(execute, { ...prepare(orchid), budget });
    expect(result.coverage.discovery).toBe("truncated");
    expect(result.access?.unvisited_sources).toBe(true);
    expect(result.access?.unvisited_interpretations).toBe(true);
    expect(result.access?.stopping_reasons).toContain("source_tail");
    expect(result.access?.stopping_reasons).toContain("budget");
    expect(result.access?.source_candidates.find((row) => row.source_id === "tail")?.complete).toBe(false);
    if (workUnits === 200_000) expect(result.access?.source_candidates.find((row) => row.source_id === "tail")?.read_bytes).toBeGreaterThan(0);
    expect(result.work.logical_work).toBeLessThanOrEqual(budget.work_units);
    expect(result.work.logical_memory_bytes).toBeLessThanOrEqual(budget.memory_bytes);
  });
});

it("pages all 512 observed source traces without rereading or overflowing the public envelope", async () => {
  await withAccessLibrary(Array.from({ length: 512 }, (_, index) => ({ id: `source-${String(index).padStart(3, "0")}`,
    text: "Orchid irrigation notes remain available." })), async ({ execute }) => {
    const prepared = await accessCall(execute, prepare(orchid));
    const request = { kind: "recall" as const, accepts_unreviewed_conditional_results: true as const,
      query_handle: prepared.query_handle!, semantic_correspondences: [], budget: ACCESS_BUDGET, output_byte_limit: 100_000 };
    expect(prepared.access?.observed_source_count).toBe(512);
    expect(prepared.access?.source_candidates).toHaveLength(16);
    expect(prepared.access?.unvisited_sources).toBe(true);
    const recalled = await accessCall(execute, request);
    const publicBytes = Buffer.byteLength(JSON.stringify(encodeSourceSemanticLibraryResponse(recalled)));
    expect(publicBytes).toBeLessThanOrEqual(request.output_byte_limit);
    expect(recalled.discovery.access?.source_candidates.length).toBeLessThanOrEqual(10);
    expect(recalled.discovery.access?.trace).toMatchObject({ kind: "library_selection", omitted_source_count: 502 });
    const seen = new Set(prepared.access!.source_candidates.map((row) => row.record_id));
    let cursor = prepared.continuation_handle, sourceOffset = 16;
    while (cursor !== undefined) {
      const page = await accessCall(execute, { ...prepare(orchid), continuation_handle: cursor });
      expect(page.access?.pool_id).toBe(prepared.access?.pool_id);
      expect(page.access?.trace).toMatchObject({ kind: "preparation_page", source_offset: sourceOffset });
      expect(page.work.native_work).toBe(0);
      expect(page.work.native_bytes).toBe(0);
      expect(page.candidates).toHaveLength(0);
      for (const row of page.access!.source_candidates) { expect(seen.has(row.record_id)).toBe(false); seen.add(row.record_id); }
      sourceOffset += page.access!.source_candidates.length;
      cursor = page.continuation_handle;
    }
    expect(seen.size).toBe(512);
    expect(Buffer.byteLength(JSON.stringify(prepared.access))).toBeLessThan(5_000);
    expect(Buffer.byteLength(JSON.stringify(recalled.discovery.access))).toBeLessThan(4_000);
  });
}, 60_000);

it("keeps a complete source census complete while a later trace page remains unshown", async () => {
  await withAccessLibrary(Array.from({ length: 17 }, (_, index) => ({ id: `source-${index}`, text: "Orchid irrigation." })), async ({ execute }) => {
    const first = await accessCall(execute, prepare(orchid));
    expect(first.access?.observed_source_count).toBe(17);
    expect(first.access?.unvisited_sources).toBe(false);
    expect(first.access?.trace).toMatchObject({ kind: "preparation_page", source_offset: 0, omitted_source_count: 1 });
    expect(first.candidates).toHaveLength(0);
    expect(first.coverage.discovery).toBe("complete");
    expect(first.truncated).toBe(true);
    const next = await accessCall(execute, { ...prepare(orchid), continuation_handle: first.continuation_handle! });
    expect(next.access?.pool_id).toBe(first.access?.pool_id);
    expect(next.access?.trace).toMatchObject({ kind: "preparation_page", source_offset: 16 });
    expect(next.work.native_bytes).toBe(0);
    expect(next.continuation_handle).toBeUndefined();
    expect(next.coverage.discovery).toBe("complete");
    expect(next.truncated).toBe(false);
  });
});
