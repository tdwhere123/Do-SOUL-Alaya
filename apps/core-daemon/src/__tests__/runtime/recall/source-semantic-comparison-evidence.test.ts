import { expect, it } from "vitest";
import {
  SoulInterpretationRequestSchema, SoulInterpretationResponseSchema,
  type SourceReferenceCatalog, type SourceSemanticFrame, type SourceSemanticInterpretation, type SourceSemanticQuery
} from "@do-soul/alaya-protocol";
import {
  SOURCE_SEMANTIC_CORRESPONDENCE_CORE_PRODUCER_ID, SOURCE_SEMANTIC_QUERY_SOUL_PRODUCER_ID
} from "@do-soul/alaya-core";
import { proposeQuerySemantics, proposeSourceSemantics } from "@do-soul/alaya-soul";
import { callAlayaMcpMemoryTool } from "../../../mcp/server/mcp-server.js";
import { createMcpMemoryToolHandler } from "../../../mcp-memory/tool/tool-handler.js";
import { createDeps } from "../../mcp-memory/tool/mcp-memory-tool-handler-fixture.js";
import { ACCESS_BUDGET, WS, withAccessLibrary } from "./source-semantic-access.test-support.js";
import { queryWire, receiveAuthoredCorrespondence } from "./source-semantic-producer-fixture.js";

const QUESTION = "Did the supervised run for batch Kestrel take longer than the supervised run for batch Lark?";
const MEASURED = "For batch Kestrel, setup took 8 minutes and the supervised run took 13 minutes. For batch Lark, setup took 11 minutes and the supervised run took 9 minutes.";
const STATED = "The supervised run for batch Kestrel took longer than the supervised run for batch Lark. Setup for batch Kestrel took less time than setup for batch Lark.";
const SCOPES = { mode: "named" as const, scopes: ["project"] };

function quote(assertion_id: number, text: string, occurrence?: number) {
  return { assertion_id, text, ...(occurrence === undefined ? {} : { occurrence }) };
}

function measuredDraft(_catalog: SourceReferenceCatalog) {
  const fact = (assertion_id: number, batch: string, activity: string, duration: string, ordinal: number) => ({
    act: "assertion", expression: { kind: "statement",
      predicate: { kind: "explicit", reading: "take-duration", support: quote(assertion_id, "took", ordinal) },
      arguments: [
        { role: "batch", target: quote(assertion_id, `batch ${batch}`) },
        { role: "activity", target: quote(assertion_id, activity) },
        { role: "duration", target: quote(assertion_id, duration) }
      ] }
  });
  const received = proposeSourceSemantics({ sourceCorpus: MEASURED, assertionIds: [1, 2], sourceScope: "complete-source",
    source_id: "measured-comparison-source", source_version: "1", producer_id: "authored-control", producer_version: "1" },
  { rawJson: JSON.stringify({ contract: "source-semantic-proposal-v7", outcome: { status: "interpreted" },
    content: { roots: [fact(1, "Kestrel", "setup", "8 minutes", 0),
      fact(1, "Kestrel", "the supervised run", "13 minutes", 1),
      fact(2, "Lark", "setup", "11 minutes", 0),
      fact(2, "Lark", "the supervised run", "9 minutes", 1)] } }) });
  if (received.draft === undefined || received.interpretation === undefined) {
    throw new Error(`measured H failed: ${JSON.stringify(received.outcome)}`);
  }
  return received.draft;
}

function statedDraft(_catalog: SourceReferenceCatalog) {
  const received = proposeSourceSemantics({ sourceCorpus: STATED, assertionIds: [1, 2], sourceScope: "complete-source",
    source_id: "stated-comparison-source", source_version: "1", producer_id: "authored-control", producer_version: "1" },
  { rawJson: JSON.stringify({ contract: "source-semantic-proposal-v7", outcome: { status: "interpreted" },
    content: { roots: [
      { act: "assertion", expression: { kind: "statement",
        predicate: { kind: "explicit", reading: "take-longer-than", support: quote(1, "took longer than") },
        arguments: [
          { role: "left_batch", target: quote(1, "batch Kestrel") },
          { role: "left_activity", target: quote(1, "The supervised run") },
          { role: "right_batch", target: quote(1, "batch Lark") },
          { role: "right_activity", target: quote(1, "the supervised run") }
        ] } },
      { act: "assertion", expression: { kind: "statement",
        predicate: { kind: "explicit", reading: "take-less-than", support: quote(2, "took less time than") },
        arguments: [
          { role: "left_batch", target: quote(2, "batch Kestrel") },
          { role: "left_activity", target: quote(2, "Setup") },
          { role: "right_batch", target: quote(2, "batch Lark") },
          { role: "right_activity", target: quote(2, "setup") }
        ] } }
    ] } }) });
  if (received.draft === undefined || received.interpretation === undefined) {
    throw new Error(`stated H failed: ${JSON.stringify(received.outcome)}`);
  }
  return received.draft;
}

