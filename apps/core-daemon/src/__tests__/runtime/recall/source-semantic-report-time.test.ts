import { expect, it } from "vitest";
import {
  SoulInterpretationRequestSchema, SoulInterpretationResponseSchema,
  type SourceReferenceCatalog, type SourceSemanticInterpretation, type SourceSemanticQuery
} from "@do-soul/alaya-protocol";
import {
  SOURCE_SEMANTIC_CORRESPONDENCE_CORE_PRODUCER_ID, SOURCE_SEMANTIC_QUERY_SOUL_PRODUCER_ID
} from "@do-soul/alaya-core";
import { buildSourceSemanticCorrespondenceRequest, proposeQuerySemantics, proposeSourceSemantics } from "@do-soul/alaya-soul";
import { callAlayaMcpMemoryTool } from "../../../mcp/server/mcp-server.js";
import { createMcpMemoryToolHandler } from "../../../mcp-memory/tool/tool-handler.js";
import { createDeps } from "../../mcp-memory/tool/mcp-memory-tool-handler-fixture.js";
import { ACCESS_BUDGET, WS, withAccessLibrary } from "./source-semantic-access.test-support.js";
import { queryWire, receiveAuthoredCorrespondence } from "./source-semantic-producer-fixture.js";

const SOURCE = 'On 8 June 2026, Mira told me, "Oren inspected the valve on 6 June 2026."';
const INSPECTION = "According to Mira, when did Oren inspect the valve?";
const TELLING = "When did Mira tell me about Oren's valve inspection?";
const SCOPES = { mode: "named" as const, scopes: ["project"] };

function quote(text: string) { return { assertion_id: 1, text }; }

function reportDraft(_catalog: SourceReferenceCatalog) {
  const received = proposeSourceSemantics({ sourceCorpus: SOURCE, assertionIds: [1],
    source_id: "report-time-source", source_version: "1", producer_id: "authored-control", producer_version: "1" },
  { rawJson: JSON.stringify({ contract: "source-semantic-proposal-v7", outcome: { status: "interpreted" },
    content: { roots: [{ act: "assertion", expression: { kind: "statement",
      predicate: { kind: "explicit", reading: "tell", support: quote("told") },
      arguments: [
        { role: "speaker", target: quote("Mira") },
        { role: "recipient", target: quote("me") },
        { role: "date", target: quote("8 June 2026") },
        { role: "content", support: quote("Oren inspected"), target: { kind: "statement",
          predicate: { kind: "explicit", reading: "inspect", support: quote("inspected") },
          arguments: [
            { role: "agent", target: quote("Oren") },
            { role: "theme", target: quote("valve") },
            { role: "date", target: quote("6 June 2026") }
          ] } }
      ] } }] } }) });
  if (received.draft === undefined || received.interpretation === undefined) {
    throw new Error(`authored source packet failed: ${JSON.stringify(received.outcome)}`);
  }
  return received.draft;
}

function query(question: string, answerEvent: "inspect" | "tell") {
  const named = (key: string, excerpt: string) => ({ kind: "named", key, excerpt });
  const date = { role: "date", target: { kind: "free", key: "answerDate", return: true },
    excerpt: answerEvent === "tell" ? "When" : "when" };
  const inner = { kind: "statement", key: "inspection", predicate: "inspect", arguments: [
    { role: "agent", target: named("Oren", "Oren"), excerpt: "Oren" },
    { role: "theme", target: named("valve", "valve"), excerpt: "valve" },
    ...(answerEvent === "inspect" ? [date] : [])
  ] };
  const outer = { kind: "statement", key: "telling", predicate: "tell", arguments: [
    { role: "speaker", target: named("Mira", "Mira"), excerpt: "Mira" },
    ...(answerEvent === "tell" ? [
      { role: "recipient", target: named("me", "me"), excerpt: "me" }, date
    ] : [])
  ], content: inner };
  const received = proposeQuerySemantics({ original_query: question,
    producer_id: SOURCE_SEMANTIC_QUERY_SOUL_PRODUCER_ID, producer_version: "1" },
  { rawJson: queryWire(JSON.stringify({ contract: "source-semantic-query-response-v8",
    outcome: { status: "interpreted", gaps: [] },
    query: { contract: "source-semantic-query-meaning-v5", alternatives: [{ conditions: [outer] }], gaps: [] } })) });
  if (received.query === undefined) throw new Error(`authored query packet failed: ${JSON.stringify(received.outcome)}`);
  return received.query;
}

