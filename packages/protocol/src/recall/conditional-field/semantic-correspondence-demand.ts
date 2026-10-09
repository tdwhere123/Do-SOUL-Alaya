import { z } from "zod";
import { AlayaError } from "../../shared/alaya-error.js";
import { canonicalJson } from "../selection/capture/canonical-json.js";
import { SourceSemanticHandleSchema } from "../../garden/source-semantic-draft.js";
import { SOURCE_SEMANTIC_LIBRARY_EXAMINATION_CAP } from "../../garden/source-semantic-worker.js";
import { sourceSemanticQueryBranchViews } from "./semantic-query-branches.js";
import {
  SourceSemanticQueryTargetSchema, type SourceSemanticQuery, type SourceSemanticQueryTarget
} from "./semantic-query.js";
import {
  SOURCE_SEMANTIC_QUERY_ENDPOINT_HANDLE, SourceSemanticCorrespondenceAssessmentSchema,
  assertSourceSemanticCorrespondenceAssessmentRequirement,
  type SourceSemanticCorrespondenceAssessment, type SourceSemanticCorrespondenceEndpointCatalog,
  type SourceSemanticQueryCatalogEntry
} from "./semantic-correspondence-assessment.js";

export const SOURCE_SEMANTIC_CORRESPONDENCE_GENERATION_POLICY_CONTRACT =
  "source-semantic-correspondence-generation-policy-v1" as const;
export const SOURCE_SEMANTIC_CORRESPONDENCE_DEMAND_SELECTION_MAX = SOURCE_SEMANTIC_LIBRARY_EXAMINATION_CAP;

const QueryHandle = z.string().regex(SOURCE_SEMANTIC_QUERY_ENDPOINT_HANDLE);

export const SourceSemanticCorrespondenceGenerationPolicySchema = z.discriminatedUnion("kind", [
  z.object({
    contract: z.literal(SOURCE_SEMANTIC_CORRESPONDENCE_GENERATION_POLICY_CONTRACT),
    kind: z.literal("full_catalog")
  }).strict().readonly(),
  z.object({
    contract: z.literal(SOURCE_SEMANTIC_CORRESPONDENCE_GENERATION_POLICY_CONTRACT),
    kind: z.literal("branch_demand"),
    alternative: z.number().int().nonnegative(),
    target: SourceSemanticQueryTargetSchema
  }).strict().readonly()
]);

export const SOURCE_SEMANTIC_CORRESPONDENCE_FULL_CATALOG_POLICY = SourceSemanticCorrespondenceGenerationPolicySchema.parse({
  contract: SOURCE_SEMANTIC_CORRESPONDENCE_GENERATION_POLICY_CONTRACT,
  kind: "full_catalog"
});

export const SourceSemanticCorrespondenceDemandSelectionSchema = z.object({
  kind: z.literal("query_branches"),
  maximum_demands_per_interpretation: z.number().int().positive().max(SOURCE_SEMANTIC_CORRESPONDENCE_DEMAND_SELECTION_MAX)
}).strict().readonly();

export const SourceSemanticCorrespondencePreparationOptionsSchema = z.object({
  correspondence_demand: SourceSemanticCorrespondenceDemandSelectionSchema.optional(),
  correspondence_cap: z.number().int().nonnegative().max(SOURCE_SEMANTIC_LIBRARY_EXAMINATION_CAP).optional()
}).strict().superRefine((value, context) => {
  if ((value.correspondence_demand === undefined) !== (value.correspondence_cap === undefined)) {
    context.addIssue({
      code: "custom",
      message: "correspondence_demand and correspondence_cap must appear together"
    });
  }
}).readonly();

export const SourceSemanticCorrespondenceDemandSchema = z.object({
  generation_policy: SourceSemanticCorrespondenceGenerationPolicySchema,
  demanded_handles: z.array(QueryHandle).max(256).readonly(),
  query_refs: z.object({
    alternative: z.number().int().nonnegative().optional(),
    target: SourceSemanticQueryTargetSchema.optional(),
    frames: z.array(SourceSemanticHandleSchema).max(256).readonly(),
    variables: z.array(SourceSemanticHandleSchema).max(256).readonly(),
    slots: z.array(SourceSemanticHandleSchema).max(256).readonly()
  }).strict().readonly()
}).strict().readonly();

