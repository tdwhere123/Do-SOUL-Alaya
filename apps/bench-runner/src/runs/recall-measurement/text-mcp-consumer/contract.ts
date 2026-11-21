import { z } from "zod";
import { OrdinaryRecallEntryQuerySchema } from "../ordinary/ordinary-entry-contract.js";

/** Text-mediated MCP consumer. Not a generic agent, native tool-calling adapter, or paid QA entry. */
export const TEXT_MCP_CONSUMER_CONTRACT = "text-mcp-consumer-v1" as const;
export const TEXT_MCP_SCRIPTED_MODEL = "text-mcp-consumer-scripted" as const;
export const TEXT_MCP_ALLOWED_READ_TOOLS = ["soul.recall", "soul.open_pointer"] as const;
export type TextMcpAllowedReadTool = (typeof TEXT_MCP_ALLOWED_READ_TOOLS)[number];

const READ_TOOL_RESTRICTIONS = [
  "This diagnostic consumer may dispatch only soul.recall and soul.open_pointer through the live MCP client.",
  "Writes, garden, and generation tools are refused by host policy without calling MCP."
];
export const TEXT_MCP_CONSUMER_DIAGNOSTIC_RESTRICTION = [
  ...READ_TOOL_RESTRICTIONS,
  "Published server instructions and tool definitions above are unmodified; this restriction is host diagnostic policy, not a rewrite of guidance."
].join(" ");
export const TEXT_MCP_CONSUMER_CATALOG_SCOPED_RESTRICTION = [
  ...READ_TOOL_RESTRICTIONS,
  "Published server instructions and consumer tool definitions above are unmodified (host-only soul.interpretation omitted); this restriction is host diagnostic policy, not a rewrite of guidance."
].join(" ");
export const TEXT_MCP_PLAIN_QUERY_RESTRICTION = [
  ...READ_TOOL_RESTRICTIONS,
  "The displayed Recall instructions and schema reflect the plain-query capability profile."
].join(" ");

export const TEXT_MCP_ACTION_PROTOCOL = [
  "Return only a JSON object, one of:",
  '{"action":"read","tool":"soul.recall"|"soul.open_pointer","arguments":{...}}',
  '{"action":"answer","text":"..."}',
  "Pass tool arguments unchanged. Do not summarize, relabel, or clip MCP envelopes."
].join(" ");

/** Frozen-answer grants cover static windows. Adaptive MCP turns have no grant in this slice. */
export const TEXT_MCP_WALL_MS_MEANING = "admission_and_model_wait_budget" as const;
export const TEXT_MCP_MODEL_WORK_STATUSES = [
  "idle", "settled", "settled_late", "acked", "unsettled_unknown"
] as const;
export type TextMcpModelWorkStatus = (typeof TEXT_MCP_MODEL_WORK_STATUSES)[number];

export const TEXT_MCP_CONSUMER_PAID_READINESS = Object.freeze({
  status: "blocked_without_separate_grant" as const,
  request_binding_owner: "apps/bench-runner/src/runs/provider-request/request-binding.ts",
  attempt_owner: "apps/bench-runner/src/runs/provider-request/execution.ts",
  static_grant_note: "frozen-answer grants are static evidence windows, not interactive MCP turns",
  wall_ms_meaning: TEXT_MCP_WALL_MS_MEANING,
  in_process_complete: "cannot_preempt" as const
});

export const TEXT_MCP_CONSUMER_REMOTE_BLOCKED_MESSAGE = [
  "text MCP consumer has no live-provider authorization for adaptive turns;",
  "per-turn binding belongs to bindSemanticProviderRequest,",
  "attempt/unknown-usage persistence belongs to executeProviderRequestLine;",
  "do not load default credentials or bypass those owners.",
  `paid_readiness=${TEXT_MCP_CONSUMER_PAID_READINESS.status}`
].join(" ");

