import { expect, it } from "vitest";
import { SOURCE_SEMANTIC_INLINE_GENERATION_CONTRACT, SOURCE_SEMANTIC_INLINE_PROPOSAL_CONTRACT,
  SOURCE_SEMANTIC_TABLE_PROPOSAL_CONTRACT, sourceSemanticInterpretationIdentity } from "@do-soul/alaya-protocol";
import { buildSourceSemanticRequest, semanticSha256, sourceSemanticSystemPrompt, type SourceSemanticProposalInput } from "../../../garden/ingestion/official-api/source-semantic-request.js";
import { receiveSourceSemantics } from "../../../garden/ingestion/official-api/source-semantic-receive.js";
import { prepareSourceSemanticRevision } from "../../../garden/ingestion/official-api/source-semantic-revision.js";

const task = { contract: "source-semantic-generation-task-v1" as const, context: "complete_original_source" as const,
  original_query: "Did Mira arrive with a cat?", responsibility: {
    kind: "original_query_task" as const, other_meaning: "unassessed" as const } };
const input = { sourceCorpus: "Mira arrived. Mira departed.", assertionIds: [1, 2], sourceScope: "complete-source" as const,
  source_id: "source", source_version: "1", producer_id: "producer", producer_version: "1",
  generationSchemaContract: SOURCE_SEMANTIC_INLINE_GENERATION_CONTRACT, generationTask: task };
const selection = (text: string) => ({ assertion_id: 1, text });
const raw = { contract: SOURCE_SEMANTIC_INLINE_PROPOSAL_CONTRACT, outcome: { status: "interpreted" }, content: {
  nodes: [{ kind: "statement", key: "arrival", predicate: { kind: "explicit", reading: "arrived", support: selection("arrived") },
    arguments: [{ role: "subject", target: { kind: "entity", mentions: [selection("Mira")] } }], qualifications: [] }],
  roots: [{ act: "assertion", expression: { kind: "content_ref", key: "arrival" } }], gaps: [] } };
const receive = (value: unknown, selected: SourceSemanticProposalInput = input) => receiveSourceSemantics(JSON.stringify(value), buildSourceSemanticRequest(selected), selected);

it.each([undefined, SOURCE_SEMANTIC_INLINE_GENERATION_CONTRACT])("scopes exhaustive guidance to the declared task for %s", generationSchemaContract => {
  const scoped = buildSourceSemanticRequest({ ...input, generationSchemaContract });
  const full = buildSourceSemanticRequest({ ...input, generationSchemaContract,
    generationTask: { ...task, responsibility: { kind: "all_supplied_meaning" } } });
  const prompt = sourceSemanticSystemPrompt(scoped);
  expect(prompt).toBe(sourceSemanticSystemPrompt(full));
  expect(prompt).toContain("Represent each expressed relation required by the declared task");
  expect(prompt).toContain("Declare each independent proposition required by the declared task");
  expect(prompt).toContain("every source-supported dependency of each published claim");
  expect(prompt).not.toContain("Interpret every supplied source unit locally");
  expect(prompt).not.toContain("Declare each independent proposition as a root");
  expect(prompt).not.toContain("preserve all supported propositions and qualifications.");
  const historical = sourceSemanticSystemPrompt(buildSourceSemanticRequest({ ...input, generationSchemaContract, generationTask: undefined }));
  expect(historical).toContain("Declare each independent proposition as a root");
  expect(historical).toContain("Interpret every supplied source unit locally");
});

it.each([undefined, SOURCE_SEMANTIC_INLINE_GENERATION_CONTRACT])("binds host task after strict %s decoding and retains structural gaps", generationSchemaContract => {
  const selected = { ...input, generationSchemaContract };
  const value = generationSchemaContract === undefined ? { ...raw, contract: SOURCE_SEMANTIC_TABLE_PROPOSAL_CONTRACT,
    content: { ...raw.content, entities: [{ form: "entity", key: "mira", mentions: [selection("Mira")] }],
      nodes: [{ ...raw.content.nodes[0], arguments: [{ role: "subject", target: { kind: "entity_ref", key: "mira" } }] }] } } : raw;
  const received = receive(value, selected);
  expect(received.outcome.status, JSON.stringify(received.outcome)).toBe("interpreted");
  expect(received.rawJson).toBe(JSON.stringify(value));
  expect(received.draft?.generation_task).toEqual(task);
  expect(Object.isFrozen(received.draft)).toBe(true);
  expect(received.interpretation?.generation_task).toEqual(task);
  expect(received.interpretation?.gaps).toContainEqual(expect.objectContaining({ kind: "uninterpreted_clause" }));
  expect(receive({ ...value, generation_task: task }, selected).outcome.status).toBe("invalid");
  expect(receive({ ...value, content: { ...value.content, generation_task: task } }, selected).outcome.status).toBe("invalid");
  const invented = { ...value, content: { ...value.content, nodes: [{ ...value.content.nodes[0],
    predicate: { kind: "explicit", reading: "cat", support: selection("cat") } }] } };
  expect(receive(invented, selected).outcome.status).toBe("invalid");
  const abstained = receive({ contract: value.contract, outcome: { status: "abstained" } }, selected);
  expect(abstained.outcome.status).toBe("abstained");
  expect(abstained.interpretation).toBeUndefined();
  expect(abstained.draft).toBeUndefined();
  expect(abstained.request.source_request.generation_task).toEqual(task);
});

it("binds exact cue bytes into H and revision ancestry without changing source evidence", () => {
  const first = receive(raw), changedInput = { ...input, generationTask: { ...task, original_query: task.original_query + " " } };
  const changed = receive(raw, changedInput);
  expect(changed.interpretation?.mentions).toEqual(first.interpretation?.mentions);
  expect(changed.interpretation?.gaps).toEqual(first.interpretation?.gaps);
  expect(sourceSemanticInterpretationIdentity(changed.interpretation!, semanticSha256))
    .not.toBe(sourceSemanticInterpretationIdentity(first.interpretation!, semanticSha256));
  const revision = prepareSourceSemanticRevision(buildSourceSemanticRequest(input), "{bad", [], { responseCompletion: "complete" });
  expect(buildSourceSemanticRequest({ ...input, revision }).source_request.generation_task).toEqual(task);
  expect(() => buildSourceSemanticRequest({ ...changedInput, revision })).toThrow(/different original source/u);
});
