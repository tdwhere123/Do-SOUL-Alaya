import { expect, it } from "vitest";
import {
  SoulInterpretationRequestSchema, SoulInterpretationResponseSchema,
  type SourceReferenceCatalog, type SourceSemanticInterpretation, type SourceSemanticQuery
} from "@do-soul/alaya-protocol";
import {
  SOURCE_SEMANTIC_CORRESPONDENCE_CORE_PRODUCER_ID, SOURCE_SEMANTIC_QUERY_SOUL_PRODUCER_ID
} from "@do-soul/alaya-core";
import { buildSourceSemanticQueryRequest, indexSourceSemanticUnits, proposeQuerySemantics, proposeSourceSemantics } from "@do-soul/alaya-soul";
import { callAlayaMcpMemoryTool } from "../../../mcp/server/mcp-server.js";
import { createMcpMemoryToolHandler } from "../../../mcp-memory/tool/tool-handler.js";
import { createDeps } from "../../mcp-memory/tool/mcp-memory-tool-handler-fixture.js";
import { exposureSlots, firstExposureMismatch } from "../../../../../../apps/bench-runner/src/runs/measurement/first-exposure-session.js";
import { recordSourceSemanticLibraryFirstExposure, soulSearchFromLibraryRecall }
  from "../../../../../../apps/bench-runner/src/runs/measurement/source-semantic-library-recall.js";
import { WS, withAccessLibrary } from "./source-semantic-access.test-support.js";
import { queryWire, receiveAuthoredCorrespondence } from "./source-semantic-producer-fixture.js";

const CLOCK = "2026-09-25T00:00:00.000Z";
const OBSERVED = "2026-09-20T12:00:00.000Z";
const INGESTED = ["2026-09-21T09:00:00.000Z", "2026-09-21T09:00:01.000Z"] as const;
const BUDGET = { schema_version: 1 as const, work_units: 10_000_000, memory_bytes: 200_000_000,
  page_budget: 100_000, finalization_reserve: 10_000, min_envelope: 10 };
// The public protocol encodes the frozen local `authorized_scopes: null` as unrestricted admission.
const SCOPES = { mode: "unrestricted" as const };
const DATE_QUESTION = "Which tool did Mira use for indexing on August 14, 2026?";
const DATE_CONTEXT = { context_id: "original-tool-date", notes:
  "Use the retained activity records. A date refers to the UTC calendar day of the tool-use event. Report the tool supported for that day; say if the records do not settle the requested detail." };
const FORMAT_QUESTION = "Which file format did Mira use for the Atlas export?";
const FORMAT_CONTEXT = { context_id: "original-export-format", notes:
  "Use the retained export notes. Atlas and Beacon name different exports. If the Atlas format is not supported by the available notes, keep it unknown." };

function sourceDraft(source: string, sourceId: string, catalog: SourceReferenceCatalog) {
  const isDate = source.includes("indexing");
  const used = source.includes(" used ");
  const units = indexSourceSemanticUnits(source);
  const assertion = used && !isDate ? units.find(row => row.text.includes(" used ")) : units[0];
  if (assertion === undefined) throw new Error("source lacks selected complete sentence");
  const quote = (text: string) => {
    if (!assertion.text.includes(text)) throw new Error(`selected source assertion lacks ${text}`);
    return { assertion_id: assertion.assertion_id, text };
  };
  const values = isDate
    ? { actor: "Mira", tool: source.includes("Cedar") ? "Cedar" : "Birch", purpose: "indexing",
      event_date: source.includes("2026-08-14") ? "2026-08-14" : "2026-09-14" }
    : { actor: "Mira", format: source.includes("Parquet") ? "Parquet" : "CSV",
      export: source.includes("Atlas") ? "Atlas" : "Beacon" };
  const entities = used ? Object.entries(values).map(([key, value]) => ({ form: "selection", key,
    selection: quote(value) })) : [{ form: "selection", key: "export", selection: quote("Atlas") }];
  const arguments_ = used ? Object.keys(values).map(role => ({ role, target: { kind: "entity_ref", key: role } }))
    : [{ role: "export", target: { kind: "entity_ref", key: "export" } }];
  const predicate = used ? "used" : "completed";
  const raw = { contract: "source-semantic-proposal-v8", outcome: { status: "interpreted" },
    content: { roots: [{ act: "assertion", expression: { kind: "content_ref", key: "event" } }],
      entities, nodes: [{ kind: "statement", key: "event", predicate: { kind: "explicit",
        reading: used ? "use" : "complete", support: quote(predicate) },
        arguments: arguments_, qualifications: [] }], gaps: [] } };
  const received = proposeSourceSemantics({ sourceCorpus: source, assertionIds: catalog.assertions.map(row => row.assertion_id),
    sourceScope: "complete-source", source_id: sourceId, source_version: "1",
    producer_id: "authored-original-control", producer_version: "1" }, { rawJson: JSON.stringify(raw) });
  if (received.draft === undefined) throw new Error(`authored H rejected: ${JSON.stringify(received.outcome)}`);
  return received.draft;
}