export const SourceSemanticCorrespondenceCoverageSchema = z.object({
  generation_policy: SourceSemanticCorrespondenceGenerationPolicySchema,
  demanded: z.array(QueryHandle).max(256).readonly(),
  assessed: z.array(QueryHandle).max(256).readonly(),
  unassessed: z.array(QueryHandle).max(256).readonly(),
  supported: z.array(QueryHandle).max(256).readonly(),
  unresolved: z.array(QueryHandle).max(256).readonly()
}).strict().readonly();

export type SourceSemanticCorrespondenceGenerationPolicy =
  z.infer<typeof SourceSemanticCorrespondenceGenerationPolicySchema>;
export type SourceSemanticCorrespondenceDemandSelection =
  z.infer<typeof SourceSemanticCorrespondenceDemandSelectionSchema>;
export type SourceSemanticCorrespondencePreparationOptions =
  z.infer<typeof SourceSemanticCorrespondencePreparationOptionsSchema>;
export type SourceSemanticCorrespondenceDemand = z.infer<typeof SourceSemanticCorrespondenceDemandSchema>;
export type SourceSemanticCorrespondenceCoverage = z.infer<typeof SourceSemanticCorrespondenceCoverageSchema>;

/** Nonempty native branch policies in original view order, or the full-catalog default. */
export function sourceSemanticCorrespondenceGenerationPolicies(
  query: SourceSemanticQuery,
  selection?: SourceSemanticCorrespondenceDemandSelection
): SourceSemanticCorrespondenceGenerationPolicy[] {
  if (selection === undefined) return [SOURCE_SEMANTIC_CORRESPONDENCE_FULL_CATALOG_POLICY];
  const selected = SourceSemanticCorrespondenceDemandSelectionSchema.parse(selection);
  const policies: SourceSemanticCorrespondenceGenerationPolicy[] = [];
  for (const [alternative, row] of query.alternatives.entries()) {
    for (const view of sourceSemanticQueryBranchViews(row)) {
      if (view.alternative.frames.length === 0) continue;
      policies.push({
        contract: SOURCE_SEMANTIC_CORRESPONDENCE_GENERATION_POLICY_CONTRACT,
        kind: "branch_demand",
        alternative,
        target: view.target
      });
      if (policies.length >= selected.maximum_demands_per_interpretation) {
        return SourceSemanticCorrespondenceGenerationPolicySchema.array().parse(policies);
      }
    }
  }
  return SourceSemanticCorrespondenceGenerationPolicySchema.array().parse(policies);
}

/** Derives demanded catalog query handles from original Q coordinates. Does not accept an arbitrary handle list. */
export function sourceSemanticCorrespondenceDemand(
  query: SourceSemanticQuery,
  catalog: SourceSemanticCorrespondenceEndpointCatalog,
  policy: SourceSemanticCorrespondenceGenerationPolicy
): SourceSemanticCorrespondenceDemand {
  const generation_policy = SourceSemanticCorrespondenceGenerationPolicySchema.parse(policy);
  if (generation_policy.kind === "full_catalog") {
    return SourceSemanticCorrespondenceDemandSchema.parse({
      generation_policy,
      demanded_handles: catalog.query_endpoints.map((row) => row.handle),
      query_refs: fullCatalogRefs(query)
    });
  }
  const alternative = query.alternatives[generation_policy.alternative];
  if (alternative === undefined) {
    throw new AlayaError("VALIDATION", "semantic_correspondence branch demand alternative is not in the query");
  }
  const view = sourceSemanticQueryBranchViews(alternative)
    .find((row) => canonicalJson(row.target) === canonicalJson(generation_policy.target));
  if (view === undefined) {
    throw new AlayaError("VALIDATION", "semantic_correspondence branch demand target is not in the query");
  }
  const frames = view.alternative.frames.map((row) => row.id);
  const frameSet = new Set(frames);
  const variables = namedVariablesUsedByBranch(query, view.alternative.frames);
  const slots: string[] = [];
  const seenSlots = new Set<string>();
  for (const frame of view.alternative.frames) {
    for (const role of frame.role_requirements) {
      if (seenSlots.has(role.id)) continue;
      seenSlots.add(role.id);
      slots.push(role.id);
    }
  }
  const variableSet = new Set(variables);
  const demanded_handles = catalog.query_endpoints
    .filter((endpoint) => endpointInDemand(endpoint, generation_policy.alternative, frameSet, variableSet))
    .map((row) => row.handle);
  if (demanded_handles.length === 0) {
    throw new AlayaError("VALIDATION", "semantic_correspondence branch demand has no query endpoints");
  }
  return SourceSemanticCorrespondenceDemandSchema.parse({
    generation_policy,
    demanded_handles,
    query_refs: {
      alternative: generation_policy.alternative,
      target: generation_policy.target,
      frames,
      variables,
      slots
    }
  });
}

