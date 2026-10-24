import { expect, it } from "vitest";
import { sourceSemanticExecutionPhases, SoulInterpretationRequestSchema, SoulInterpretationResponseSchema,
  type SourceSemanticCorrespondence, type SourceSemanticInterpretation, type SourceSemanticQuery } from "@do-soul/alaya-protocol";
import { projectSourceSemanticQuerySupport, SOURCE_SEMANTIC_CORRESPONDENCE_CORE_PRODUCER_ID } from "@do-soul/alaya-core";
import { callAlayaMcpMemoryTool } from "../../../mcp/server/mcp-server.js";
import { createMcpMemoryToolHandler } from "../../../mcp-memory/tool/tool-handler.js";
import { createDeps } from "../../mcp-memory/tool/mcp-memory-tool-handler-fixture.js";
import type { StorageDatabase } from "@do-soul/alaya-storage";
import { ACCESS_BUDGET, CLOCK, WS, accessCall, accessQuery, withAccessLibrary } from "./source-semantic-access.test-support.js";
import { publishIndexedGeneration } from "./recall-storage.test-support.js";
import { receiveAuthoredCorrespondence } from "./source-semantic-producer-fixture.js";

type Library = Parameters<Parameters<typeof withAccessLibrary>[1]>[0];
type IndexedSource = Readonly<{ text: string; verbatim?: boolean }>;

/** Live membership is the accepted native source-index generation. The fixture's
 * stored body is the same text admitted below (non-verbatim fixtures are prefixed).
 */
const indexed = (sources: readonly IndexedSource[]) => async (database: StorageDatabase) => {
  await publishIndexedGeneration(database, sources.map(row => ({
    text: row.verbatim === true ? row.text : `User: ${row.text}` })));
};
type PublicCall = ReturnType<typeof publicCall>;
const SCOPES = { mode: "named" as const, scopes: ["project"] };
const OUTPUT_BYTES = 1_000_000;

function publicCall(port: Library["port"]) {
  const handler = createMcpMemoryToolHandler({ ...createDeps(), now: () => CLOCK,
    sourceSemanticsPort: port });
  const context = { workspaceId: WS, runId: "native-matrix", agentTarget: "codex", sessionId: "native-matrix" };
  return async (arguments_: unknown) => {
    const result = await callAlayaMcpMemoryTool({ memoryToolHandler: handler, contextProvider: () => context },
      "soul.interpretation", SoulInterpretationRequestSchema.parse(arguments_));
    const body = result.structuredContent as { ok?: boolean; output?: unknown };
    if (body.ok !== true) throw new Error(`public interpretation failed: ${JSON.stringify(body)}`);
    return SoulInterpretationResponseSchema.parse(body.output);
  };
}

async function prepare(call: PublicCall, original: string, semantics: SourceSemanticQuery) {
  const output = await call({ operation: "prepare_query", original_query: original, query_semantics: semantics,
    budget: ACCESS_BUDGET, authorized_scopes: SCOPES });
  if (output.operation !== "prepare_query" || output.query_handle === undefined) throw new Error("public preparation expected");
  expect(sourceSemanticExecutionPhases(output.execution).query_preparation.external_api_attempts).toBe(0);
  return output;
}

async function recall(call: PublicCall, original: string, semantics: SourceSemanticQuery,
  semantic_correspondences: readonly SourceSemanticCorrespondence[], query_handle?: string,
  continuation?: object) {
  const output = await call({ operation: "recall", accepts_unreviewed_conditional_results: true,
    original_query: original, query_semantics: semantics, semantic_correspondences, budget: ACCESS_BUDGET,
    output_byte_limit: OUTPUT_BYTES, authorized_scopes: SCOPES,
    ...(query_handle === undefined ? {} : { query_handle }),
    ...(continuation === undefined ? {} : { continuation }) });
  if (output.operation !== "recall" || output.index === undefined || output.slot_qualifiers === undefined) {
    throw new Error("public library recall expected");
  }
  expect(sourceSemanticExecutionPhases(output.execution).query_preparation.external_api_attempts).toBe(0);
  return { ...output, index: output.index, slot_qualifiers: output.slot_qualifiers };
}

