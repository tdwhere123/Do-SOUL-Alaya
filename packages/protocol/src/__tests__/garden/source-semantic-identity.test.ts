import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { canonicalJson } from "../../recall/selection/capture/canonical-json.js";
import { SourceSemanticInterpretationSchema } from "../../garden/source-semantic-interpretation.js";
import { SourceSemanticQuerySchema } from "../../recall/conditional-field/semantic-query.js";
import { SourceSemanticAlignmentSchema } from "../../recall/conditional-field/semantic-alignment.js";
import { SourceSemanticEvaluationContextSchema } from "../../recall/conditional-field/interpretation-context.js";
import {
  sourceSemanticAlignmentIdentity, sourceSemanticAlignmentPreimage, sourceSemanticContextIdentity,
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

it("hashes H from semantic body, K/normalizer, source binding, and producer versions only", () => {
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

it("keeps Q identity independent of H", () => {
  const qid = sourceSemanticQueryIdentity(query, sha);
  expect(canonicalJson(sourceSemanticQueryPreimage(query))).not.toContain("h_id");
  expect(qid).toBe(sourceSemanticQueryIdentity(query, sha));
  expect(qid).not.toBe(sourceSemanticInterpretationIdentity(interpretation, sha));
  expect(SourceSemanticQuerySchema.safeParse({ ...query, h_id: digest }).success).toBe(false);
});

it("keeps A and C acyclic: A hashes H and Q, C hashes A_id, A never contains C", () => {
  const hid = sourceSemanticInterpretationIdentity(interpretation, sha);
  const qid = sourceSemanticQueryIdentity(query, sha);
  const alignment = SourceSemanticAlignmentSchema.parse({
    contract: "source-semantic-alignment-v2", h_id: hid, q_id: qid,
    producer_id: "ap", producer_version: "1", contract_version: "source-semantic-alignment-v2",
    correspondences: [{
      relation: "contextual_equivalence",
      query_endpoint: { kind: "predicate", alternative: 0, frame: "qSend" },
      source_endpoint: { kind: "frame", frame: "fSend" },
      query_support: { kind: "query_text", excerpt: "sent" },
      source_semantic_support: [{ kind: "lexical", mentions: ["mSent"] }]
    }]
  });
  const aid = sourceSemanticAlignmentIdentity(alignment, sha);
  expect(canonicalJson(sourceSemanticAlignmentPreimage(alignment))).toContain(hid);
  expect(canonicalJson(sourceSemanticAlignmentPreimage(alignment))).toContain(qid);
  expect(SourceSemanticAlignmentSchema.safeParse({ ...alignment, c_id: other }).success).toBe(false);
  const context = SourceSemanticEvaluationContextSchema.parse({
    contract: "source-semantic-context-v2", h_id: hid, q_id: qid, a_id: aid,
    k_version: "k1", lowering_version: "l1"
  });
  const cid = sourceSemanticContextIdentity(context, sha);
  expect(canonicalJson(sourceSemanticContextPreimage(context))).toContain(aid);
  expect(canonicalJson(sourceSemanticAlignmentPreimage(alignment))).not.toContain(cid);
  expect(SourceSemanticEvaluationContextSchema.safeParse({
    contract: "source-semantic-context-v2", h_id: hid, q_id: qid, k_version: "k1", lowering_version: "l1"
  }).success).toBe(false);
  expect(SourceSemanticEvaluationContextSchema.safeParse({ ...context, branch_id: other }).success).toBe(false);
});