function query(question: string, context: typeof DATE_CONTEXT, date: boolean) {
  const input = { original_query: question, approved_fixed_context: context,
    producer_id: SOURCE_SEMANTIC_QUERY_SOUL_PRODUCER_ID, producer_version: "1" };
  const request = buildSourceSemanticQueryRequest(input);
  expect(request.approved_fixed_context).toEqual(context);
  const roles = date ? [
    { role: "actor", target: { kind: "named", key: "actor", excerpt: "Mira" }, excerpt: "Mira" },
    { role: "tool", target: { kind: "free", key: "answer", return: true }, excerpt: "Which tool" },
    { role: "purpose", target: { kind: "named", key: "purpose", excerpt: "indexing" }, excerpt: "indexing" },
    { role: "event_date", target: { kind: "named", key: "eventDate", excerpt: "August 14, 2026" }, excerpt: "August 14, 2026" }
  ] : [
    { role: "actor", target: { kind: "named", key: "actor", excerpt: "Mira" }, excerpt: "Mira" },
    { role: "format", target: { kind: "free", key: "answer", return: true }, excerpt: "Which file format" },
    { role: "export", target: { kind: "named", key: "export", excerpt: "Atlas export" }, excerpt: "Atlas export" }
  ];
  const received = proposeQuerySemantics(input, { rawJson: queryWire(JSON.stringify({
    contract: "source-semantic-query-response-v8", outcome: { status: "interpreted", gaps: [] },
    query: { contract: "source-semantic-query-meaning-v5", gaps: [], alternatives: [{ conditions: [{
      kind: "statement", key: "use", predicate: "use", arguments: roles
    }] }] }
  })) });
  if (received.query === undefined) throw new Error(`authored Q rejected: ${JSON.stringify(received.outcome)}`);
  return received.query;
}

function correspondence(question: string, semantics: SourceSemanticQuery,
  interpretation: SourceSemanticInterpretation, interpretationId: string) {
  const frame = interpretation.frames[0]!;
  const queryFrame = semantics.alternatives[0]!.frames[0]!;
  const pairs: object[] = [];
  if (frame.predicate_support.kind === "explicit" && frame.predicate_support.reading === "use") pairs.push({
    relation: "contextual_equivalence", query_endpoint: { kind: "predicate", alternative: 0, frame: queryFrame.id },
    source_endpoint: { kind: "frame", frame: frame.id }, query_support: { kind: "query_text", excerpt: "use" },
    source_semantic_support: [{ kind: "lexical", mentions: frame.predicate_support.mentions }]
  });
  for (const requirement of queryFrame.role_requirements) {
    const slot = frame.slots.find(row => row.role_reading === requirement.role_reading);
    if (slot === undefined) continue;
    const target = frame.bindings.find(row => row.slot_id === slot.id)?.target;
    if (target?.kind !== "node") throw new Error(`source ${requirement.role_reading} has no referent`);
    const referent = interpretation.referents.find(row => row.id === target.id)!;
    const support = [{ kind: "lexical", mentions: [referent.mentions[0]!] }];
    pairs.push({ relation: "contextual_equivalence",
      query_endpoint: { kind: "slot", alternative: 0, frame: queryFrame.id, slot: requirement.id },
      source_endpoint: { kind: "slot", frame: frame.id, slot: slot.id },
      query_support: requirement.support, source_semantic_support: support });
    const variable = semantics.variables.find(row => row.id === requirement.target_variable);
    const sourceText = referent.mentions.map(id => interpretation.mentions.find(row => row.id === id)?.text ?? "").join(" ");
    const reference = variable?.reference?.excerpt ?? "";
    const sameReferent = requirement.role_reading === "event_date"
      ? new Date(`${sourceText}T00:00:00.000Z`).getTime() === new Date(`${reference} UTC`).getTime()
      : reference.includes(sourceText);
    if (variable?.reference !== undefined && sameReferent) pairs.push({ relation: "contextual_equivalence",
      query_endpoint: { kind: "referent", variable: variable.id },
      source_endpoint: { kind: "referent", referent: referent.id },
      query_support: variable.reference, source_semantic_support: support });
  }
  const received = receiveAuthoredCorrespondence({ original_query: question,
    admitted_query_semantics: semantics, source_interpretation_descriptors: [
      { source_interpretation_id: interpretationId, interpretation }],
    producer_id: SOURCE_SEMANTIC_CORRESPONDENCE_CORE_PRODUCER_ID, producer_version: "1" },
  { correspondences: pairs });
  if (received.semantic_correspondence === undefined) throw new Error(`authored C rejected: ${JSON.stringify(received.outcome)}`);
  return received.semantic_correspondence;
}