export function sourceSemanticCorrespondenceCoverage(
  catalog: SourceSemanticCorrespondenceEndpointCatalog,
  demand: SourceSemanticCorrespondenceDemand,
  assessment: SourceSemanticCorrespondenceAssessment
): SourceSemanticCorrespondenceCoverage {
  const parsedDemand = SourceSemanticCorrespondenceDemandSchema.parse(demand);
  const parsedAssessment = SourceSemanticCorrespondenceAssessmentSchema.parse(assessment);
  assertSourceSemanticCorrespondenceAssessmentRequirement(catalog, parsedAssessment.assessments, parsedDemand);
  const demanded = [...parsedDemand.demanded_handles];
  const demandedSet = new Set(demanded);
  const assessed = parsedAssessment.assessments.map((row) => row.query);
  return SourceSemanticCorrespondenceCoverageSchema.parse({
    generation_policy: parsedDemand.generation_policy,
    demanded,
    assessed,
    unassessed: catalog.query_endpoints.map((row) => row.handle).filter((handle) => !demandedSet.has(handle)),
    supported: parsedAssessment.assessments.filter((row) => row.status === "supported").map((row) => row.query),
    unresolved: parsedAssessment.assessments.filter((row) => row.status === "unresolved").map((row) => row.query)
  });
}

/** Q + H + policy. Catalog is determined by Q/H; full_catalog keeps the existing two-part key. */
export function sourceSemanticCorrespondenceCacheMaterial(input: Readonly<{
  query_semantics_id: string;
  source_interpretation_id: string;
  generation_policy: SourceSemanticCorrespondenceGenerationPolicy;
}>): string {
  const policy = SourceSemanticCorrespondenceGenerationPolicySchema.parse(input.generation_policy);
  if (policy.kind === "full_catalog") {
    return `${input.query_semantics_id}:${input.source_interpretation_id}`;
  }
  return `${input.query_semantics_id}:${input.source_interpretation_id}:${canonicalJson(policy)}`;
}

/** Same used-variable set as query alternative binding: frame variable plus role targets. */
function namedVariablesUsedByBranch(
  query: SourceSemanticQuery,
  frames: SourceSemanticQuery["alternatives"][number]["frames"]
): string[] {
  const used = new Set(frames.flatMap((row) => [
    row.variable,
    ...row.role_requirements.map((role) => role.target_variable)
  ]));
  return query.variables
    .filter((row) => row.sort === "entity" && row.reference !== undefined && used.has(row.id))
    .map((row) => row.id);
}

function fullCatalogRefs(query: SourceSemanticQuery) {
  const frames = query.alternatives.flatMap((row) => row.frames.map((frame) => frame.id));
  const variables = query.variables
    .filter((row) => row.sort === "entity" && row.reference !== undefined)
    .map((row) => row.id);
  const slots: string[] = [];
  const seen = new Set<string>();
  for (const alternative of query.alternatives) {
    for (const frame of alternative.frames) {
      for (const role of frame.role_requirements) {
        if (seen.has(role.id)) continue;
        seen.add(role.id);
        slots.push(role.id);
      }
    }
  }
  return { frames, variables, slots };
}

function endpointInDemand(
  endpoint: SourceSemanticQueryCatalogEntry,
  alternative: number,
  frames: ReadonlySet<string>,
  variables: ReadonlySet<string>
): boolean {
  if (endpoint.kind === "referent") return endpoint.variable !== undefined && variables.has(endpoint.variable);
  return endpoint.alternative === alternative && endpoint.frame !== undefined && frames.has(endpoint.frame);
}

export type { SourceSemanticQueryTarget };
