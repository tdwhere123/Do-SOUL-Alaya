import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { SourceSemanticDraftSchema } from "../../garden/source-semantic-draft.js";
import {
  LegacyUnresolvedProjectionSchema, SourceSemanticCacheSchema, SourceSemanticInterpretationSchema,
  SourceSemanticOutcomeSchema, SourceSemanticPublishedInterpretationSchema,
  SourceSemanticReasoningRequestSchema, SourceSemanticReasoningResultSchema,
  SourceSemanticRequestEnvelopeSchema, SourceSemanticResponseEnvelopeSchema
} from "../../garden/source-semantic-interpretation.js";
import { sourceSemanticInterpretationIdentity } from "../../garden/source-semantic-identity.js";
import { SourceInterpretationPacketSchema, SourceInterpretationReasoningResultSchema }
  from "../../garden/source-interpretation-packet.js";
import { AssociativeFactFrameSchema } from "../../evidence/associative-fact-frame.js";
import { MemorySearchResultSchema } from "../../surfaces/mcp-memory-search-types.js";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const digest = `sha256:${"a".repeat(64)}`;
const hex = "a".repeat(64);
const mention = { id: "mSent", assertion_id: 1, source_ref: { first: "a1s0", last: "a1s0" },
  text: "sent", utf8_span: [0, 4] as const };
const irBody = {
  contract: "source-interpretation-v3" as const,
  k_version: "k1", normalizer_version: "n1",
  source: { source_id: "src", source_version: "1", content_digest: digest },
  producer_id: "producer", producer_version: "p1", contract_version: "source-interpretation-v3",
  mentions: [mention],
  referents: [{ id: "rBob", referent_kind: "grouped" as const, mentions: ["mSent"] }],
  frames: [{
    id: "fSend", assertion_ids: [1],
    context_owner: { kind: "source_act" as const, source_act: "assertion" as const },
    additional_support: [],
    predicate_support: { kind: "explicit" as const, reading: "send", mentions: ["mSent"] },
    slots: [{ id: "agent", role_reading: "agent", support: [{ kind: "lexical" as const, mentions: ["mSent"] }] }],
    bindings: [{ slot_id: "agent", target: { kind: "node" as const, id: "rBob" }, support: [] }]
  }],
  operators: [],
  gaps: [],
  entry_roots: ["fSend"],
  asserted_at_scope: ["fSend"]
};

it("accepts normalized IR and rejects asserted_at_scope without source_act assertion", () => {
  expect(SourceSemanticInterpretationSchema.parse(irBody).asserted_at_scope).toEqual(["fSend"]);
  expect(SourceSemanticInterpretationSchema.safeParse({
    ...irBody,
    frames: [{ ...irBody.frames[0]!, context_owner: { kind: "source_act", source_act: "question" } }],
    asserted_at_scope: ["fSend"]
  }).success).toBe(false);
  expect(SourceSemanticInterpretationSchema.safeParse({ ...irBody, request_key: "run" }).success).toBe(false);
});

it("keeps published provenance out of parse identity of the IR body", () => {
  const interpretation = SourceSemanticInterpretationSchema.parse(irBody);
  const published = SourceSemanticPublishedInterpretationSchema.parse({
    contract: "published-source-interpretation-v3",
    interpretation_id: sourceSemanticInterpretationIdentity(interpretation, sha),
    semantic_status: "unreviewed",
    source_target: { kind: "source_evidence", workspace_id: "ws", root_kind: "source_record",
      root_id: "src", source_version: "1", content_digest: digest, evidence_object_id: null },
    interpretation,
    provenance: { producer_id: "producer", request_key: "req", raw_response_id: "raw",
      principal: "user", snapshot: "snap", preparation_handle: "prep" }
  });
  expect(published.provenance.request_key).toBe("req");
  expect(sourceSemanticInterpretationIdentity(published.interpretation, sha)).toBe(published.interpretation_id);
});