function comparisonQuery() {
  const named = (key: string, excerpt: string) => ({ kind: "named", key, excerpt });
  const ref = (key: string) => ({ kind: "reference", key });
  const answer = { kind: "statement", key: "comparison", predicate: "take-longer-than", arguments: [
    { role: "left_batch", target: named("Kestrel", "batch Kestrel"), excerpt: "batch Kestrel" },
    { role: "left_activity", target: named("KestrelRun", "supervised run for batch Kestrel"), excerpt: "supervised run" },
    { role: "right_batch", target: named("Lark", "batch Lark"), excerpt: "batch Lark" },
    { role: "right_activity", target: named("LarkRun", "supervised run for batch Lark"), excerpt: "supervised run" }
  ] };
  const input = (key: string, batch: string, run: string, duration: string) => ({
    conditions: [{ kind: "statement", key, predicate: "take-duration", arguments: [
      { role: "batch", target: ref(batch), excerpt: `batch ${batch}` },
      { role: "activity", target: ref(run), excerpt: "supervised run" },
      { role: "duration", target: { kind: "free", key: duration }, excerpt: "take longer" }
    ] }]
  });
  const received = proposeQuerySemantics({ original_query: QUESTION,
    producer_id: SOURCE_SEMANTIC_QUERY_SOUL_PRODUCER_ID, producer_version: "1" },
  { rawJson: queryWire(JSON.stringify({ contract: "source-semantic-query-response-v8",
    outcome: { status: "interpreted", gaps: [] },
    query: { contract: "source-semantic-query-meaning-v5", gaps: [],
      requested_operation: { reading: "compare the supervised-run durations",
        support: { kind: "query_text", excerpt: QUESTION } },
      alternatives: [{ conditions: [answer], evidence_inputs: [
        input("KestrelDuration", "Kestrel", "KestrelRun", "durationKestrel"),
        input("LarkDuration", "Lark", "LarkRun", "durationLark")
      ] }] } })) });
  if (received.query === undefined) throw new Error(`comparison Q failed: ${JSON.stringify(received.outcome)}`);
  return received.query;
}

function targetMention(interpretation: SourceSemanticInterpretation, frame: SourceSemanticFrame, role: string) {
  const slot = frame.slots.find(row => row.role_reading === role)!;
  const target = frame.bindings.find(row => row.slot_id === slot.id)?.target;
  if (target?.kind !== "node") throw new Error(`source ${role} target missing`);
  const referent = interpretation.referents.find(row => row.id === target.id)!;
  return { slot, referent, mention: referent.mentions[0]! };
}

function activityOf(interpretation: SourceSemanticInterpretation, frame: SourceSemanticFrame) {
  const id = targetMention(interpretation, frame, "activity").mention;
  return interpretation.mentions.find(row => row.id === id)?.text;
}

function correspondence(semantics: SourceSemanticQuery, interpretation: SourceSemanticInterpretation,
  interpretationId: string, arm: "measured" | "stated") {
  const pairs: object[] = [];
  for (const queryFrame of semantics.alternatives[0]!.frames) {
    const sourceFrame = arm === "stated"
      ? queryFrame.id === "comparison" ? interpretation.frames.find(row => row.predicate_support.reading === "take-longer-than") : undefined
      : queryFrame.id === "KestrelDuration" ? interpretation.frames.find(row => row.predicate_support.reading === "take-duration"
        && row.assertion_ids.includes(1) && activityOf(interpretation, row) === "the supervised run")
        : queryFrame.id === "LarkDuration" ? interpretation.frames.find(row => row.predicate_support.reading === "take-duration"
          && row.assertion_ids.includes(2) && activityOf(interpretation, row) === "the supervised run") : undefined;
    if (sourceFrame === undefined) continue;
    if (sourceFrame.predicate_support.kind !== "explicit") throw new Error("authored comparison predicate must be explicit");
    pairs.push({ relation: "contextual_equivalence",
      query_endpoint: { kind: "predicate", alternative: 0, frame: queryFrame.id },
      source_endpoint: { kind: "frame", frame: sourceFrame.id },
      query_support: { kind: "query_text", excerpt: arm === "stated" ? "take longer than" : "take longer" },
      source_semantic_support: [{ kind: "lexical", mentions: sourceFrame.predicate_support.mentions }] });
    for (const requirement of queryFrame.role_requirements) {
      const { slot, referent, mention } = targetMention(interpretation, sourceFrame, requirement.role_reading);
      pairs.push({ relation: "contextual_equivalence",
        query_endpoint: { kind: "slot", alternative: 0, frame: queryFrame.id, slot: requirement.id },
        source_endpoint: { kind: "slot", frame: sourceFrame.id, slot: slot.id },
        query_support: requirement.support, source_semantic_support: [{ kind: "lexical", mentions: [mention] }] });
      const variable = semantics.variables.find(row => row.id === requirement.target_variable);
      if (variable?.reference !== undefined && !pairs.some(row => (row as { query_endpoint?: { variable?: string } }).query_endpoint?.variable === variable.id)) {
        pairs.push({ relation: "contextual_equivalence",
          query_endpoint: { kind: "referent", variable: variable.id },
          source_endpoint: { kind: "referent", referent: referent.id },
          query_support: variable.reference, source_semantic_support: [{ kind: "lexical", mentions: [mention] }] });
      }
    }
  }
  const received = receiveAuthoredCorrespondence({ original_query: QUESTION,
    admitted_query_semantics: semantics, source_interpretation_descriptors: [
      { source_interpretation_id: interpretationId, interpretation }],
    producer_id: SOURCE_SEMANTIC_CORRESPONDENCE_CORE_PRODUCER_ID, producer_version: "1" },
  { correspondences: pairs });
  if (received.semantic_correspondence === undefined) throw new Error(`comparison C failed: ${JSON.stringify(received.outcome)}`);
  return received.semantic_correspondence;
}