function mention(interpretation: SourceSemanticInterpretation, text: string) {
  const found = interpretation.mentions.find(row => row.text === text);
  if (found === undefined) throw new Error(`source mention missing: ${text}`);
  return found.id;
}

function correspondence(question: string, semantics: SourceSemanticQuery,
  interpretation: SourceSemanticInterpretation, interpretationId: string) {
  const pairs: object[] = [];
  const sourceFrames = new Map(interpretation.frames.map(row => [row.predicate_support.reading, row]));
  for (const queryFrame of semantics.alternatives[0]!.frames) {
    const sourceFrame = sourceFrames.get(queryFrame.predicate_reading);
    if (sourceFrame === undefined) throw new Error(`source frame missing: ${queryFrame.predicate_reading}`);
    const predicateText = queryFrame.predicate_reading === "tell" ? "told" : "inspected";
    pairs.push({ relation: "contextual_equivalence",
      query_endpoint: { kind: "predicate", alternative: 0, frame: queryFrame.id },
      source_endpoint: { kind: "frame", frame: sourceFrame.id },
      query_support: { kind: "query_text", excerpt: queryFrame.predicate_reading === "tell"
        ? question.includes("tell") ? "tell" : "According to" : question.includes("inspect") ? "inspect" : "inspection" },
      source_semantic_support: [{ kind: "lexical", mentions: [mention(interpretation, predicateText)] }] });
    for (const requirement of queryFrame.role_requirements) {
      const slot = sourceFrame.slots.find(row => row.role_reading === requirement.role_reading);
      if (slot === undefined) throw new Error(`source slot missing: ${requirement.role_reading}`);
      const target = sourceFrame.bindings.find(row => row.slot_id === slot.id)?.target;
      if (target?.kind !== "node") throw new Error(`source target missing: ${requirement.role_reading}`);
      const referent = interpretation.referents.find(row => row.id === target.id);
      if (referent === undefined || referent.mentions[0] === undefined) {
        throw new Error(`source referent missing: ${requirement.role_reading}`);
      }
      const supportMention = referent.mentions[0];
      pairs.push({ relation: "contextual_equivalence",
        query_endpoint: { kind: "slot", alternative: 0, frame: queryFrame.id, slot: requirement.id },
        source_endpoint: { kind: "slot", frame: sourceFrame.id, slot: slot.id },
        query_support: requirement.support, source_semantic_support: [{ kind: "lexical", mentions: [supportMention] }] });
      const variable = semantics.variables.find(row => row.id === requirement.target_variable);
      if (variable?.reference !== undefined) pairs.push({ relation: "contextual_equivalence",
        query_endpoint: { kind: "referent", variable: variable.id },
        source_endpoint: { kind: "referent", referent: referent.id },
        query_support: variable.reference, source_semantic_support: [{ kind: "lexical", mentions: [supportMention] }] });
    }
  }
  const received = receiveAuthoredCorrespondence({ original_query: question,
    admitted_query_semantics: semantics, source_interpretation_descriptors: [
      { source_interpretation_id: interpretationId, interpretation }],
    producer_id: SOURCE_SEMANTIC_CORRESPONDENCE_CORE_PRODUCER_ID, producer_version: "1" },
  { correspondences: pairs });
  if (received.semantic_correspondence === undefined) {
    throw new Error(`authored correspondence failed: ${JSON.stringify(received.outcome)}`);
  }
  return received.semantic_correspondence;
}