it("keeps evaluation states distinct and refuses packet:null collapse", () => {
  expect(SourceSemanticOutcomeSchema.parse({ status: "no_eligible_source", provider_attempts: 0 }).status)
    .toBe("no_eligible_source");
  expect(SourceSemanticOutcomeSchema.parse({ status: "unavailable", reason: "source_body" }).status).toBe("unavailable");
  expect(SourceSemanticOutcomeSchema.parse({ status: "abstained" }).status).toBe("abstained");
  expect(SourceSemanticOutcomeSchema.parse({ status: "unexercised" }).status).toBe("unexercised");
  expect(SourceSemanticOutcomeSchema.safeParse({ status: "no_eligible_source", provider_attempts: 1 }).success).toBe(false);
  expect(SourceSemanticOutcomeSchema.parse({
    status: "no_executable_proposition", description: "no event", context_support: [{ kind: "source_reference", assertion_id: 1, source_ref: { first: "a1s0", last: "a1s0" } }]
  }).status).toBe("no_executable_proposition");
  expect(SourceSemanticResponseEnvelopeSchema.safeParse({
    contract: "source-interpretation-response-v3",
    outcome: { status: "interpreted", gaps: [] }
  }).success).toBe(false);
  expect(SourceSemanticResponseEnvelopeSchema.safeParse({
    contract: "source-interpretation-response-v3",
    outcome: { status: "abstained" }, packet: null
  }).success).toBe(false);
});

it("requires a draft only for interpreted responses", () => {
  const draft = SourceSemanticDraftSchema.parse({
    contract: "source-interpretation-v3",
    mentions: [{ id: "mSent", assertion_id: 1, source_ref: { first: "a1s0", last: "a1s0" } }],
    referents: [{ id: "rBob", referent_kind: "grouped", mentions: ["mSent"] }],
    frames: irBody.frames, operators: [], gaps: []
  });
  expect(SourceSemanticResponseEnvelopeSchema.parse({
    contract: "source-interpretation-response-v3",
    outcome: { status: "interpreted", gaps: [] },
    draft
  }).outcome.status).toBe("interpreted");
  expect(SourceSemanticResponseEnvelopeSchema.parse({
    contract: "source-interpretation-response-v3",
    outcome: { status: "no_eligible_source", provider_attempts: 0 }
  }).draft).toBeUndefined();
});

it("versions the open envelope, reasoning, and cache without reusing occupied literals", () => {
  expect(SourceSemanticRequestEnvelopeSchema.parse({
    schema_version: 4, interpretation_contract: "source-interpretation-v3", source_request: {},
    source_catalog: { contract: "ascii-run-unicode-scalar-v1", source_digest: hex, catalog_id: digest, assertions: [] }
  }).schema_version).toBe(4);
  expect(SourceSemanticRequestEnvelopeSchema.safeParse({
    schema_version: 3, interpretation_contract: "source-interpretation-v3", source_request: {},
    source_catalog: { contract: "ascii-run-unicode-scalar-v1", source_digest: hex, catalog_id: digest, assertions: [] }
  }).success).toBe(false);
  const budget = { schema_version: 1, work_units: 1, memory_bytes: 1, page_budget: 1, finalization_reserve: 0, min_envelope: 0 };
  expect(SourceSemanticReasoningRequestSchema.parse({
    contract: "source-interpretation-reasoning-v2", accepts_unreviewed_conditional_results: true,
    h_id: digest, q_id: digest, a_id: digest, original_query: "who sent P?", budget, output_byte_limit: 1024
  }).contract).toBe("source-interpretation-reasoning-v2");
  expect(SourceSemanticReasoningRequestSchema.safeParse({
    contract: "source-interpretation-reasoning-v2", accepts_unreviewed_conditional_results: true,
    h_id: digest, q_id: digest, a_id: digest, original_query: "who sent P?", budget, output_byte_limit: 1024,
    program: { schema_version: 1, kind: "epsilon" }, seed_nodes: ["fSend"]
  }).success).toBe(false);
  expect(SourceSemanticCacheSchema.parse({
    contract: "source-interpretation-cache-v2", source_binding: "unbound",
    interpretation_contract: "source-interpretation-v3"
  }).contract).toBe("source-interpretation-cache-v2");
});

it("does not parse the new result as MemorySearchResult, world fact, or live v1 reasoning", () => {
  const result = SourceSemanticReasoningResultSchema.parse({
    contract: "source-interpretation-reasoning-v2",
    outcome: { status: "interpreted", gaps: [] },
    c_id: digest, consumed_leaves: [], semantic_status: "unreviewed",
    conclusion_scope: "conditional_on_interpretation", world_claim: "unknown"
  });
  expect(MemorySearchResultSchema.safeParse(result).success).toBe(false);
  expect(AssociativeFactFrameSchema.safeParse(result).success).toBe(false);
  expect(SourceInterpretationReasoningResultSchema.safeParse(result).success).toBe(false);
  expect(SourceInterpretationPacketSchema.safeParse(irBody).success).toBe(false);
});

it("records legacy_unresolved without backfilling stance", () => {
  expect(LegacyUnresolvedProjectionSchema.parse({
    kind: "legacy_unresolved", source_contract: "source-interpretation-v2", missing: ["stance", "alignment"]
  }).missing).toEqual(["stance", "alignment"]);
});
