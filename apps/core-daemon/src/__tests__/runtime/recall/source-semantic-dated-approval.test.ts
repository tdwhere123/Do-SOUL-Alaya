import { expect, it } from "vitest";
import {
  SoulInterpretationRequestSchema, SoulInterpretationResponseSchema,
  type SourceReferenceCatalog, type SourceSemanticInterpretation, type SourceSemanticQuery
} from "@do-soul/alaya-protocol";
import {
  SOURCE_SEMANTIC_CORRESPONDENCE_CORE_PRODUCER_ID, SOURCE_SEMANTIC_QUERY_SOUL_PRODUCER_ID
} from "@do-soul/alaya-core";
import { buildSourceSemanticQueryRequest, proposeQuerySemantics, proposeSourceSemantics } from "@do-soul/alaya-soul";
import { callAlayaMcpMemoryTool } from "../../../mcp/server/mcp-server.js";
import { createMcpMemoryToolHandler } from "../../../mcp-memory/tool/tool-handler.js";
import { createDeps } from "../../mcp-memory/tool/mcp-memory-tool-handler-fixture.js";
import { ACCESS_BUDGET, WS, withAccessLibrary } from "./source-semantic-access.test-support.js";
import { queryWire, receiveAuthoredCorrespondence } from "./source-semantic-producer-fixture.js";

const SOURCE = "Noor approved the Cedar pilot for 22 September 2026 only. I don't know whether anyone has approved the Cedar pilot for 24 September 2026.";
const DATED = "Who approved the Cedar pilot for 22 September 2026?";
const CURRENT = "Who has approved the Cedar pilot for today?";
const CONTEXT = { context_id: "avery-query-2026-09-24", notes: "Avery asks on 2026-09-24 UTC; today means 24 September 2026." };
const SCOPES = { mode: "named" as const, scopes: ["project"] };

function quote(text: string, occurrence?: number) {
  return { assertion_id: 1, text, ...(occurrence === undefined ? {} : { occurrence }) };
}

function approvalDraft(_catalog: SourceReferenceCatalog) {
  const received = proposeSourceSemantics({ sourceCorpus: SOURCE, assertionIds: [1, 2], sourceScope: "complete-source",
    source_id: "dated-approval-source", source_version: "1", producer_id: "authored-control", producer_version: "1" },
  { rawJson: JSON.stringify({ contract: "source-semantic-proposal-v7", outcome: { status: "interpreted" },
    content: { roots: [{ act: "assertion", expression: { kind: "statement",
      predicate: { kind: "explicit", reading: "approve", support: quote("approved", 0) },
      arguments: [
        { role: "approver", target: quote("Noor") },
        { role: "pilot", target: quote("Cedar pilot", 0) },
        { role: "approval_date", target: quote("22 September 2026 only") }
      ] } }], gaps: [{ kind: "unsupported_meaning",
      support: [{ assertion_id: 2, text: "I don't know whether" }, { assertion_id: 2, text: "24 September 2026" }],
      description: "The source reports unknown approval for 24 September 2026." }] } }) });
  if (received.draft === undefined || received.interpretation === undefined) {
    throw new Error(`authored approval packet failed: ${JSON.stringify(received.outcome)}`);
  }
  return received.draft;
}

function approvalQuery(question: string, dateExcerpt: string) {
  const input = { original_query: question, approved_fixed_context: CONTEXT,
    producer_id: SOURCE_SEMANTIC_QUERY_SOUL_PRODUCER_ID, producer_version: "1" };
  const request = buildSourceSemanticQueryRequest(input);
  expect(request.approved_fixed_context).toEqual(CONTEXT);
  const received = proposeQuerySemantics(input, { rawJson: queryWire(JSON.stringify({
    contract: "source-semantic-query-response-v8", outcome: { status: "interpreted", gaps: [] },
    query: { contract: "source-semantic-query-meaning-v5", gaps: [], alternatives: [{ conditions: [{
      kind: "statement", key: "approval", predicate: "approve", arguments: [
        { role: "approver", target: { kind: "free", key: "answerPerson", return: true }, excerpt: "Who" },
        { role: "pilot", target: { kind: "named", key: "pilot", excerpt: "Cedar pilot" }, excerpt: "Cedar pilot" },
        { role: "approval_date", target: { kind: "named", key: "approvalDate", excerpt: dateExcerpt }, excerpt: dateExcerpt }
      ] }] }] }
  })) });
  if (received.query === undefined) throw new Error(`authored approval query failed: ${JSON.stringify(received.outcome)}`);
  return received.query;
}