export const TEXT_MCP_RESPONSE_STATES = [
  "received", "public_error", "transport_error", "invalid_response", "unknown"
] as const;
export type TextMcpResponseState = (typeof TEXT_MCP_RESPONSE_STATES)[number];
export const TEXT_MCP_UNRESOLVED_RESPONSE_STATES = [
  "transport_error", "unknown", "invalid_response"
] as const;
export type TextMcpUnresolvedResponseState = (typeof TEXT_MCP_UNRESOLVED_RESPONSE_STATES)[number];

export function isUnresolvedTextMcpDelivery(state: unknown): state is TextMcpUnresolvedResponseState {
  return (TEXT_MCP_UNRESOLVED_RESPONSE_STATES as readonly string[]).includes(String(state));
}

const Digest = z.string().regex(/^[a-f0-9]{64}$/u);
export const TextMcpCeilingsSchema = z.object({
  max_model_turns: z.number().int().min(1).max(16),
  max_tool_calls: z.number().int().min(0).max(32),
  max_input_bytes: z.number().int().min(1).max(2_000_000),
  max_output_bytes: z.number().int().min(1).max(1_000_000),
  /** Admission and model-wait budget. Does not preempt in-process complete(), startup, or MCP. */
  wall_ms: z.number().int().min(1).max(300_000)
}).strict();
/** Ordinary query authority, including an optional admitted frozen interpretation proposal. */
export const TextMcpConsumerQuerySchema = OrdinaryRecallEntryQuerySchema;
export const TextMcpCallerCapabilityProfileSchema = z.enum(["plain_query", "caller_coordinates"]);
export type TextMcpCallerCapabilityProfile = z.infer<typeof TextMcpCallerCapabilityProfileSchema>;
export const TextMcpRecallDispatchDefaultsSchema = z.object({
  result_kind_view: z.literal("source_only").optional(),
  source_observed_at: z.string().min(1).optional()
}).strict();
export type TextMcpRecallDispatchDefaults = z.infer<typeof TextMcpRecallDispatchDefaultsSchema>;
export const TextMcpConsumerInputSchema = z.object({
  config: z.unknown(), root: z.string().min(1), query: TextMcpConsumerQuerySchema,
  host_issued_initial_recall: z.boolean(), model_kind: z.enum(["scripted", "remote"]),
  ceilings: TextMcpCeilingsSchema,
  caller_capability_profile: TextMcpCallerCapabilityProfileSchema.optional(),
  question_date: z.string().min(1).optional(),
  recall_dispatch_defaults: TextMcpRecallDispatchDefaultsSchema.optional()
}).strict();
export type TextMcpConsumerInput = z.infer<typeof TextMcpConsumerInputSchema>;
export type TextMcpCeilings = z.infer<typeof TextMcpCeilingsSchema>;

export const TextMcpConsumerTerminalSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("answered"), text: z.string() }).strict(),
  z.object({ outcome: z.literal("invalid_action"), reason: z.string().min(1) }).strict(),
  z.object({
    outcome: z.literal("host_policy_refusal"), tool: z.string().min(1), reason: z.string().min(1)
  }).strict(),
  z.object({ outcome: z.literal("input_ceiling") }).strict(),
  z.object({ outcome: z.literal("output_ceiling") }).strict(),
  z.object({ outcome: z.literal("model_turn_ceiling") }).strict(),
  z.object({ outcome: z.literal("tool_call_ceiling") }).strict(),
  z.object({
    outcome: z.literal("time_ceiling"),
    model_work: z.enum(["idle", "settled", "settled_late", "acked", "unsettled_unknown"])
  }).strict(),
  z.object({ outcome: z.literal("model_incomplete"), finishReason: z.string().min(1) }).strict(),
  z.object({ outcome: z.literal("model_unknown"), finishReason: z.string().nullable() }).strict(),
  z.object({
    outcome: z.literal("unresolved_delivery"),
    response_state: z.enum(["transport_error", "unknown", "invalid_response"])
  }).strict(),
  z.object({ outcome: z.literal("model_failure"), reason: z.string().min(1) }).strict(),
  z.object({ outcome: z.literal("not_run"), reason: z.string().min(1) }).strict()
]);
export type TextMcpConsumerTerminal = z.infer<typeof TextMcpConsumerTerminalSchema>;

