import { expect, it } from "vitest";
import {
  SoulInterpretationRequestSchema,
  soulToolJsonSchemas
} from "../../surfaces/mcp-types.js";

const BUDGET = {
  schema_version: 1 as const,
  work_units: 1000,
  memory_bytes: 10_000,
  page_budget: 100,
  finalization_reserve: 10,
  min_envelope: 1
};

const DRAFT = {
  contract: "source-interpretation-v4" as const,
  mentions: [{ id: "mSent", assertion_id: 1, source_ref: { first: "a1s0", last: "a1s0" } }],
  referents: [{ id: "rBob", referent_kind: "grouped" as const, mentions: ["mSent"] }],
  frames: [{
    id: "fSend",
    assertion_ids: [1],
    context_owner: { kind: "source_act" as const, source_act: "assertion" as const },
    additional_support: [],
    predicate_support: { kind: "explicit" as const, reading: "send", mentions: ["mSent"] },
    slots: [{ id: "agent", role_reading: "agent", support: [{ kind: "lexical" as const, mentions: ["mSent"] }] }],
    bindings: [{ slot_id: "agent", target: { kind: "node" as const, id: "rBob" }, support: [] }]
  }],
  operators: [],
  gaps: []
};

it("parses soul.interpretation host operations including library recall and rejects unknown operations", () => {
  expect(SoulInterpretationRequestSchema.parse({
    operation: "prepare_source",
    source_id: "artifact-1",
    budget: BUDGET
  }).operation).toBe("prepare_source");
  expect(SoulInterpretationRequestSchema.parse({
    operation: "propose",
    source_handle: "src-handle",
    draft: DRAFT,
    producer_id: "author",
    producer_version: "1",
    contract_version: "source-interpretation-v4"
  }).operation).toBe("propose");
  expect(SoulInterpretationRequestSchema.parse({
    operation: "prepare_query",
    original_query: "which tools does Alice use?",
    budget: BUDGET
  }).operation).toBe("prepare_query");
  expect(SoulInterpretationRequestSchema.parse({
    operation: "reason",
    accepts_unreviewed_conditional_results: true,
    budget: BUDGET,
    output_byte_limit: 4096
  }).operation).toBe("reason");
  expect(SoulInterpretationRequestSchema.parse({
    operation: "recall",
    accepts_unreviewed_conditional_results: true,
    budget: BUDGET,
    output_byte_limit: 4096
  }).operation).toBe("recall");
  expect(SoulInterpretationRequestSchema.safeParse({
    operation: "report_context_usage",
    budget: BUDGET
  }).success).toBe(false);
  expect(soulToolJsonSchemas["soul.interpretation"]).toMatchObject({
    oneOf: [{ type: "object" }, { type: "object" }, { type: "object" }, { type: "object" }, { type: "object" }]
  });
});