it("keeps the reported inspection and telling dates attached through public worker delivery", async () => {
  await withAccessLibrary([{ id: "report-time-source", text: SOURCE, verbatim: true,
    eventTime: "2026-06-09T00:00:00.000Z", authoredDraft: reportDraft }],
    async ({ execute, ids }) => {
      const context = { workspaceId: WS, runId: "report-time-control", agentTarget: "codex", sessionId: "report-time-control" };
      const handler = createMcpMemoryToolHandler({ ...createDeps(), now: () => "2026-09-24T00:00:00.000Z",
        sourceSemanticsPort: { execute } });
      const call = async (args: unknown) => {
        const response = await callAlayaMcpMemoryTool({ memoryToolHandler: handler, contextProvider: () => context },
          "soul.interpretation", SoulInterpretationRequestSchema.parse(args));
        const body = response.structuredContent as { ok?: boolean; output?: unknown };
        if (body.ok !== true) throw new Error(`public call failed: ${JSON.stringify(body)}`);
        return SoulInterpretationResponseSchema.parse(body.output);
      };
      const sourceId = ids.get("report-time-source")?.[0];
      if (sourceId === undefined) throw new Error("published report fixture missing");
      for (const [question, event, expectedDate, forbiddenDate] of [
        [INSPECTION, "inspect", "6 June 2026", "8 June 2026"],
        [TELLING, "tell", "8 June 2026", "6 June 2026"]
      ] as const) {
        const semantics = query(question, event);
        const prepared = await call({ operation: "prepare_query", original_query: question,
          query_semantics: semantics, budget: ACCESS_BUDGET, authorized_scopes: SCOPES });
        if (prepared.operation !== "prepare_query") throw new Error("prepare_query expected");
        const descriptor = prepared.candidates.find(row => row.interpretation_id === sourceId);
        if (descriptor?.interpretation === undefined) throw new Error("report interpretation absent from native catalog");
        const telling = descriptor.interpretation.frames.find(row => row.predicate_support.reading === "tell")!;
        const inspection = descriptor.interpretation.frames.find(row => row.predicate_support.reading === "inspect")!;
        expect(inspection.context_owner).toMatchObject({ kind: "embedding", parent_frame: telling.id });
        const catalog = buildSourceSemanticCorrespondenceRequest({ original_query: question,
          admitted_query_semantics: semantics, source_interpretation_descriptors: [
            { source_interpretation_id: sourceId, interpretation: descriptor.interpretation }],
          producer_id: SOURCE_SEMANTIC_CORRESPONDENCE_CORE_PRODUCER_ID, producer_version: "1" }).catalog;
        const queried = semantics.alternatives[0]!.frames.find(row => row.predicate_reading === event)!;
        const focal = catalog.query_endpoints.find(row => row.kind === "predicate" && row.frame === queried.id);
        const positiveEndpoint = catalog.source_endpoints.find(row => row.kind === "frame" && row.frame === (event === "tell" ? telling.id : inspection.id));
        const forbiddenEndpoint = catalog.source_endpoints.find(row => row.kind === "frame" && row.frame === (event === "tell" ? inspection.id : telling.id));
        expect(focal?.handle).toMatch(/^qe[1-9]/u);
        expect(positiveEndpoint?.handle).toMatch(/^se[1-9]/u);
        expect(forbiddenEndpoint?.handle).not.toBe(positiveEndpoint?.handle);
        const aligned = correspondence(question, semantics, descriptor.interpretation, sourceId);
        const recalled = await call({ operation: "recall", accepts_unreviewed_conditional_results: true,
          original_query: question, query_semantics: semantics, semantic_correspondences: [aligned],
          budget: ACCESS_BUDGET, output_byte_limit: 1_000_000, authorized_scopes: SCOPES });
        if (recalled.operation !== "recall") throw new Error("public recall expected");
        expect(recalled.provider_attempts).toBe(0);
        const proof = recalled.proofs?.find(row => row.source_interpretation_id === sourceId);
        const answer = proof?.binding_results?.find(row => row.kind === "answer");
        expect(answer?.returned.answerDate?.node_id).toBeDefined();
        const bound = descriptor.interpretation.referents.find(row => row.id === answer?.returned.answerDate?.node_id);
        const boundTexts = bound?.mentions.map(id => descriptor.interpretation!.mentions.find(row => row.id === id)?.text);
        expect(boundTexts).toContain(expectedDate);
        expect(boundTexts).not.toContain(forbiddenDate);
        expect(recalled.slot_qualifiers?.some(row => row.source_interpretation_id === sourceId && row.evidence_kind === "semantic_proof")).toBe(true);
        expect(recalled.results?.some(row => row.content_preview?.includes("Mira told me")
          && row.content_preview.includes("Oren inspected") && row.content_preview.includes(expectedDate))).toBe(true);
      }
    });
}, 60_000);