function interpretationOf(prepared: Awaited<ReturnType<typeof prepare>>, sourceId: string) {
  const descriptor = prepared.candidates.find(row => row.source_id === sourceId && row.interpretation !== undefined);
  if (descriptor?.interpretation === undefined) throw new Error(`published ${sourceId} is absent from native candidates`);
  return { interpretation: descriptor.interpretation, interpretationId: descriptor.interpretation_id };
}

function correspondence(prepared: Awaited<ReturnType<typeof prepare>>, sourceId: string,
  original: string, semantics: SourceSemanticQuery, queryFrame: string, person = false): SourceSemanticCorrespondence {
  const { interpretation, interpretationId } = interpretationOf(prepared, sourceId);
  const frame = interpretation.frames[0];
  if (frame === undefined) throw new Error("published source frame is absent");
  const pairs: SourceSemanticCorrespondence["correspondences"][number][] = [{
    relation: "contextual_equivalence", query_endpoint: { kind: "predicate", alternative: 0, frame: queryFrame },
    source_endpoint: { kind: "frame", frame: frame.id }, query_support: { kind: "query_text", excerpt: original },
    source_semantic_support: [{ kind: "lexical", mentions: ["mStatement"] }]
  }];
  if (person) pairs.push({ relation: "contextual_equivalence", query_endpoint: { kind: "slot", alternative: 0,
    frame: queryFrame, slot: "person" }, source_endpoint: { kind: "slot", frame: frame.id, slot: "person" },
    query_support: { kind: "query_text", excerpt: "Rana" }, source_semantic_support: [{ kind: "lexical", mentions: ["mPerson"] }] },
  { relation: "contextual_equivalence", query_endpoint: { kind: "referent", variable: "person" },
    source_endpoint: { kind: "referent", referent: "rPerson" }, query_support: { kind: "query_text", excerpt: "Rana" },
    source_semantic_support: [{ kind: "lexical", mentions: ["mPerson"] }] });
  const received = receiveAuthoredCorrespondence({ original_query: original, admitted_query_semantics: semantics,
    source_interpretation_descriptors: [{ source_interpretation_id: interpretationId,
      interpretation: interpretation as SourceSemanticInterpretation }],
    producer_id: SOURCE_SEMANTIC_CORRESPONDENCE_CORE_PRODUCER_ID, producer_version: "1" },
  { correspondences: pairs });
  if (received.semantic_correspondence === undefined) throw new Error(`correspondence failed for ${sourceId}: ${JSON.stringify(received.outcome)}`);
  return received.semantic_correspondence;
}

function evidenceQuery(original: string, readings: readonly string[]): SourceSemanticQuery {
  const base = accessQuery(original);
  const frames = readings.map((reading, input) => ({ id: `qFact${input}`, variable: `fact${input}`,
    predicate_reading: reading, role_requirements: [{ id: "person", role_reading: "person",
      target_variable: "person", support: { kind: "query_text" as const, excerpt: "Rana" } }] }));
  return { ...base, requested_operation: { reading: "retrieve the stated source facts",
    support: { kind: "query_text", excerpt: original } },
    variables: [{ id: "person", sort: "entity", reference: { kind: "query_text", excerpt: "Rana" } },
    ...readings.map((_, input) => ({ id: `fact${input}`, sort: "proposition" as const }))],
    alternatives: [{ frames, context_obligations: frames.map(frame => ({ frame: frame.id, kind: "asserted_at_source" as const })),
      answer_frames: [], evidence_inputs: frames.map(frame => ({ frames: [frame.id] })) }],
    return_variables: ["person"], gaps: [] };
}

function firstPageInputIds(recalled: Awaited<ReturnType<typeof recall>>): Set<number> {
  return new Set((recalled.proofs ?? []).flatMap(proof => proof.binding_results?.flatMap(binding =>
    binding.kind === "evidence" ? [binding.input] : []) ?? []));
}

