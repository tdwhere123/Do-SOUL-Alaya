import { z } from "zod";
import { canonicalJsonChunks } from "../recall/selection/capture/canonical-json.js";
import type { SourceSemanticResourceLedger } from "./source-semantic-resources.js";
import { BoundedIdSchema, NonNegativeIntSchema as N } from "../shared/schema-primitives.js";
import { Sha256DigestSchema } from "../recall/conditional-field/common.js";
import { SourceIndexTargetSchema } from "../recall/source-index.js";
import { QuestionTimeCaptureDomainSchema } from "../recall/conditional-field/question-time.js";
import { sourceGoldRootIdentity } from "../recall/conditional-field/product-identity.js";
import { SourceSemanticAcquisitionSchema, SourceSemanticQueryPreparationSchema,
  SourceSemanticQueryWindowSchema } from "./source-semantic-phase-semantics.js";

export const SOURCE_SEMANTIC_PROFILED_ACCESS_CONTRACT = "source-semantic-access-v3" as const;
export const SOURCE_SEMANTIC_PROFILED_LIBRARY_RESULT_VERSION = "source-semantic-library-v7" as const;
export const SOURCE_SEMANTIC_PROFILED_LIBRARY_PROTOCOL_VERSION = 9 as const;
export const SourceSemanticEffectiveOrderSchema = z.enum([
  "query-conditioned-v1", "canonical-v1", "native-route-round-robin-v1"
]);
export const SourceSemanticAcquisitionPolicySchema = z.enum([
  "source-index-interleaved-prefix.v1", "source-index-grouped-round-robin.v1"
]);
export const SourceSemanticAcquisitionChannelsSchema = z.enum(["lexical", "vector", "dual"]);
// Candidate receipt safety bounds, not production allowance selection or preparation windowing limits.
const AttemptCount = N.max(128), InspectedWindowCount = N.max(4096);
export const SourceSemanticAcquisitionAllowanceSchema = z.object({
  max_attempts: AttemptCount, max_roots: AttemptCount, max_vector_windows: InspectedWindowCount
}).strict().readonly().refine(value => value.max_roots <= value.max_attempts,
  "root allowance exceeds the shared attempt ceiling");

/** An explicit resolved profile, not a public request policy or a bound-call lifecycle control. */
export const SourceSemanticAccessProfileSchema = z.object({
  contract: z.literal(SOURCE_SEMANTIC_PROFILED_ACCESS_CONTRACT),
  result_version: z.literal(SOURCE_SEMANTIC_PROFILED_LIBRARY_RESULT_VERSION),
  protocol_version: z.literal(SOURCE_SEMANTIC_PROFILED_LIBRARY_PROTOCOL_VERSION),
  order_policy: SourceSemanticEffectiveOrderSchema,
  acquisition_policy: SourceSemanticAcquisitionPolicySchema,
  channels: SourceSemanticAcquisitionChannelsSchema,
  declared_allowance: SourceSemanticAcquisitionAllowanceSchema
}).strict().readonly();
export type SourceSemanticAccessProfile = z.infer<typeof SourceSemanticAccessProfileSchema>;
export function sourceSemanticAcquisitionMatchesProfile(profile: SourceSemanticAccessProfile,
  acquisition: Pick<SourceSemanticProfiledAcquisitionPhase, "policy" | "channels" | "declared_allowance">): boolean {
  return acquisition.policy === profile.acquisition_policy && acquisition.channels === profile.channels &&
    (["max_attempts", "max_roots", "max_vector_windows"] as const)
      .every(key => acquisition.declared_allowance[key] === profile.declared_allowance[key]);
}

const View = z.enum(["original", "hint"]);
const Rank = z.number().int().min(1);
const Unavailable = z.object({ status: z.literal("unavailable"), reason: z.string().min(1).max(1024) }).strict().readonly();
const Hit = z.union([Unavailable, z.object({ status: z.literal("available"), start_byte: N, end_byte: N })
  .strict().readonly().refine(value => value.end_byte > value.start_byte, "empty native hit")]);
