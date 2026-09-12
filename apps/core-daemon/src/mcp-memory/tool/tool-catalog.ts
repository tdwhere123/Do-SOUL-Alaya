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
  "soul.resolve",
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
    "Optional `enumeration_policy` (`canonical` default, or `associative`), `result_kind_view` (`mixed` default, or `memory_only`/`source_only`), `interpretation_proposal`, and `payload_continuation` are request identity/view fields. Associative enumeration requires declared `cap_contracts`; absence is incompatible (unsupported-policy), not a D2 default. Results carry a tagged `target`; source-record-only rows use `object_kind` `source_evidence` and do not mint a memory id. Responses may include `page_purpose` and `product_updates`; retrying the same continuation replays the same `delivery_id`. Older consumers that cannot parse source targets must request `result_kind_view=memory_only` rather than dropping or recasting source rows. Start memory-sensitive turns here; use the returned delivery_id later in soul.report_context_usage. Mixed or source_only views require protocol_version=1 and source_evidence support; undeclared mixed is a compatibility error rather than a later parse failure.",
  "soul.open_pointer":
    "Use this before citing memory content so evidence is grounded in retrieved objects.",
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
  "soul.resolve":
    "Apply a resolution against a staged warning surfaced by soul.recall; the audit event is the durable record of the decision.",
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
    "soul.resolve": writeAnnotation,
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