it.each([31, 32, 33])("preserves finite pair closure and the 32-pair request cap with %i proposals", async (count) => {
  const original = "Orchid irrigation", semantics = accessQuery(original, "orchid irrigation");
  const fixture = [{ id: "orchard", text: "Orchid irrigation began in April.",
    reading: "orchid irrigation", count }];
  await withAccessLibrary(fixture, async ({ execute, port }) => {
    const request = { kind: "prepare_query" as const, original_query: original,
      query_semantics: semantics, budget: ACCESS_BUDGET };
    const first = await accessCall(execute, request);
    const descriptors = [...first.candidates];
    let cursor = first.continuation_handle;
    while (cursor !== undefined) {
      const page = await accessCall(execute, { ...request, continuation_handle: cursor });
      descriptors.push(...page.candidates); cursor = page.continuation_handle;
    }
    expect(descriptors).toHaveLength(count);
    expect(first.access?.unvisited_interpretations).toBe(false);
    const correspondences = descriptors.map((descriptor) => {
      if (descriptor.interpretation === undefined) throw new Error("native interpretation required");
      const received = receiveAuthoredCorrespondence({ original_query: original, admitted_query_semantics: semantics,
        source_interpretation_descriptors: [{ source_interpretation_id: descriptor.interpretation_id,
          interpretation: descriptor.interpretation }],
        producer_id: SOURCE_SEMANTIC_CORRESPONDENCE_CORE_PRODUCER_ID, producer_version: "1" },
      { correspondences: [{ relation: "contextual_equivalence",
        query_endpoint: { kind: "predicate", alternative: 0, frame: "qStatement" },
        source_endpoint: { kind: "frame", frame: "fStatement" },
        query_support: { kind: "query_text", excerpt: original },
        source_semantic_support: [{ kind: "lexical", mentions: ["mStatement"] }] }] });
      if (received.semantic_correspondence === undefined) throw new Error("correspondence receive failed");
      return received.semantic_correspondence;
    });
    const recallRequest = { kind: "recall" as const, query_handle: first.query_handle!,
      semantic_correspondences: correspondences, accepts_unreviewed_conditional_results: true as const,
      budget: ACCESS_BUDGET, output_byte_limit: OUTPUT_BYTES };
    if (count === 33) {
      await expect(accessCall(execute, recallRequest)).rejects.toThrow(/expected array to have <=32 items/u);
      return;
    }
    const recalled = await accessCall(execute, recallRequest);
    expect(recalled.discovery.examined_source_interpretation_ids).toHaveLength(count);
    expect(recalled.discovery.unexamined_source_interpretation_count).toBe(0);
    expect(recalled.discovery.open_residuals).toBe(false);
    expect(recalled.discovery.truncated).toBe(false);
    expect(recalled.coverage.discovery).toBe("complete");
  }, { prepareDatabase: indexed(fixture) });
}, 60_000);

it("changes native evidence preference for the same question across two different libraries with distractors", async () => {
  const original = "What happened to orchid irrigation?", semantics = accessQuery(original, "orchid irrigation");
  const libraries = [
    { expected: "event-a", text: "Orchid irrigation started in April.", sources: [
      { id: "event-a", text: "Orchid irrigation started in April.", reading: "orchid irrigation" },
      { id: "event-b", text: "Jasmine pruning ended in May.", reading: "jasmine pruning" },
      { id: "foil", text: "Granite walls surround the garden.", reading: "surround" }] },
    { expected: "event-b", text: "Orchid irrigation ended in May.", sources: [
      { id: "event-a", text: "Jasmine pruning started in April.", reading: "jasmine pruning" },
      { id: "event-b", text: "Orchid irrigation ended in May.", reading: "orchid irrigation" },
      { id: "foil", text: "Granite walls surround the garden.", reading: "surround" }] }
  ] as const;
  for (const library of libraries) await withAccessLibrary(library.sources, async ({ execute, ids, port }) => {
    const call = publicCall(port), prepared = await prepare(call, original, semantics);
    expect(prepared.access?.unvisited_sources).toBe(false);
    expect(prepared.access?.unvisited_interpretations).toBe(false);
    expect(prepared.candidates[0]?.source_id).toBe(library.expected);
    const aligned = correspondence(prepared, library.expected, original, semantics, "qStatement");
    const recalled = await recall(call, original, semantics, [aligned], prepared.query_handle);
    expect(recalled.index.entries.every(entry => entry.target.kind === "source_evidence")).toBe(true);
    expect(recalled.slot_qualifiers.some(row => row.evidence_kind === "semantic_proof"
      && row.source_interpretation_id === ids.get(library.expected)?.[0])).toBe(true);
    expect(recalled.results?.some(row => row.content_preview?.includes(library.text))).toBe(true);
    const proofSlot = recalled.slot_qualifiers.find(row => row.evidence_kind === "semantic_proof");
    expect(proofSlot?.index).toBeDefined();
    expect(recalled.index.entries[proofSlot!.index]?.target.kind).toBe("source_evidence");
  }, { prepareDatabase: indexed(library.sources) });
}, 60_000);