it("uses one Q for a stated answer and two qualified measured inputs without claiming arithmetic", async () => {
  const semantics = comparisonQuery();
  expect(semantics.evaluation).toBeUndefined();
  expect(JSON.stringify(semantics)).not.toContain("minutes");
  expect(semantics.alternatives[0]?.evidence_inputs).toHaveLength(2);
  await withAccessLibrary([
    { id: "measured-comparison-source", text: MEASURED, verbatim: true, authoredDraft: measuredDraft },
    { id: "stated-comparison-source", text: STATED, verbatim: true, authoredDraft: statedDraft }
  ], async ({ execute, ids }) => {
    const context = { workspaceId: WS, runId: "comparison-control", agentTarget: "codex", sessionId: "comparison-control" };
    const handler = createMcpMemoryToolHandler({ ...createDeps(), now: () => "2026-09-24T00:00:00.000Z",
      sourceSemanticsPort: { execute } });
    const call = async (args: unknown) => {
      const response = await callAlayaMcpMemoryTool({ memoryToolHandler: handler, contextProvider: () => context },
        "soul.interpretation", SoulInterpretationRequestSchema.parse(args));
      const body = response.structuredContent as { ok?: boolean; output?: unknown };
      if (body.ok !== true) throw new Error(`public call failed: ${JSON.stringify(body)}`);
      return SoulInterpretationResponseSchema.parse(body.output);
    };
    const prepared = await call({ operation: "prepare_query", original_query: QUESTION,
      query_semantics: semantics, budget: ACCESS_BUDGET, authorized_scopes: SCOPES });
    if (prepared.operation !== "prepare_query") throw new Error("prepare_query expected");
    const descriptors = ["measured-comparison-source", "stated-comparison-source"].map(source => {
      const interpretationId = ids.get(source)?.[0];
      const descriptor = prepared.candidates.find(row => row.interpretation_id === interpretationId);
      if (interpretationId === undefined || descriptor?.interpretation === undefined) throw new Error(`${source} absent from native catalog`);
      return { source, interpretationId, interpretation: descriptor.interpretation };
    });
    const aligned = descriptors.map(row => correspondence(semantics, row.interpretation, row.interpretationId,
      row.source === "measured-comparison-source" ? "measured" : "stated"));
    const recalled = await call({ operation: "recall", accepts_unreviewed_conditional_results: true,
      original_query: QUESTION, query_semantics: semantics, semantic_correspondences: aligned,
      budget: ACCESS_BUDGET, output_byte_limit: 1_000_000, authorized_scopes: SCOPES });
    if (recalled.operation !== "recall") throw new Error("comparison recall expected");
    expect(recalled.provider_attempts).toBe(0);
    const measured = recalled.proofs?.find(row => row.source_interpretation_id === ids.get("measured-comparison-source")?.[0]);
    const stated = recalled.proofs?.find(row => row.source_interpretation_id === ids.get("stated-comparison-source")?.[0]);
    expect(measured?.binding_results?.filter(row => row.kind === "evidence").map(row => row.input).sort()).toEqual([0, 1]);
    expect(measured?.binding_results?.every(row => row.query_complete === false)).toBe(true);
    const measuredInterpretation = descriptors[0]!.interpretation;
    for (const [input, variable, expected, forbidden] of [
      [0, "durationKestrel", "13 minutes", "8 minutes"],
      [1, "durationLark", "9 minutes", "11 minutes"]
    ] as const) {
      const binding = measured?.binding_results?.find(row => row.kind === "evidence" && row.input === input);
      const target = binding?.bindings[variable];
      const referent = measuredInterpretation.referents.find(row => row.id === target?.node_id);
      const texts = referent?.mentions.map(id => measuredInterpretation.mentions.find(row => row.id === id)?.text);
      expect(texts).toContain(expected);
      expect(texts).not.toContain(forbidden);
    }
    expect(stated?.binding_results?.some(row => row.kind === "answer" && row.query_complete === true)).toBe(true);
    expect(stated?.binding_results?.some(row => row.kind === "evidence")).toBe(false);
    expect(recalled.slot_qualifiers?.some(row => row.source_interpretation_id === ids.get("measured-comparison-source")?.[0]
      && row.support?.evidence_inputs?.every(input => input.status === "supported")
      && row.support.operation === "not_executed")).toBe(true);
    expect(recalled.results?.some(row => row.content_preview?.includes("13 minutes") && row.content_preview.includes("9 minutes"))).toBe(true);
  });
}, 60_000);