const WORLDS = [
  { name: "date positive", date: true, titles: ["Activity note 1", "Activity note 2"], bodies: ["Mira used Cedar for indexing on 2026-08-14.\n", "Mira used Birch for indexing on 2026-09-14.\n"],
    answer: "Cedar", support: "Mira used Cedar for indexing on 2026-08-14." },
  { name: "date foil", date: true, titles: ["Activity note 1", "Activity note 2"], bodies: ["Mira used Cedar for indexing on 2026-09-14.\n", "Mira used Birch for indexing on 2026-08-14.\n"],
    answer: "Birch", support: "Mira used Birch for indexing on 2026-08-14." },
  { name: "format positive", date: false, titles: ["Export note 1", "Export note 2"], bodies: ["Mira completed the Atlas export.\nMira used Parquet for the Atlas export.\n", "Mira used CSV for the Beacon export.\n"],
    answer: "Parquet", support: "Mira used Parquet for the Atlas export." },
  { name: "format foil", date: false, titles: ["Export note 1", "Export note 2"], bodies: ["Mira completed the Atlas export.\nMira archived the Atlas export.\n", "Mira used CSV for the Beacon export.\n"],
    answer: null, support: null }
] as const;

for (const world of WORLDS) it(`admits the frozen ${world.name} meaning through native first exposure`, async () => {
  const question = world.date ? DATE_QUESTION : FORMAT_QUESTION;
  const context = world.date ? DATE_CONTEXT : FORMAT_CONTEXT;
  const fixture = world.bodies.map((body, index) => ({ evaluatorLabel: index === 0 ? "record-a" : "record-b",
    title: world.titles[index]!, sourceId: `source-${index === 0 ? "7df0" : "b326"}`, body,
    ingestedAt: INGESTED[index]! }));
  expect(fixture.map(row => row.title)).toEqual(world.date ? ["Activity note 1", "Activity note 2"] : ["Export note 1", "Export note 2"]);
  await withAccessLibrary(fixture.map(row => ({ id: row.sourceId,
    text: row.body, verbatim: true, recordedAt: row.ingestedAt, eventTime: OBSERVED,
    authoredDraft: (catalog: SourceReferenceCatalog) => sourceDraft(row.body, row.sourceId, catalog) })),
  async ({ execute }) => {
    const handler = createMcpMemoryToolHandler({ ...createDeps(), now: () => CLOCK,
      sourceSemanticsPort: { execute } });
    const contextProvider = () => ({ workspaceId: WS, runId: `original-${world.name}`, agentTarget: "codex", sessionId: `original-${world.name}` });
    const call = async (args: unknown) => {
      const response = await callAlayaMcpMemoryTool({ memoryToolHandler: handler, contextProvider },
        "soul.interpretation", SoulInterpretationRequestSchema.parse(args));
      const body = response.structuredContent as { ok?: boolean; output?: unknown };
      if (body.ok !== true) throw new Error(`public call failed: ${JSON.stringify(body)}`);
      return SoulInterpretationResponseSchema.parse(body.output);
    };
    const semantics = query(question, context, world.date);
    const prepared = await call({ operation: "prepare_query", original_query: question,
      query_semantics: semantics, budget: BUDGET, authorized_scopes: SCOPES });
    if (prepared.operation !== "prepare_query") throw new Error("prepare_query required");
    const correspondences = prepared.candidates.map(row => {
      if (row.interpretation === undefined) throw new Error("authored H missing from native descriptor");
      return correspondence(question, semantics, row.interpretation, row.interpretation_id);
    });
    const recalled = await call({ operation: "recall", accepts_unreviewed_conditional_results: true,
      original_query: question, query_semantics: semantics, semantic_correspondences: correspondences,
      budget: BUDGET, output_byte_limit: 1_000_000, authorized_scopes: SCOPES });
    if (recalled.operation !== "recall") throw new Error("recall required");
    const answers = (recalled.proofs ?? []).flatMap(proof => (proof.binding_results ?? [])
      .filter(row => row.kind === "answer").map(row => ({ proof, row })));
    if (world.answer === null) {
      expect(answers).toHaveLength(0);
      expect(recalled.slot_qualifiers?.every(row => row.evidence_kind === "source_evidence")).toBe(true);
    } else {
      const matched = answers.some(({ proof, row }) => {
        const node = row.returned.answer?.node_id;
        const interpretation = prepared.candidates.find(candidate => candidate.interpretation_id === proof.source_interpretation_id)?.interpretation;
        return interpretation?.referents.some(ref => ref.id === node && ref.mentions.some(id =>
          interpretation.mentions.find(mention => mention.id === id)?.text === world.answer));
      });
      expect(matched).toBe(true);
      expect(answers).toHaveLength(1);
      expect(recalled.slot_qualifiers?.some(row => row.evidence_kind === "semantic_proof"
        && row.selection_basis === "direct_answer" && row.payload_support === "available")).toBe(true);
      expect(recalled.results?.slice(0, 5).some(row => row.content_preview?.includes(world.support!))).toBe(true);
    }
    const search = soulSearchFromLibraryRecall(recalled);
    const page = recordSourceSemanticLibraryFirstExposure(recalled);
    expect(firstExposureMismatch(page, { query_id: search.index!.query_id,
      snapshot_id: search.index!.snapshot_id, interpretation_id: search.index!.interpretation_id!,
      as_of: search.index!.as_of! }, exposureSlots(search), search.delivery_id)).toBe(false);
  });
}, 60_000);