it("attributes a fixed native pool's proof change to supplied correspondence rather than candidate access", async () => {
  const original = "What happened to orchid irrigation?", semantics = accessQuery(original, "orchid irrigation");
  const fixture = [{ id: "support", text: "Orchid irrigation started in April.", reading: "orchid irrigation" },
    ...Array.from({ length: 6 }, (_, index) => ({ id: `distractor-${index}`, text: `Granite wall ${index} surrounds the garden.` }))];
  await withAccessLibrary(fixture, async ({ execute, ids, port }) => {
    const call = publicCall(port), prepared = await prepare(call, original, semantics);
    expect(prepared.access?.pool_id).toBeDefined();
    expect(prepared.access).toMatchObject({ observed_source_count: 7, observed_interpretation_count: 1,
      unvisited_sources: false, unvisited_interpretations: false });
    expect(prepared.access?.source_candidates).toHaveLength(7);
    expect(prepared.access?.interpretation_candidates).toHaveLength(1);
    const aligned = correspondence(prepared, "support", original, semantics, "qStatement");
    const proved = await recall(call, original, semantics, [aligned], prepared.query_handle);
    const raw = await recall(call, original, semantics, [], prepared.query_handle);
    // The field's native membership is unchanged by which correspondence was supplied.
    expect(proved.index.entries.map(row => row.target.kind === "source_evidence" ? row.target.root_id : ""))
      .toEqual(raw.index.entries.map(row => row.target.kind === "source_evidence" ? row.target.root_id : ""));
    expect(proved.discovery?.examined_source_interpretation_ids).toContain(ids.get("support")?.[0]);
    expect(raw.discovery?.examined_source_interpretation_ids).toEqual([]);
    expect(proved.slot_qualifiers.some(row => row.evidence_kind === "semantic_proof")).toBe(true);
    expect(raw.slot_qualifiers.every(row => row.evidence_kind === "source_evidence")).toBe(true);
    expect(proved.results?.[0]?.content_preview).toContain("Orchid irrigation started in April.");
    expect(raw.results?.some(row => row.content_preview?.includes("Orchid irrigation started in April."))).toBe(true);
  }, { prepareDatabase: indexed(fixture) });
}, 60_000);