function approvalCorrespondence(question: string, semantics: SourceSemanticQuery,
  interpretation: SourceSemanticInterpretation, interpretationId: string, includeDate: boolean) {
  const sourceFrame = interpretation.frames.find(row => row.predicate_support.reading === "approve")!;
  if (sourceFrame.predicate_support.kind !== "explicit") throw new Error("authored approval predicate must be explicit");
  const queryFrame = semantics.alternatives[0]!.frames[0]!;
  const pairs: object[] = [{ relation: "contextual_equivalence",
    query_endpoint: { kind: "predicate", alternative: 0, frame: queryFrame.id },
    source_endpoint: { kind: "frame", frame: sourceFrame.id },
    query_support: { kind: "query_text", excerpt: "approved" },
    source_semantic_support: [{ kind: "lexical", mentions: sourceFrame.predicate_support.mentions }] }];
  for (const requirement of queryFrame.role_requirements) {
    if (requirement.role_reading === "approval_date" && !includeDate) continue;
    const sourceSlot = sourceFrame.slots.find(row => row.role_reading === requirement.role_reading)!;
    const target = sourceFrame.bindings.find(row => row.slot_id === sourceSlot.id)?.target;
    if (target?.kind !== "node") throw new Error("approval source role has no referent");
    const referent = interpretation.referents.find(row => row.id === target.id)!;
    const support = [{ kind: "lexical", mentions: [referent.mentions[0]!] }];
    pairs.push({ relation: "contextual_equivalence",
      query_endpoint: { kind: "slot", alternative: 0, frame: queryFrame.id, slot: requirement.id },
      source_endpoint: { kind: "slot", frame: sourceFrame.id, slot: sourceSlot.id },
      query_support: requirement.support, source_semantic_support: support });
    const variable = semantics.variables.find(row => row.id === requirement.target_variable);
    if (variable?.reference !== undefined) pairs.push({ relation: "contextual_equivalence",
      query_endpoint: { kind: "referent", variable: variable.id },
      source_endpoint: { kind: "referent", referent: referent.id },
      query_support: variable.reference, source_semantic_support: support });
  }
  const received = receiveAuthoredCorrespondence({ original_query: question,
    admitted_query_semantics: semantics, source_interpretation_descriptors: [
      { source_interpretation_id: interpretationId, interpretation }],
    producer_id: SOURCE_SEMANTIC_CORRESPONDENCE_CORE_PRODUCER_ID, producer_version: "1" },
  { correspondences: pairs });
  if (received.semantic_correspondence === undefined) throw new Error(`approval C failed: ${JSON.stringify(received.outcome)}`);
  return received.semantic_correspondence;
}

it("delivers a dated approval with its own support despite a separate current-date gap", async () => {
  await withAccessLibrary([{ id: "dated-approval-source", text: SOURCE, verbatim: true,
    eventTime: "2026-09-22T00:00:00.000Z", recordedAt: "2026-09-22T00:00:00.000Z", authoredDraft: approvalDraft }],
  async ({ execute, ids }) => {
    const context = { workspaceId: WS, runId: "dated-approval-control", agentTarget: "codex", sessionId: "dated-approval-control" };
    const handler = createMcpMemoryToolHandler({ ...createDeps(), now: () => "2026-09-24T00:00:00.000Z",
      sourceSemanticsPort: { execute } });
    const call = async (args: unknown) => {
      const response = await callAlayaMcpMemoryTool({ memoryToolHandler: handler, contextProvider: () => context },
        "soul.interpretation", SoulInterpretationRequestSchema.parse(args));
      const body = response.structuredContent as { ok?: boolean; output?: unknown };
      if (body.ok !== true) throw new Error(`public call failed: ${JSON.stringify(body)}`);
      return SoulInterpretationResponseSchema.parse(body.output);
    };
    const sourceId = ids.get("dated-approval-source")?.[0];
    if (sourceId === undefined) throw new Error("published approval fixture missing");
    const dated = approvalQuery(DATED, "22 September 2026");
    const prepared = await call({ operation: "prepare_query", original_query: DATED,
      query_semantics: dated, budget: ACCESS_BUDGET, authorized_scopes: SCOPES });
    if (prepared.operation !== "prepare_query") throw new Error("prepare_query expected");
    const interpretation = prepared.candidates.find(row => row.interpretation_id === sourceId)?.interpretation;
    if (interpretation === undefined) throw new Error("approval H missing from native catalog");
    expect(interpretation.gaps.some(row => row.support.some(s => s.kind === "lexical"
      && s.mentions.some(id => interpretation.mentions.find(m => m.id === id)?.text?.includes("don't know"))))).toBe(true);
    const datedC = approvalCorrespondence(DATED, dated, interpretation, sourceId, true);
    const past = await call({ operation: "recall", accepts_unreviewed_conditional_results: true,
      original_query: DATED, query_semantics: dated, semantic_correspondences: [datedC],
      budget: ACCESS_BUDGET, output_byte_limit: 1_000_000, authorized_scopes: SCOPES });
    if (past.operation !== "recall") throw new Error("dated recall expected");
    const proof = past.proofs?.find(row => row.source_interpretation_id === sourceId);
    const answer = proof?.binding_results?.find(row => row.kind === "answer");
    expect(answer?.returned.answerPerson?.node_id).toBeDefined();
    const person = interpretation.referents.find(row => row.id === answer?.returned.answerPerson?.node_id);
    expect(person?.mentions.map(id => interpretation.mentions.find(m => m.id === id)?.text)).toContain("Noor");
    expect(past.slot_qualifiers?.some(row => row.source_interpretation_id === sourceId
      && row.evidence_kind === "semantic_proof" && row.payload_support === "available"
      && row.selection_basis === "direct_answer")).toBe(true);
    expect(past.results?.some(row => row.content_preview?.includes("22 September 2026 only"))).toBe(true);

    const current = approvalQuery(CURRENT, "today");
    const currentC = approvalCorrespondence(CURRENT, current, interpretation, sourceId, false);
    const today = await call({ operation: "recall", accepts_unreviewed_conditional_results: true,
      original_query: CURRENT, query_semantics: current, semantic_correspondences: [currentC],
      budget: ACCESS_BUDGET, output_byte_limit: 1_000_000, authorized_scopes: SCOPES });
    if (today.operation !== "recall") throw new Error("current recall expected");
    expect(today.query_semantics_status?.status).toBe("admitted");
    expect((today.proofs ?? []).flatMap(row => row.binding_results ?? []).some(row => row.kind === "answer")).toBe(false);
    expect(today.slot_qualifiers?.every(row => row.evidence_kind === "source_evidence"
      && row.selection_basis === "source_access")).toBe(true);
    expect(today.results?.some(row => row.content_preview?.includes("24 September 2026"))).toBe(true);
  });
}, 60_000);
