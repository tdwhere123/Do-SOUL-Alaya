import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { canonicalJson } from "../../recall/selection/capture/canonical-json.js";
import { SourceSemanticInterpretationSchema } from "../../garden/source-semantic-interpretation.js";
import { SourceSemanticQuerySchema } from "../../recall/conditional-field/semantic-query.js";
import { SourceSemanticCorrespondenceSchema } from "../../recall/conditional-field/semantic-correspondence.js";
import { SourceSemanticEvaluationContextSchema } from "../../recall/conditional-field/interpretation-context.js";
import {
  sourceSemanticCorrespondenceIdentity, sourceSemanticCorrespondencePreimage, sourceSemanticContextIdentity,
  sourceSemanticContextPreimage, sourceSemanticInterpretationIdentity, sourceSemanticInterpretationPreimage,
  sourceSemanticQueryIdentity, sourceSemanticQueryPreimage
} from "../../garden/source-semantic-identity.js";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const digest = `sha256:${"a".repeat(64)}`;
const other = `sha256:${"b".repeat(64)}`;

const interpretation = SourceSemanticInterpretationSchema.parse({
  contract: "source-interpretation-v4",
  k_version: "k1", normalizer_version: "n1",
  source: { source_id: "src", source_version: "1", content_digest: digest },
  producer_id: "producer", producer_version: "p1", contract_version: "source-interpretation-v4",
  mentions: [{ id: "mSent", assertion_id: 1, source_ref: { first: "a1s0", last: "a1s0" }, text: "sent", utf8_span: [0, 4] }],
  referents: [{ id: "rBob", referent_kind: "grouped", mentions: ["mSent"] }],
  frames: [{
    id: "fSend", assertion_ids: [1], context_owner: { kind: "source_act", source_act: "assertion" },
    additional_support: [], predicate_support: { kind: "explicit", reading: "send", mentions: ["mSent"] },
    slots: [{ id: "agent", role_reading: "agent", support: [{ kind: "lexical", mentions: ["mSent"] }] }],
    bindings: [{ slot_id: "agent", target: { kind: "node", id: "rBob" }, support: [] }]
  }],
  operators: [], gaps: [], entry_roots: ["fSend"], asserted_at_scope: ["fSend"]
});

const query = SourceSemanticQuerySchema.parse({
  contract: "source-semantic-query-v2", original_query_digest: digest,
  producer_id: "qp", producer_version: "1", contract_version: "source-semantic-query-v2",
  variables: [{ id: "parcel", sort: "entity" }, { id: "fSend", sort: "proposition" }],
  alternatives: [{
    frames: [{
      id: "qSend", variable: "fSend", predicate_reading: "send",
      role_requirements: [{ id: "object", role_reading: "object", target_variable: "parcel",
        support: { kind: "query_text", excerpt: "parcel" } }]
    }],
    context_obligations: [{ frame: "qSend", kind: "asserted_at_source" }]
  }],
  return_variables: ["parcel"], gaps: []
});

it("hashes source interpretation from semantic body, structural version, normalizer, source binding, and producer versions only", () => {
  const preimage = canonicalJson(sourceSemanticInterpretationPreimage(interpretation));
  expect(preimage).toContain("k1");
  expect(preimage).toContain("producer");
  expect(preimage).not.toContain("request_key");
  expect(preimage).not.toContain("raw_response");
  expect(preimage).not.toContain("principal");
  expect(preimage).not.toContain("preparation_handle");
  expect(sourceSemanticInterpretationIdentity(interpretation, sha)).toMatch(/^sha256:[0-9a-f]{64}$/u);
  const shifted = SourceSemanticInterpretationSchema.parse({
    ...interpretation, producer_version: "p2"
  });
  expect(sourceSemanticInterpretationIdentity(shifted, sha))
    .not.toBe(sourceSemanticInterpretationIdentity(interpretation, sha));
  const relocated = SourceSemanticInterpretationSchema.parse({
    ...interpretation,
    mentions: interpretation.mentions.map((row) => ({ ...row, utf8_span: [9, 13] as const }))
  });
  expect(sourceSemanticInterpretationIdentity(relocated, sha))
    .toBe(sourceSemanticInterpretationIdentity(interpretation, sha));
});

it("keeps query-semantics identity independent of source interpretation", () => {
  const querySemanticsId = sourceSemanticQueryIdentity(query, sha);
  expect(canonicalJson(sourceSemanticQueryPreimage(query))).not.toContain("source_interpretation_id");
  expect(querySemanticsId).toBe(sourceSemanticQueryIdentity(query, sha));
  expect(querySemanticsId).not.toBe(sourceSemanticInterpretationIdentity(interpretation, sha));
  expect(SourceSemanticQuerySchema.safeParse({ ...query, source_interpretation_id: digest }).success).toBe(false);
});

it("keeps semantic correspondence and conditional computation acyclic: correspondence hashes source interpretation and query semantics, computation hashes correspondence, and correspondence never contains computation", () => {
  const sourceInterpretationId = sourceSemanticInterpretationIdentity(interpretation, sha);
  const querySemanticsId = sourceSemanticQueryIdentity(query, sha);
  const semantic_correspondence = SourceSemanticCorrespondenceSchema.parse({
    contract: "source-semantic-correspondence-v3", source_interpretation_id: sourceInterpretationId, query_semantics_id: querySemanticsId,
    producer_id: "ap", producer_version: "1", contract_version: "source-semantic-correspondence-v3",
    correspondences: [{
      relation: "contextual_equivalence",
      query_endpoint: { kind: "predicate", alternative: 0, frame: "qSend" },
      source_endpoint: { kind: "frame", frame: "fSend" },
      query_support: { kind: "query_text", excerpt: "sent" },
      source_semantic_support: [{ kind: "lexical", mentions: ["mSent"] }]
    }]
  });
  const semanticCorrespondenceId = sourceSemanticCorrespondenceIdentity(semantic_correspondence, sha);
  expect(canonicalJson(sourceSemanticCorrespondencePreimage(semantic_correspondence))).toContain(sourceInterpretationId);
  expect(canonicalJson(sourceSemanticCorrespondencePreimage(semantic_correspondence))).toContain(querySemanticsId);
  expect(SourceSemanticCorrespondenceSchema.safeParse({ ...semantic_correspondence, conditional_computation_id: other }).success).toBe(false);
  const context = SourceSemanticEvaluationContextSchema.parse({
    contract: "source-semantic-context-v3", source_interpretation_id: sourceInterpretationId, query_semantics_id: querySemanticsId, semantic_correspondence_id: semanticCorrespondenceId,
    k_version: "k1", lowering_version: "l1"
  });
  const conditionalComputationId = sourceSemanticContextIdentity(context, sha);
  expect(canonicalJson(sourceSemanticContextPreimage(context))).toContain(semanticCorrespondenceId);
  expect(canonicalJson(sourceSemanticCorrespondencePreimage(semantic_correspondence))).not.toContain(conditionalComputationId);
  expect(SourceSemanticEvaluationContextSchema.safeParse({
    contract: "source-semantic-context-v3", source_interpretation_id: sourceInterpretationId, query_semantics_id: querySemanticsId, k_version: "k1", lowering_version: "l1"
  }).success).toBe(false);
  expect(SourceSemanticEvaluationContextSchema.safeParse({ ...context, branch_id: other }).success).toBe(false);
});