const Window = z.union([Unavailable, z.object({ status: z.literal("available"), window: SourceSemanticQueryWindowSchema })
  .strict().readonly().refine(value => value.window.end_byte > value.window.start_byte, "empty native window")]);
export const SourceSemanticNominationOccurrenceSchema = z.object({
  reference: BoundedIdSchema, attempt: AttemptCount.min(1), source: SourceIndexTargetSchema,
  view: View,
  /** Absent means the unrestricted native capture; ranks are local to this domain. */
  domain: QuestionTimeCaptureDomainSchema.optional(),
  route: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("lexical"), native_rank: Rank, lane: z.enum(["unicode61", "trigram"]),
      lane_rank: Rank, bm25: z.number().finite(), hit: Hit.optional() }).strict().readonly(),
    z.object({ kind: z.literal("vector"), native_rank: Rank, cosine: z.number().finite(), window: Window.optional() }).strict().readonly()
  ])
}).strict().readonly().superRefine((value, ctx) => {
  if (!Sha256DigestSchema.safeParse(value.source.target.root_id).success ||
      value.source.root_key !== sourceGoldRootIdentity(value.source.target)) {
    ctx.addIssue({ code: "custom", message: "occurrence requires the actual native source-record root identity" });
  }
  const route = value.route;
  const end = route.kind === "lexical" ? route.hit?.status === "available" ? route.hit.end_byte : undefined
    : route.window?.status === "available" ? route.window.window.end_byte : undefined;
  if (end !== undefined && end > value.source.body_bytes) ctx.addIssue({ code: "custom", message: "native position exceeds source extent" });
});

export type SourceSemanticNominationOccurrence = z.infer<typeof SourceSemanticNominationOccurrenceSchema>;
/** Full producer-owned retention, never reconstructed from the displayed prefix. */
export const SourceSemanticRetainedNominationWitnessSchema = z.array(SourceSemanticNominationOccurrenceSchema).max(128).readonly();
export type SourceSemanticRetainedNominationWitness = z.infer<typeof SourceSemanticRetainedNominationWitnessSchema>;

/** The full witness and its lossy receipt projection share this one consistency authority. */
export function sourceSemanticRetainedWitnessMatchesPhase(witness: SourceSemanticRetainedNominationWitness,
  phase: SourceSemanticProfiledAcquisitionPhase, meter?: Pick<SourceSemanticResourceLedger, "charge">): boolean {
  const result = phase.result;
  if (result === null) return witness.length === 0;
  if (witness.length !== result.counts.retained_occurrences || witness.length > 128) return false;
  meter?.charge(1, 128 + witness.length * 48, "source retained witness consistency references");
  const references = new Set<string>(), roots = new Set<string>();
  let previous = 0;
  for (const row of witness) {
    meter?.charge(3, 0, "source retained witness consistency");
    if (references.has(row.reference) || row.attempt <= previous || row.attempt > result.counts.attempts) return false;
    references.add(row.reference); roots.add(row.source.root_key); previous = row.attempt;
  }
  if (roots.size !== result.counts.distinct_roots) return false;
  // Use the same canonical codec, not another renderer or a side digest.
  for (const [index, prefix] of result.occurrence_prefix.entries()) {
    const left = canonicalJsonChunks(prefix, meter), right = canonicalJsonChunks(witness[index], meter);
    for (;;) {
      const a = left.next(), b = right.next();
      if (a.done || b.done) { if (a.done !== b.done) return false; break; }
      if (a.value !== b.value) return false;
    }
  }
  return true;
}