export const TextMcpLiveSurfaceSchema = z.object({
  instructions_status: z.enum(["present", "absent"]),
  instructions: z.string().nullable(),
  version: z.unknown(),
  capabilities: z.unknown(),
  tools: z.array(z.unknown())
}).strict();
export type TextMcpLiveSurface = z.infer<typeof TextMcpLiveSurfaceSchema>;

export const TextMcpConsumerExecutionSchema = z.object({
  contract: z.literal(TEXT_MCP_CONSUMER_CONTRACT),
  consumer_kind: z.literal("text_mediated_mcp"),
  model_kind: z.literal("scripted"),
  claims: z.object({
    native_provider_tool_calling: z.literal(false),
    cli_host_equivalence: z.literal(false),
    answer_quality: z.literal("not_verified")
  }).strict(),
  paid_readiness: z.object({
    status: z.literal("blocked_without_separate_grant"),
    request_binding_owner: z.string().min(1),
    attempt_owner: z.string().min(1),
    static_grant_note: z.string().min(1),
    wall_ms_meaning: z.literal(TEXT_MCP_WALL_MS_MEANING),
    in_process_complete: z.literal("cannot_preempt")
  }).strict(),
  diagnostic_restriction: z.literal(TEXT_MCP_CONSUMER_DIAGNOSTIC_RESTRICTION),
  live_surface: TextMcpLiveSurfaceSchema.nullable(),
  consumer_model_calls: z.number().int().nonnegative(),
  mcp_dispatches: z.number().int().nonnegative(),
  host_setup: z.boolean(),
  model_work: z.object({
    status: z.enum(TEXT_MCP_MODEL_WORK_STATUSES),
    wall_ms_meaning: z.literal(TEXT_MCP_WALL_MS_MEANING)
  }).strict(),
  events: z.array(z.record(z.string(), z.unknown())),
  terminal: TextMcpConsumerTerminalSchema,
  original_snapshot_sha256: Digest,
  caller_capability_profile: TextMcpCallerCapabilityProfileSchema.optional()
}).strict();
export type TextMcpConsumerExecution = z.infer<typeof TextMcpConsumerExecutionSchema>;

export type TextMcpDecodedAction =
  | { readonly kind: "read"; readonly tool: TextMcpAllowedReadTool; readonly arguments: Record<string, unknown> }
  | { readonly kind: "answer"; readonly text: string }
  | { readonly kind: "invalid_action"; readonly reason: string }
  | { readonly kind: "host_policy_refusal"; readonly tool: string; readonly reason: string };

export type TextMcpEncodedRequest = Readonly<{ systemPrompt: string; userPrompt: string }>;
export type TextMcpModelRequest = Readonly<{
  systemPrompt: string;
  userPrompt: string;
  gatewayBody: Readonly<Record<string, unknown>>;
  /** Turn abort. Cooperative ports may ack; uncooperative work is reported unsettled_unknown. */
  abortSignal?: AbortSignal;
}>;
export type TextMcpModelResult = Readonly<{ text: string; finishReason: string | null }>;
export type TextMcpScriptedPort = Readonly<{
  complete(request: TextMcpModelRequest): TextMcpModelResult | Promise<TextMcpModelResult>;
}>;
export type TextMcpDispatch = Readonly<{
  tool: string;
  arguments: Record<string, unknown>;
  response_state: TextMcpResponseState;
  envelope: unknown;
}>;

export function isAllowedTextMcpReadTool(name: string): name is TextMcpAllowedReadTool {
  return (TEXT_MCP_ALLOWED_READ_TOOLS as readonly string[]).includes(name);
}
