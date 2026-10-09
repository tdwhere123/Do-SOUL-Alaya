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

const GENERATION_TASK = {
  contract: "source-semantic-generation-task-v1" as const,
  context: "complete_original_source" as const,
  original_query: "which tools does Alice use?",
  responsibility: { kind: "original_query_task" as const, other_meaning: "unassessed" as const }
};

function proposeBranch(schema: Record<string, unknown>): Record<string, unknown> {
  const branches = schema.oneOf;
  if (!Array.isArray(branches)) throw new Error("soul.interpretation schema must advertise oneOf operations");
  const propose = branches.find((branch): branch is Record<string, unknown> => {
    if (branch === null || typeof branch !== "object" || Array.isArray(branch)) return false;
    const operation = (branch.properties as Record<string, unknown> | undefined)?.operation;
    if (operation === null || typeof operation !== "object" || Array.isArray(operation)) return false;
    return (operation as { const?: unknown }).const === "propose"
      || (Array.isArray((operation as { enum?: unknown }).enum)
        && (operation as { enum: unknown[] }).enum.includes("propose"));
  });
  if (propose === undefined) throw new Error("soul.interpretation schema must advertise propose");
  return propose;
}

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
    original_query: "which tools does Alice use?",
    budget: BUDGET,
    output_byte_limit: 4096
  }).operation).toBe("recall");
  expect(SoulInterpretationRequestSchema.safeParse({ operation: "recall",
    accepts_unreviewed_conditional_results: true, budget: BUDGET, output_byte_limit: 4096 }).success).toBe(false);
  expect(SoulInterpretationRequestSchema.safeParse({ operation: "recall",
    accepts_unreviewed_conditional_results: true, original_query: "question",
    query_semantics_unavailable: "producer_failure", query_semantics: {},
    budget: BUDGET, output_byte_limit: 4096 }).success).toBe(false);
  expect(SoulInterpretationRequestSchema.safeParse({
    operation: "report_context_usage",
    budget: BUDGET
  }).success).toBe(false);
  expect(soulToolJsonSchemas["soul.interpretation"]).toMatchObject({
    oneOf: [{ type: "object" }, { type: "object" }, { type: "object" }, { type: "object" }, { type: "object" }]
  });
});

it("accepts propose generation_task only as a draft sibling and advertises that field", () => {
  const base = {
    operation: "propose" as const,
    source_handle: "src-handle",
    producer_id: "author",
    producer_version: "1",
    contract_version: "source-interpretation-v4"
  };
  const absent = SoulInterpretationRequestSchema.parse({ ...base, draft: DRAFT });
  const present = SoulInterpretationRequestSchema.parse({ ...base, draft: DRAFT, generation_task: GENERATION_TASK });
  if (absent.operation !== "propose" || present.operation !== "propose") throw new Error("propose required");
  expect(absent.generation_task).toBeUndefined();
  expect(present.generation_task).toEqual(GENERATION_TASK);
  expect(SoulInterpretationRequestSchema.safeParse({ ...base, draft: { ...DRAFT, generation_task: GENERATION_TASK } }).success)
    .toBe(false);
  expect(SoulInterpretationRequestSchema.safeParse({ ...base, draft: DRAFT, generation_task: { ...GENERATION_TASK, original_query: " " } }).success)
    .toBe(false);
  expect(SoulInterpretationRequestSchema.safeParse({
    ...base, generation_task: GENERATION_TASK,
    disposition: { status: "no_executable_proposition", description: "no claim", context_support: [] }
  }).success).toBe(false);
  expect(SoulInterpretationRequestSchema.safeParse({ ...base, generation_task: GENERATION_TASK }).success).toBe(false);
  const advertised = proposeBranch(soulToolJsonSchemas["soul.interpretation"]);
  const properties = advertised.properties as Record<string, unknown>;
  expect(properties).toHaveProperty("generation_task");
  const draft = properties.draft as { properties?: Record<string, unknown> } | undefined;
  expect(draft?.properties ?? {}).not.toHaveProperty("generation_task");
});