const LaneProgress = z.object({
  view: View, route: z.enum(["lexical", "vector"]),
  availability: z.discriminatedUnion("status", [
    z.object({ status: z.enum(["absent", "disabled", "measured_empty"]) }).strict().readonly(),
    Unavailable,
    z.object({ status: z.literal("captured"), captured_occurrences: InspectedWindowCount.min(1) }).strict().readonly()
  ]),
  consumed_occurrences: AttemptCount, remaining_captured_occurrences: InspectedWindowCount, last_native_rank: Rank.nullable()
}).strict().readonly().superRefine((lane, ctx) => {
  const captured = lane.availability.status === "captured" ? lane.availability.captured_occurrences : 0;
  if (lane.consumed_occurrences + lane.remaining_captured_occurrences !== captured ||
      (lane.consumed_occurrences === 0) !== (lane.last_native_rank === null)) {
    ctx.addIssue({ code: "custom", message: "lane progress contradicts its bounded captured page" });
  }
});
const Counts = z.object({
  attempts: AttemptCount, retained_occurrences: AttemptCount, distinct_roots: AttemptCount, duplicate_occurrences: AttemptCount,
  denied: AttemptCount, unknown: AttemptCount, nomination_limit: AttemptCount,
  resource_refused_before_start: N.max(1), resource_refused_after_start: N.max(1)
}).strict().readonly();
const Evidence = SourceSemanticAcquisitionSchema.unwrap().shape;
/** Prefix evidence is deliberately insufficient to reconstruct full retained membership or sign a pool digest. */
export const SourceSemanticProfiledAcquisitionResultSchema = z.object({
  navigation_digest: Evidence.navigation_digest, completion: Evidence.completion,
  occurrence_prefix: z.array(SourceSemanticNominationOccurrenceSchema).max(16).readonly(),
  prefix_coverage: z.object({ kind: z.literal("retained_occurrence_prefix"), omitted_occurrences: AttemptCount }).strict().readonly(),
  counts: Counts,
  lanes: z.array(LaneProgress).length(4).readonly(),
  resources: Evidence.resources, resource_refusals: Evidence.resource_refusals.unwrap().max(129).readonly(),
  lexical: Evidence.lexical,
  vector: Evidence.vector.unwrap().extend({ inspected_windows: InspectedWindowCount, invalid_windows: InspectedWindowCount }).readonly(),
  limitations: Evidence.limitations
}).strict().readonly().superRefine((result, ctx) => {
  const fail = (message: string) => ctx.addIssue({ code: "custom", message });
  const c = result.counts, prefix = result.occurrence_prefix;
  if (prefix.length !== Math.min(16, c.retained_occurrences) ||
      result.prefix_coverage.omitted_occurrences !== c.retained_occurrences - prefix.length ||
      c.retained_occurrences !== c.distinct_roots + c.duplicate_occurrences ||
      c.attempts !== c.retained_occurrences + c.denied + c.unknown + c.nomination_limit + c.resource_refused_after_start) {
    fail("attempt, occurrence, root and prefix counts disagree");
  }
  const roots = new Set(prefix.map(row => row.source.root_key));
  if (roots.size > c.distinct_roots || result.prefix_coverage.omitted_occurrences === 0 && roots.size !== c.distinct_roots) {
    fail("prefix roots contradict retained distinct-root count");
  }
  const references = new Set<string>();
  let previous = 0;
  for (const row of prefix) {
    if (references.has(row.reference) || row.attempt <= previous || row.attempt > c.attempts) fail("invalid retained occurrence prefix order");
    references.add(row.reference); previous = row.attempt;
  }
  const lanes = new Set(result.lanes.map(lane => `${lane.view}:${lane.route}`));
  if (lanes.size !== 4 || result.lanes.reduce((sum, lane) => sum + lane.consumed_occurrences, 0) !== c.attempts) {
    fail("lane advancement must account for every started attempt");
  }
  const progress = new Map<string, { count: number; rank: number }>();
  for (const row of prefix) {
    const lane = result.lanes.find(lane => lane.view === row.view && lane.route === row.route.kind);
    const key = `${row.view}:${row.route.kind}`, prior = progress.get(key) ?? { count: 0, rank: 0 };
    if (lane === undefined || lane.availability.status !== "captured" || lane.last_native_rank === null ||
        row.route.native_rank > lane.last_native_rank || row.route.native_rank <= prior.rank ||
        prior.count + 1 > lane.consumed_occurrences) fail("occurrence lacks captured lane progress");
    progress.set(key, { count: prior.count + 1, rank: row.route.native_rank });
  }
  if (result.vector.invalid_windows > result.vector.inspected_windows) fail("invalid windows exceed inspected windows");
  // Native discovery can retain several phase refusals; an unknown-cost throw is
  // failure evidence, not a fabricated resource-refused nomination opportunity.
  const knownRefusal = result.resource_refusals.some(row => row.phase !== "acquisition_failed_unknown_additional_cost");
  if (c.resource_refused_before_start + c.resource_refused_after_start > 1 ||
      knownRefusal !== (c.resource_refused_before_start + c.resource_refused_after_start > 0)) {
    fail("refusal evidence and counts disagree");
  }
});

