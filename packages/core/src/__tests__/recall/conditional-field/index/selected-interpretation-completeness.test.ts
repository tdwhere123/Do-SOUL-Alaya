import { expect, it } from "vitest";
import { PublishedSourceInterpretationPacketSchema, sourceProductStateKey, sourceRecallTarget } from "@do-soul/alaya-protocol";
import { defaultView } from "../../../../recall/conditional-field/query/query-admission.js";
import { projectAcceptingIndex } from "../../../../recall/conditional-field/index/project-accepting-index.js";

const digest = `sha256:${"a".repeat(64)}`;
const source = sourceRecallTarget({ workspace_id: "workspace", root_kind: "source_record", root_id: "record",
  source_version: "1", content_digest: digest, evidence_object_id: null });
const bound = PublishedSourceInterpretationPacketSchema.parse({ contract: "published-source-interpretation-v2",
  packet_id: digest, hypothesis_id: digest, semantic_status: "unreviewed", source_target: source, artifact_key: "source",
  provenance: { request_key: "authored", raw_response_id: "authored", producer_id: "test" },
  assertions: [{ assertion_id: 1, text: "A state.", source_span: [0, 8] }], mention_spans: [],
  profile: { contract: "source-interpretation-profile-v1", description: "A state", predicates: [
    { symbol: "state", meaning: "State proposal", governing_roles: [] }], roles: [{ symbol: "subject", meaning: "Subject of a state" }] },
  packet: { contract: "source-interpretation-v2", profile_id: digest, source_catalog_id: digest,
    mentions: [], referents: [], operators: [], roots: ["state"], propositions: [
      { id: "state", predicate: "state", implicit: true, predicate_mentions: [], assertion_ids: [1], arguments: [] }] } });
const product = sourceProductStateKey({ ...source, program_state: "pending", hypothesis_id: digest,
  interpretation_node: { packet_id: digest, hypothesis_id: digest, node_id: "state" }, binding_context: "context", time_state: "as_of" });
const input = { snapshot: { schema_version: 1 as const, snapshot_id: digest, query_id: "query",
  seeds: [{ schema_version: 1 as const, state: product, milligrades: 1000 }],
  values: [{ schema_version: 1 as const, state: product, accepting: false, milligrades: 1000 }], retained_transitions: [], facets: [] },
  view: defaultView(), query_id: "query", snapshot_id: digest, result_version: "test",
  interpretation_status: "hypotheses" as const,
  observer: { outcome: { schema_version: 1 as const, status: "exhausted" as const }, open_regions: [] },
  budget: { schema_version: 1 as const, work_units: 100000, memory_bytes: 1000000, page_budget: 100000, finalization_reserve: 10000, min_envelope: 10 } };

it("retains global hypothesis uncertainty while closing a validated finite selected interpretation domain", () => {
  expect(projectAcceptingIndex(input).completeness).toMatchObject({ logical_index: "open", observed_coverage: "exhausted_empty", interpretation_coverage: "open" });
  expect(projectAcceptingIndex({ ...input, selected_interpretation: bound }).completeness).toMatchObject({
    logical_index: "complete", observed_coverage: "exhausted_empty", interpretation_coverage: "open", transport: "complete", payload: "complete" });
});

it("rejects wrong-H and foreign-source seeds before authorizing finite empty closure", () => {
  const wrong = { ...product, hypothesis_id: "foreign", interpretation_node: { ...product.interpretation_node!, hypothesis_id: "foreign" } };
  const foreignSource = { ...product, target: { ...source, root_id: "foreign" } };
  for (const state of [wrong, foreignSource]) {
    expect(() => projectAcceptingIndex({ ...input, selected_interpretation: bound,
      snapshot: { ...input.snapshot, seeds: [{ schema_version: 1, state, milligrades: 1000 }] } })).toThrow(/domain/u);
  }
});

it("does not close a selected-H empty result when observation, resource work, or domain validation is unfinished", () => {
  for (const overrides of [{ resource_work: "open" as const }, { support_work_status: "open" as const },
    { observer: { outcome: { schema_version: 1 as const, status: "interrupted" as const }, open_regions: [] } },
    { remaining_reserve: 0 }]) {
    expect(projectAcceptingIndex({ ...input, selected_interpretation: bound, ...overrides }).completeness.logical_index).not.toBe("complete");
  }
});
