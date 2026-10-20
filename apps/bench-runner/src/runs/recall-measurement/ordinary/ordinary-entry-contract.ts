import { z } from "zod";
import {
  ScopeClassSchema, SoulMemorySearchRequestSchema, SoulMemorySearchResponseSchema, SOURCE_SEMANTIC_LIBRARY_PAGE_BUDGET,
  SourceDeliveredSpanSchema, RecallTargetRefSchema, type AuthorizedScopesAdmission, type ScopeClass
} from "@do-soul/alaya-protocol";
import { FirstExposurePageSchema } from "../../measurement/first-exposure-session.js";
import { OrdinaryRecallEnvelopeSchema } from "./ordinary-recall-contract.js";

/** Live public `soul.recall` execution evidence, not an offline capture-operator archive. */
export const ORDINARY_RECALL_ENTRY_CONTRACT = "ordinary-recall-public-entry-v1" as const;
/** Public membership width for @5 / two-page @10. Not `SemanticChainConfig.budget.page_budget`. */
export const ORDINARY_RECALL_PUBLIC_PAGE_SLOTS = SOURCE_SEMANTIC_LIBRARY_PAGE_BUDGET;
export const ORDINARY_RECALL_PUBLIC_PAGE_LIMIT = 2 as const;

/**
 * Library RequestBudget / output_byte_limit / access_policy are not soul.recall fields.
 * Public MCP keeps its encoder and runtime defaults (including envelope caps) instead of
 * injecting library numbers to force equality.
 */
export const ORDINARY_RECALL_UNMAPPED_DIMENSIONS = Object.freeze([
  "budget.work_units", "budget.memory_bytes", "budget.page_budget", "budget.finalization_reserve",
  "budget.min_envelope", "output_byte_limit", "access_policy", "correspondence_demand",
  "correspondence_cap", "correspondence_pair_cap", "correspondence_generation", "discovery_page_cap",
  "source_index", "source_preview_extents", "max_output_tokens"
] as const);

const Digest = z.string().regex(/^[a-f0-9]{64}$/u);
export const OrdinaryRecallEntryQuerySchema = z.object({
  query_key: Digest, original_query: z.string().min(1)
}).strict();
export const OrdinaryRecallEntryInputSchema = z.object({
  config: z.unknown(), root: z.string().min(1),
  queries: z.array(OrdinaryRecallEntryQuerySchema).min(1)
}).strict();

