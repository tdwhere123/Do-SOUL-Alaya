import { soulToolJsonSchemas } from "@do-soul/alaya-protocol";
import { soulToolDefs } from "@do-soul/alaya-engine-gateway";

export const ALAYA_MEMORY_TOOL_NAMES = Object.freeze([
  "soul.recall",
  "soul.open_pointer",
  "soul.emit_candidate_signal",
  "soul.propose_memory_update",
  "soul.review_memory_proposal",
  "soul.list_pending_proposals",
  "soul.propose_edge",
  "soul.list_pending_edge_proposals",
  "soul.batch_review_edge_proposals",
  "soul.apply_override",
  "soul.explore_graph",
  "soul.report_context_usage",
  "soul.capture_host_session",
  "soul.resolve",
  "soul.interpretation",
  "garden.list_pending_tasks",
  "garden.claim_task",
  "garden.complete_task"
] as const);

export type AlayaMemoryToolName = (typeof ALAYA_MEMORY_TOOL_NAMES)[number];

const soulToolSpecByName = new Map(soulToolDefs.map((spec) => [spec.name, spec]));
if (soulToolDefs.length !== ALAYA_MEMORY_TOOL_NAMES.length) {
  throw new Error("soulToolDefs / daemon catalog name count diverged");
}
for (const name of ALAYA_MEMORY_TOOL_NAMES) {
  if (!soulToolSpecByName.has(name)) {
    throw new Error(`soulToolDefs is missing ${name}`);
  }
}

/**
 * MCP tool input schema. Derived from `@do-soul/alaya-protocol`
 * `soulToolJsonSchemas` (zod → JSON Schema) so external clients see the
 * exact same bounds the runtime enforces.
 */
export type JsonObjectSchema = Readonly<Record<string, unknown>>;

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

const loopSuffixByName: Readonly<Record<AlayaMemoryToolName, string>> = Object.freeze({
  "soul.recall":
    "Use `result_kind_view: \"memory_only\"` if the consumer cannot parse `source_evidence`. The default `mixed` view supports both result kinds. Selectively continue a relevant ranked result when its `target.span.content_complete === false`. Repeat the request with the returned `index.continuation` and `payload_continuation` {schema_version:1, purpose:\"payload_expansion\", target: its index entry target, start_offset: span.content_end} until `content_complete` is true. Retry the same continuation to replay its `delivery_id`. Use the returned `delivery_id` in soul.report_context_usage.",
  "soul.open_pointer":
    "Pass `member_index[i].source_target` directly. For a ranked `source_evidence` result, construct `source_target: { root_kind, root_id, source_version, content_digest, evidence_object_id }` from its target and omit `workspace_id`, `kind`, and `span`. When `target.span.content_complete === false`, pass `target.span.content_end` as top-level `start_offset` instead of rereading from `0`; do not reopen an already-read range or a ranked result whose `target.span.content_start === 0` and `target.span.content_complete === true`. Never put a source `root_id` in `object_id`.",
  "soul.emit_candidate_signal":
    "This records candidate intent only; it does not create or mutate durable memory entries.",
  "soul.propose_memory_update":
    "This creates a pending proposal for governance; durable memory remains unchanged until acceptance apply.",
  "soul.review_memory_proposal":
    "Use only after listing pending proposals and obtaining explicit reviewer approval; accept triggers apply, reject preserves memory as-is.",
  "soul.list_pending_proposals":
    "Review queues represent governance state only; pending items are not durable memory writes.",
  "soul.propose_edge":
    "Pending edge proposals are governance queue items only; durable graph edges are written only after review.",
  "soul.list_pending_edge_proposals":
    "Read-only inspection aid for graph governance; pending items are not durable path relations.",
  "soul.batch_review_edge_proposals":
    "Use only after explicit reviewer approval; accept mints a durable path relation, reject preserves graph state.",
  "soul.apply_override":
    "Session-only correction for the current run; it does not promote durable memory by itself.",
  "soul.explore_graph":
    "Inspection aid for related memories; keep write actions on proposal/candidate tools.",
  "soul.report_context_usage":
    "Close the delivery loop by marking used/skipped/not_applicable so trust state stays explicit.",
  "soul.capture_host_session":
    "Captured messages are source input, not claims of truth; a repeated window admits nothing new.",
  "soul.resolve":
    "Apply a resolution against a staged warning surfaced by soul.recall; the audit event is the durable record of the decision.",
  "soul.interpretation": "",
  "garden.list_pending_tasks": "",
  "garden.claim_task": "",
  "garden.complete_task": ""
});

function catalogDescriptionFor(name: AlayaMemoryToolName): string {
  const spec = soulToolSpecByName.get(name);
  if (spec === undefined) {
    throw new Error(`soulToolDefs is missing ${name}`);
  }
  const suffix = loopSuffixByName[name].trim();
  return suffix.length === 0 ? spec.description : `${spec.description} ${suffix}`;
}

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

const annotationByToolName: Record<AlayaMemoryToolName, AlayaMemoryToolDefinition["annotations"]> =
  Object.freeze({
    "soul.recall": writeAnnotation,
    "soul.open_pointer": readOnlyAnnotation,
    "soul.emit_candidate_signal": writeAnnotation,
    "soul.propose_memory_update": writeAnnotation,
    "soul.review_memory_proposal": writeAnnotation,
    "soul.list_pending_proposals": readOnlyAnnotation,
    "soul.propose_edge": writeAnnotation,
    "soul.list_pending_edge_proposals": readOnlyAnnotation,
    "soul.batch_review_edge_proposals": writeAnnotation,
    "soul.apply_override": writeAnnotation,
    "soul.explore_graph": readOnlyAnnotation,
    "soul.report_context_usage": writeAnnotation,
    "soul.capture_host_session": Object.freeze({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    }),
    "soul.resolve": writeAnnotation,
    "soul.interpretation": Object.freeze({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false
    }),
    "garden.list_pending_tasks": readOnlyAnnotation,
    "garden.claim_task": writeAnnotation,
    "garden.complete_task": writeAnnotation
  });

export function listAlayaMemoryTools(): readonly AlayaMemoryToolDefinition[] {
  return ALAYA_MEMORY_TOOL_NAMES.map((name) =>
    Object.freeze({
      name,
      description: catalogDescriptionFor(name),
      inputSchema: soulToolJsonSchemas[name],
      annotations: annotationByToolName[name]
    })
  );
}

export function hasAlayaMemoryToolName(value: string): value is AlayaMemoryToolName {
  return (ALAYA_MEMORY_TOOL_NAMES as readonly string[]).includes(value);
}