const Phase = z.object({
  policy: SourceSemanticAcquisitionPolicySchema, channels: SourceSemanticAcquisitionChannelsSchema,
  declared_allowance: SourceSemanticAcquisitionAllowanceSchema,
  status: z.enum(["executed", "not_run", "failed"]), reason: z.string().nullable(),
  allowance: SourceSemanticAcquisitionAllowanceSchema,
  budget: z.object({ work_units: N, memory_bytes: N }).strict().readonly(),
  result: SourceSemanticProfiledAcquisitionResultSchema.nullable(), accounting: z.enum(["complete", "partial", "not_run"])
}).strict();
export type SourceSemanticProfiledAcquisitionPhase = Readonly<z.infer<typeof Phase>>;
/** Shared by semantic and compact admission; the tuple adapter passes only already checked leaves. */
export function refineSourceSemanticProfiledAcquisition(value: SourceSemanticProfiledAcquisitionPhase, ctx: z.RefinementCtx): void {
  const fail = (message: string) => ctx.addIssue({ code: "custom", message });
  for (const key of ["max_attempts", "max_roots", "max_vector_windows"] as const) {
    if (value.allowance[key] > value.declared_allowance[key] ||
        value.status === "executed" && value.allowance[key] !== value.declared_allowance[key]) {
      fail("explicit declared allowance cannot be silently downgraded during execution");
    }
  }
  if (value.status === "not_run" ? value.result !== null || value.accounting !== "not_run" || value.reason === null
    : value.status === "executed" && value.result === null || value.result !== null && value.accounting === "not_run") {
    fail("phase state contradicts execution evidence");
  }
  if (value.result === null) return;
  const result = value.result;
  if (result.counts.attempts > value.allowance.max_attempts || result.counts.distinct_roots > value.allowance.max_roots ||
      result.vector.inspected_windows > value.allowance.max_vector_windows) fail("acquisition exceeds funded allowance");
  for (const lane of result.lanes) {
    if (value.channels !== "dual" && lane.route !== value.channels && lane.availability.status !== "disabled") {
      fail("disabled acquisition channel cannot claim lane availability");
    }
  }
}
export const SourceSemanticProfiledAcquisitionPhaseSchema = Phase.superRefine(refineSourceSemanticProfiledAcquisition).readonly();
export function sourceSemanticProfiledAcquisitionNotRun(profile: SourceSemanticAccessProfile, reason: string): SourceSemanticProfiledAcquisitionPhase {
  return { policy: profile.acquisition_policy, channels: profile.channels, declared_allowance: profile.declared_allowance,
    status: "not_run", reason, allowance: { max_attempts: 0, max_roots: 0, max_vector_windows: 0 },
    budget: { work_units: 0, memory_bytes: 0 }, result: null, accounting: "not_run" };
}
export const SourceSemanticProfiledExecutionPhasesSchema = z.object({
  contract: z.literal("source-semantic-execution-v4"), query_preparation: SourceSemanticQueryPreparationSchema,
  acquisition: SourceSemanticProfiledAcquisitionPhaseSchema, semantic_generation_attempts: z.literal(0)
}).strict().readonly();
export type SourceSemanticProfiledExecutionPhases = z.infer<typeof SourceSemanticProfiledExecutionPhasesSchema>;