it("delivers separate source-local joined and promoted facts without inventing a joint answer", async () => {
  const original = "Which records say Rana joined and Rana was promoted?";
  const semantics = evidenceQuery(original, ["joined", "promoted"]);
  const fixture = [
    { id: "joining", text: "Rana joined Larch Studio on June 1.", reading: "joined", person: "Rana" },
    { id: "promotion", text: "Rana was promoted at Larch Studio on June 13.", reading: "promoted", person: "Rana" }
  ];
  await withAccessLibrary(fixture, async ({ execute, ids, port }) => {
    const call = publicCall(port), prepared = await prepare(call, original, semantics);
    const alignments = [correspondence(prepared, "joining", original, semantics, "qFact0", true),
      correspondence(prepared, "promotion", original, semantics, "qFact1", true)];
    const recalled = await recall(call, original, semantics, alignments, prepared.query_handle);
    const proofSlots = recalled.slot_qualifiers.filter(row => row.evidence_kind === "semantic_proof");
    expect(proofSlots).toHaveLength(2);
    expect(new Set(proofSlots.map(row => row.source_interpretation_id))).toEqual(new Set([ids.get("joining")?.[0], ids.get("promotion")?.[0]]));
    expect(new Set(proofSlots.map(row => row.conditional_computation_id)).size).toBe(2);
    expect(new Set(recalled.index.entries.map(row => row.target.kind === "source_evidence" ? row.target.root_id : "")).size).toBe(2);
    expect(firstPageInputIds(recalled)).toEqual(new Set([0, 1]));
    expect(new Set(recalled.proofs?.map(proof => proof.source_record?.source_id))).toEqual(new Set(["joining", "promotion"]));
    expect(recalled.proofs?.every(proof => proof.binding_results?.every(binding => binding.bindings.person !== undefined))).toBe(true);
    expect(recalled.proofs?.every(proof => proof.binding_results?.every(binding =>
      binding.kind === "evidence" && binding.query_complete === false))).toBe(true);
    expect(recalled.results?.some(row => row.content_preview?.includes("Rana joined Larch Studio on June 1."))).toBe(true);
    expect(recalled.results?.some(row => row.content_preview?.includes("Rana was promoted at Larch Studio on June 13."))).toBe(true);
    const support = projectSourceSemanticQuerySupport(semantics, recalled.proofs?.flatMap(proof => proof.binding_results ?? []) ?? []);
    expect(support.evidence_inputs.map(row => row.status)).toEqual(["supported", "supported"]);
    expect(support.answer).not.toBe("supported");
    expect(support.compatibility).toBe("unknown");
  }, { prepareDatabase: indexed(fixture) });
}, 60_000);

it("delivers all six necessary source inputs exactly once across frozen continuation pages", async () => {
  const original = "Which facts fact0 fact1 fact2 fact3 fact4 fact5 are recorded for Rana?";
  const semantics = evidenceQuery(original, Array.from({ length: 6 }, (_, input) => `fact${input}`));
  const fixture = Array.from({ length: 6 }, (_, input) => ({ id: `source-${input}`,
    text: `Rana fact${input} was recorded.`, reading: `fact${input}`, person: "Rana" }));
  await withAccessLibrary(fixture, async ({ execute, port }) => {
    const call = publicCall(port), prepared = await prepare(call, original, semantics);
    const alignments = Array.from({ length: 6 }, (_, input) => correspondence(prepared, `source-${input}`,
      original, semantics, `qFact${input}`, true));
    const request = { operation: "recall", accepts_unreviewed_conditional_results: true,
      original_query: original, query_semantics: semantics, semantic_correspondences: alignments,
      query_handle: prepared.query_handle, budget: ACCESS_BUDGET, output_byte_limit: OUTPUT_BYTES, authorized_scopes: SCOPES };
    const pages = [await recall(call, original, semantics, alignments, prepared.query_handle)];
    while (pages.at(-1)!.index.continuation !== null && pages.length < 12) {
      const next = await call({ ...request, continuation: pages.at(-1)!.index.continuation });
      if (next.operation !== "recall" || next.index === undefined) throw new Error("public continuation expected");
      expect(next.request_identity).toBe(pages[0]!.request_identity);
      pages.push({ ...next, index: next.index, slot_qualifiers: next.slot_qualifiers! });
    }
    expect(pages.at(-1)!.index.continuation).toBeNull();
    // Occupancy is unique across pages and every necessary evidence input is delivered once.
    const roots = pages.flatMap(page => page.index.entries.flatMap(entry =>
      entry.target.kind === "source_evidence" ? [entry.target.root_id] : []));
    expect(roots).toHaveLength(6);
    expect(new Set(roots).size).toBe(6);
    const all = new Set(pages.flatMap(page => [...firstPageInputIds(page)]));
    expect(all).toEqual(new Set([0, 1, 2, 3, 4, 5]));
  }, { prepareDatabase: indexed(fixture) });
}, 60_000);
