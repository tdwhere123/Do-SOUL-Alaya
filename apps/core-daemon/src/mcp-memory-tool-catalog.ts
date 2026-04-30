export const ALAYA_MEMORY_TOOL_NAMES = Object.freeze([
  "soul.recall",
  "soul.open_pointer",
  "soul.emit_candidate_signal",
  "soul.propose_memory_update",
  "soul.review_memory_proposal",
  "soul.apply_override",
  "soul.explore_graph",
  "soul.report_context_usage"
] as const);

export type AlayaMemoryToolName = (typeof ALAYA_MEMORY_TOOL_NAMES)[number];

export type JsonObjectSchema = Readonly<{
  readonly type: "object";
  readonly properties?: Readonly<Record<string, object>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean;
}>;

export interface AlayaMemoryToolDefinition {
  readonly name: AlayaMemoryToolName;
  readonly description: string;
  readonly inputSchema: JsonObjectSchema;
  readonly annotations: Readonly<{
    readonly readOnlyHint: boolean;
    readonly destructiveHint: boolean;
    readonly idempotentHint: boolean;
    readonly openWorldHint: boolean;
  }>;
}

const descriptionByName: Readonly<Record<AlayaMemoryToolName, string>> = Object.freeze({
  "soul.recall":
    "Recall relevant durable memory for the current task. Returns ranked candidates, evidence pointers, and a delivery id for later usage proof.",
  "soul.open_pointer":
    "Open a recalled memory object or evidence pointer by id. Read-only; use before citing recalled context in model output.",
  "soul.emit_candidate_signal":
    "Emit a candidate memory signal when you detect a durable preference, decision, constraint, handoff, conflict, synthesis, or evidence anchor worth tracking. (This tool is language-agnostic. For Chinese inputs: 当你检测到需要记忆的偏好、决定、约束、冲突或证据时，请触发此工具)",
  "soul.propose_memory_update":
    "Submit a proposed durable memory update for governance review. This does not directly write durable memory.",
  "soul.review_memory_proposal":
    "Accept or reject a pending memory proposal while preserving an explicit governance trace.",
  "soul.apply_override":
    "Apply an immediate session-only correction when the user explicitly says the current assumption/tool/behavior is wrong and should be replaced for this run.",
  "soul.explore_graph":
    "Inspect one-hop memory graph neighbors for an existing memory entry. Read-only; does not create or mutate edges.",
  "soul.report_context_usage":
    "Report whether recalled context for a delivery was used, skipped, or not applicable. Supports delivered-vs-used trust state."
});

export function listAlayaMemoryTools(): readonly AlayaMemoryToolDefinition[] {
  return ALAYA_MEMORY_TOOL_NAMES.map((name) =>
    Object.freeze({
      name,
      description: descriptionByName[name],
      inputSchema: inputSchemaByToolName[name],
      annotations: annotationByToolName[name]
    })
  );
}

export function hasAlayaMemoryToolName(value: string): value is AlayaMemoryToolName {
  return (ALAYA_MEMORY_TOOL_NAMES as readonly string[]).includes(value);
}

const stringSchema = Object.freeze({ type: "string" });
const nullableStringSchema = Object.freeze({ anyOf: [{ type: "string" }, { type: "null" }] });
const stringArraySchema = Object.freeze({ type: "array", items: { type: "string" } });
const nullableStringArraySchema = Object.freeze({
  anyOf: [stringArraySchema, { type: "null" }]
});
const objectSchema = Object.freeze({ type: "object", additionalProperties: true });
const numberSchema = Object.freeze({ type: "number" });
const integerSchema = Object.freeze({ type: "integer", minimum: 0 });

const readOnlyAnnotation = Object.freeze({
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false
});

const writeAnnotation = Object.freeze({
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false
});

const inputSchemaByToolName: Record<AlayaMemoryToolName, JsonObjectSchema> = Object.freeze({
  "soul.recall": Object.freeze({
    type: "object",
    additionalProperties: false,
    required: ["query", "max_results"],
    properties: {
      query: stringSchema,
      scope_class: nullableStringSchema,
      dimension: nullableStringSchema,
      domain_tags: nullableStringArraySchema,
      max_results: integerSchema
    }
  }),
  "soul.open_pointer": Object.freeze({
    type: "object",
    additionalProperties: false,
    required: ["object_id"],
    properties: {
      object_id: stringSchema
    }
  }),
  "soul.emit_candidate_signal": Object.freeze({
    type: "object",
    additionalProperties: false,
    required: [
      "workspace_id",
      "run_id",
      "surface_id",
      "signal_kind",
      "object_kind",
      "scope_hint",
      "domain_tags",
      "confidence",
      "evidence_refs",
      "raw_payload"
    ],
    properties: {
      workspace_id: stringSchema,
      run_id: stringSchema,
      surface_id: nullableStringSchema,
      signal_kind: stringSchema,
      object_kind: stringSchema,
      scope_hint: nullableStringSchema,
      domain_tags: stringArraySchema,
      confidence: numberSchema,
      evidence_refs: stringArraySchema,
      raw_payload: objectSchema
    }
  }),
  "soul.propose_memory_update": Object.freeze({
    type: "object",
    additionalProperties: false,
    required: ["target_object_id", "proposed_changes", "reason"],
    properties: {
      target_object_id: stringSchema,
      proposed_changes: objectSchema,
      reason: stringSchema
    }
  }),
  "soul.review_memory_proposal": Object.freeze({
    type: "object",
    additionalProperties: false,
    required: ["proposal_id", "verdict"],
    properties: {
      proposal_id: stringSchema,
      verdict: Object.freeze({ type: "string", enum: ["accept", "reject"] }),
      reason: nullableStringSchema
    }
  }),
  "soul.apply_override": Object.freeze({
    type: "object",
    additionalProperties: false,
    required: ["target_object", "correction"],
    properties: {
      target_object: stringSchema,
      correction: stringSchema,
      priority: integerSchema
    }
  }),
  "soul.explore_graph": Object.freeze({
    type: "object",
    additionalProperties: false,
    required: ["memory_id", "workspace_id"],
    properties: {
      memory_id: stringSchema,
      workspace_id: stringSchema,
      edge_types: stringArraySchema,
      direction: Object.freeze({ type: "string", enum: ["inbound", "outbound", "both"] })
    }
  }),
  "soul.report_context_usage": Object.freeze({
    type: "object",
    additionalProperties: false,
    required: ["delivery_id", "usage_state"],
    properties: {
      delivery_id: stringSchema,
      usage_state: Object.freeze({ type: "string", enum: ["used", "skipped", "not_applicable"] }),
      used_object_ids: stringArraySchema,
      reason: nullableStringSchema
    }
  })
});

const annotationByToolName: Record<AlayaMemoryToolName, AlayaMemoryToolDefinition["annotations"]> =
  Object.freeze({
    "soul.recall": readOnlyAnnotation,
    "soul.open_pointer": readOnlyAnnotation,
    "soul.emit_candidate_signal": writeAnnotation,
    "soul.propose_memory_update": writeAnnotation,
    "soul.review_memory_proposal": writeAnnotation,
    "soul.apply_override": writeAnnotation,
    "soul.explore_graph": readOnlyAnnotation,
    "soul.report_context_usage": writeAnnotation
  });