export const OrdinaryRecallSourceIntervalSchema = z.object({
  slot_index: z.number().int().nonnegative(),
  target: RecallTargetRefSchema,
  span: SourceDeliveredSpanSchema.nullable()
}).strict();
export const OrdinaryRecallEntryPageSchema = z.object({
  ordinal: z.number().int().min(1).max(ORDINARY_RECALL_PUBLIC_PAGE_LIMIT),
  phase: z.literal("membership"),
  request: SoulMemorySearchRequestSchema,
  public_call: z.object({
    request: z.object({ name: z.literal("soul.recall"), arguments: z.record(z.string(), z.unknown()) }).strict(),
    response: z.unknown()
  }).strict().nullable(),
  envelope: OrdinaryRecallEnvelopeSchema.nullable(),
  output: SoulMemorySearchResponseSchema.nullable(),
  first_exposure: FirstExposurePageSchema.nullable(),
  response_state: z.enum(["success", "public_error", "transport_error", "unknown"]),
  observation: z.enum(["observed", "unobserved"]),
  /** Admitted delivery slots on this page, including non-body results. Not source_intervals.length. */
  occupied_slots: z.number().int().nonnegative(),
  source_intervals: z.array(OrdinaryRecallSourceIntervalSchema)
}).strict();
const SnapshotIdentitySchema = z.object({
  query_id: z.string().min(1), snapshot_id: z.string().min(1), result_version: z.string().min(1),
  interpretation_id: z.string().min(1), as_of: z.string().min(1)
}).strict();
const Unobserved = z.enum([
  "work_units", "memory_bytes", "finalization_reserve", "min_envelope", "provider_calls"
]);
export const OrdinaryRecallQueryRowSchema = z.object({
  query_key: Digest, original_query: z.string().min(1),
  status: z.enum(["not_run", "unavailable", "failed", "partial", "complete"]),
  reason: z.string().min(1).optional(),
  snapshot_identity: SnapshotIdentitySchema.nullable(),
  pages: z.array(OrdinaryRecallEntryPageSchema).max(ORDINARY_RECALL_PUBLIC_PAGE_LIMIT),
  first_exposure: FirstExposurePageSchema.nullable(),
  source_intervals: z.array(OrdinaryRecallSourceIntervalSchema),
  unobserved_counters: z.array(Unobserved).readonly()
}).strict();
export const OrdinaryRecallMappingSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("mapped"), scope_class: ScopeClassSchema.nullable(),
    max_results: z.literal(ORDINARY_RECALL_PUBLIC_PAGE_SLOTS),
    unmapped_dimensions: z.array(z.string()).readonly()
  }).strict(),
  z.object({
    status: z.literal("not_run"), reason: z.string().min(1),
    unmapped_dimensions: z.array(z.string()).readonly()
  }).strict()
]);
export const OrdinaryRecallExecutionSchema = z.object({
  contract: z.literal(ORDINARY_RECALL_ENTRY_CONTRACT),
  input_identity: Digest, config_identity: Digest,
  mapping: OrdinaryRecallMappingSchema,
  consumer_model_calls: z.literal(0),
  rows: z.array(OrdinaryRecallQueryRowSchema)
}).strict();
export type OrdinaryRecallEntryInput = z.infer<typeof OrdinaryRecallEntryInputSchema>;
export type OrdinaryRecallExecution = z.infer<typeof OrdinaryRecallExecutionSchema>;
export type OrdinaryRecallQueryRow = z.infer<typeof OrdinaryRecallQueryRowSchema>;
export type OrdinaryRecallMapping = z.infer<typeof OrdinaryRecallMappingSchema>;

export type OrdinaryScopeMapping =
  | { readonly status: "mapped"; readonly scope_class: ScopeClass | null }
  | { readonly status: "not_run"; readonly reason: string };

/**
 * MCP `soul.recall` has `scope_class` (nullable filter), not `authorized_scopes`.
 * Chat maps a single class onto the runner principal array and `null` onto unrestricted.
 * Denied, omitted-principal, and multi-scope named sets have no equivalent; do not broaden.
 */
export function mapOrdinaryRecallScope(admission: AuthorizedScopesAdmission): OrdinaryScopeMapping {
  if (admission.mode === "unrestricted") return { status: "mapped", scope_class: null };
  if (admission.mode === "denied") {
    return { status: "not_run", reason: "ordinary soul.recall cannot express denied authorized_scopes; null scope_class is unrestricted, not denied" };
  }
  if (admission.scopes.length !== 1) {
    return { status: "not_run", reason: "ordinary soul.recall scope_class cannot express multiple authorized scopes without silently narrowing or broadening" };
  }
  const scope = ScopeClassSchema.safeParse(admission.scopes[0]);
  if (!scope.success) {
    return { status: "not_run", reason: "ordinary soul.recall scope_class cannot express the authorized scope name" };
  }
  return { status: "mapped", scope_class: scope.data };
}

/** Parsed public `soul.recall` request. Wire input may omit continuation claim-demand defaults. */
export type OrdinaryRecallPublicRequest = z.output<typeof SoulMemorySearchRequestSchema>;
export function buildOrdinaryRecallRequest(input: Readonly<{
  query: string; scope_class: ScopeClass | null; source_observed_at: string;
}>): OrdinaryRecallPublicRequest {
  return SoulMemorySearchRequestSchema.parse({
    query: input.query, scope_class: input.scope_class, dimension: null, domain_tags: null,
    max_results: ORDINARY_RECALL_PUBLIC_PAGE_SLOTS, source_observed_at: input.source_observed_at,
    enumeration_policy: "canonical", result_kind_view: "source_only", protocol_version: 1,
    supports_source_evidence: true
  });
}

export const UNOBSERVED_ORDINARY_COUNTERS = Object.freeze([
  "work_units", "memory_bytes", "finalization_reserve", "min_envelope", "provider_calls"
] as const);
