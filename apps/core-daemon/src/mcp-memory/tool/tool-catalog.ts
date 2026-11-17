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
    "Optional `enumeration_policy` (`native_query` default and the only value live execution accepts; `canonical` and `associative` stay parseable for historical readers but are rejected), `result_kind_view` (`mixed` default, or `memory_only`/`source_only`), `query_coordinates`, `interpretation_proposal`, and `payload_continuation` are request identity/view fields. Selectively continue a relevant ranked result ONLY when its `target.span.content_complete === false` by repeating the request with the returned `index.continuation` and `payload_continuation` {schema_version:1, purpose:\"payload_expansion\", target: its index entry target, start_offset: span.content_end} until `content_complete` is true (do not blindly fetch every cut result). For single-call coordinates, pass `query_coordinates` with optional `question_time` ({intervals:[{start:\"YYYY-MM-DD\", end:\"YYYY-MM-DD\"}]} — up to 32 closed UTC calendar-day alternatives formed from the question and clock only, never from sources or answers; no `interpretation_clock` needed), optional `evidence_conditions` (1..4 `{statement, speaker:\"user\"|\"assistant\", anchors}` where each anchor is a verbatim substring of `query`), and optional `evidence_relation:\"derived\"` when aggregating across stated facts. The daemon binds digest and clock automatically and degrades invalid conditions or date windows safely without dropping raw recall. `question_time` is a soft preference on source event_time under the existing root/attempt limits; `since`/`until` remain hard filters. Pre-sealed `interpretation_proposal` packets remain supported for host replay (mutually exclusive with `query_coordinates`). First-page `member_index` entries expose `statement_ids` and workspace-scoped `source_target` handles openable via `soul.open_pointer`. `associative` also requires declared `cap_contracts`; absence is incompatible (parse error), not a default. Results carry a tagged `target`; source-record-only rows use `object_kind` `source_evidence` and do not mint a memory id. Responses may include `page_purpose` and `product_updates`; retrying the same continuation replays the same `delivery_id`. Plain `mixed` calls work out of the box (omitted `protocol_version` defaults to `1` and omitted capability flags default to supporting `memory_entry` and `source_evidence`); older consumers that cannot parse source targets must request `result_kind_view=memory_only` or explicitly declare `supports_source_evidence=false` / `supported_result_kinds`. Start memory-sensitive turns here; use the returned `delivery_id` later in soul.report_context_usage.",
  "soul.open_pointer":
    "Use this before citing memory or source content so evidence is grounded in retrieved objects; for `source_target` reads, pass `start_offset` from `target.span.content_end` when `content_complete` is false to read further chunks.",
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
