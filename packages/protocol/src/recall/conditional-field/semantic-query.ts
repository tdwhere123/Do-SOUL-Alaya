import { z } from "zod";
import { BoundedIdSchema, BoundedLabelSchema } from "../../shared/schema-primitives.js";
import { Sha256DigestSchema } from "./common.js";
import { canonicalJson } from "../selection/capture/canonical-json.js";
import {
  SOURCE_SEMANTIC_MAX_BYTES, SOURCE_SEMANTIC_GAP_KINDS, SourceSemanticHandleSchema,
  SourceSemanticReadingSchema
} from "../../garden/source-semantic-draft.js";

export const SOURCE_SEMANTIC_QUERY_CONTRACT = "source-semantic-query-v2" as const;
export const SOURCE_SEMANTIC_CONTEXT_OBLIGATION_KINDS = [
  "asserted_at_source", "entailed_at_source", "explicit_embedded_structure", "unresolved"
] as const;

const Handle = SourceSemanticHandleSchema;
const QueryTextSupportSchema = z.object({ kind: z.literal("query_text"),
  excerpt: z.string().min(1).max(1024) }).strict().readonly();

/** Query evidence belongs to the original question, never to an H mention catalog. */
export const SourceSemanticQueryGapSchema = z.object({
  kind: z.enum(SOURCE_SEMANTIC_GAP_KINDS),
  affected_ids: z.array(Handle).max(64).readonly(),
  support: z.array(QueryTextSupportSchema).min(1).max(8).readonly(),
  description: z.string().min(1).max(1024).optional()
}).strict().readonly();

export const SourceSemanticQueryVariableSchema = z.object({
  id: Handle,
  sort: z.enum(["entity", "proposition", "context"]),
  reference: QueryTextSupportSchema.optional()
}).strict().readonly();

export const SourceSemanticQueryRoleRequirementSchema = z.object({
  id: Handle,
  role_reading: SourceSemanticReadingSchema,
  target_variable: Handle,
  support: QueryTextSupportSchema
}).strict().readonly();

export const SourceSemanticQueryFrameSchema = z.object({
  id: Handle,
  variable: Handle,
  predicate_reading: SourceSemanticReadingSchema,
  operator: z.enum(["not", "possible", "reported", "conditional", "opaque", "forall"]).optional(),
  role_requirements: z.array(SourceSemanticQueryRoleRequirementSchema).max(8).readonly(),
  source_act: z.enum(["question", "directive"]).optional()
}).strict().readonly();

export const SourceSemanticQueryIncidenceSchema = z.object({
  kind: z.enum(["embedding", "operator_operand"]),
  other_frame: Handle,
  role: z.enum(["content", "antecedent", "consequent", "reporter", "restriction"]).optional()
}).strict().readonly();

export const SourceSemanticContextObligationSchema = z.object({
  frame: Handle,
  kind: z.enum(SOURCE_SEMANTIC_CONTEXT_OBLIGATION_KINDS),
  incidence: SourceSemanticQueryIncidenceSchema.optional()
}).strict().readonly();

export const SourceSemanticQueryAlternativeSchema = z.object({
  frames: z.array(SourceSemanticQueryFrameSchema).max(256).readonly(),
  context_obligations: z.array(SourceSemanticContextObligationSchema).max(256).readonly(),
  purpose: z.enum(["support", "counterexample"]).optional()
}).strict().readonly();

export const SourceSemanticQueryEvaluationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("forall"), domain: Handle, binder: Handle,
    local_variables: z.array(Handle).max(256).readonly() }).strict().readonly(),
  z.object({ kind: z.literal("comparison"), domain: Handle,
    operation: z.enum(["lt", "le", "eq", "ge", "gt", "minimum", "maximum"]),
    left: Handle, right: Handle.optional(), strict: z.boolean(),
    metric: SourceSemanticReadingSchema, unit: SourceSemanticReadingSchema, context: SourceSemanticReadingSchema,
    scope: z.enum(["asserted", "preserve"])
  }).strict().readonly()
]);

const SourceSemanticQueryObjectSchema = z.object({
  contract: z.literal(SOURCE_SEMANTIC_QUERY_CONTRACT),
  original_query_digest: Sha256DigestSchema,
  producer_id: BoundedIdSchema,
  producer_version: BoundedLabelSchema,
  contract_version: BoundedLabelSchema,
  variables: z.array(SourceSemanticQueryVariableSchema).min(1).max(256).readonly(),
  alternatives: z.array(SourceSemanticQueryAlternativeSchema).min(1).max(16).readonly(),
  return_variables: z.array(Handle).max(64).readonly(),
  gaps: z.array(SourceSemanticQueryGapSchema).max(256).readonly(),
  domains: z.array(z.object({ id: Handle,
    support: QueryTextSupportSchema
  }).strict().readonly()).max(64).readonly().optional(),
  evaluation: SourceSemanticQueryEvaluationSchema.optional()
}).strict();

/** Producer body omits host envelope identities; the receiver materializes those from the request. */
export const SourceSemanticQueryProducerBodySchema = SourceSemanticQueryObjectSchema.omit({
  contract: true,
  original_query_digest: true,
  producer_id: true,
  producer_version: true,
  contract_version: true
}).strict().readonly();

export const SourceSemanticQuerySchema = SourceSemanticQueryObjectSchema.superRefine((query, context) => {
  const problem = (message: string) => context.addIssue({ code: "custom", message });
  if (new TextEncoder().encode(JSON.stringify(query)).length > SOURCE_SEMANTIC_MAX_BYTES) {
    problem("source semantic query exceeds its byte bound");
  }
  const variables = new Set(query.variables.map((row) => row.id));
  if (variables.size !== query.variables.length) problem("duplicate handles rejected");
  if (query.return_variables.some((id) => !variables.has(id))) problem("unknown cross-reference");
  if (new Set(query.return_variables).size !== query.return_variables.length) problem("duplicate handles rejected");
  const sorts = new Map(query.variables.map((row) => [row.id, row.sort]));
  const domains = new Set(query.domains?.map((row) => row.id) ?? []);
  const gapTargets = new Set([...variables, ...domains, ...query.alternatives.flatMap((row) => row.frames.map((frame) => frame.id))]);
  if (query.gaps.some((gap) => gap.affected_ids.some((id) => !gapTargets.has(id)))) problem("unknown query gap target");
  if (domains.size !== (query.domains?.length ?? 0)) problem("duplicate query domains");
  if (query.evaluation !== undefined && !domains.has(query.evaluation.domain)) problem("evaluation requires a declared query domain");
  const evaluation = query.evaluation;
  if (evaluation?.kind === "forall") {
    if (sorts.get(evaluation.binder) !== "entity") problem("universal query requires an entity binder");
    if (new Set(evaluation.local_variables).size !== evaluation.local_variables.length
      || evaluation.local_variables.some((id) => !variables.has(id))
      || !evaluation.local_variables.includes(evaluation.binder)) problem("invalid universal local variables");
    if (query.return_variables.some((id) => evaluation.local_variables.includes(id))) problem("universal query cannot return a bound witness");
  }
  if (evaluation?.kind === "comparison") {
    if (sorts.get(evaluation.left) !== "entity" || (evaluation.right !== undefined && sorts.get(evaluation.right) !== "entity")) problem("comparison requires entity operands");
    const extreme = evaluation.operation === "minimum" || evaluation.operation === "maximum";
    if (!extreme && evaluation.right === undefined) problem("pairwise comparison requires both operands");
    if (!extreme && evaluation.strict !== ["lt", "gt"].includes(evaluation.operation)) problem("pairwise strictness must agree with its comparator");
    if (extreme && evaluation.right !== undefined) problem("extremum uses its declared population");
    if (query.return_variables.some((id) => id !== evaluation.left && id !== evaluation.right)) problem("comparison cannot return an unbound variable");
  }
  for (const variable of query.variables) {
    if (variable.reference !== undefined && variable.sort !== "entity") problem("query reference requires an entity variable");
  }
  for (const alternative of query.alternatives) {
    if (evaluation?.kind === "comparison" && (alternative.frames.length !== 0 || alternative.context_obligations.length !== 0)) {
      problem("comparison uses typed operand scope; additional frame constraints are not supported");
    }
    if (alternative.frames.length === 0 && evaluation?.kind !== "comparison") problem("query body requires a frame");
    if (alternative.purpose === "counterexample") {
      if (evaluation?.kind !== "forall") problem("counterexample alternative requires a universal query");
      if (!isStructuralCounterexample(query.alternatives, alternative)) problem("counterexample must explicitly negate the same single-frame universal body");
    }
    refineAlternative(alternative, variables, problem);
    const used = new Set(alternative.frames.flatMap((row) => [row.variable, ...row.role_requirements.map((role) => role.target_variable)]));
    if (evaluation?.kind === "forall" && !used.has(evaluation.binder)) problem("universal binder must occur in its body");
    if (evaluation?.kind !== "comparison" && query.return_variables.some((id) => !used.has(id))) problem("return variable is unbound in an alternative");
    for (const frame of alternative.frames) {
      if (sorts.get(frame.variable) !== (frame.operator === undefined ? "proposition" : "context")) problem("frame variable has wrong sort");
      if (frame.operator !== undefined && frame.role_requirements.some((role) =>
        frame.operator !== "reported" || role.id !== "reporter" || sorts.get(role.target_variable) !== "entity")) {
        problem("operator roles require typed reporter participation");
      }
    }
  }
}).readonly();

function isStructuralCounterexample(alternatives: readonly z.infer<typeof SourceSemanticQueryAlternativeSchema>[],
  counterexample: z.infer<typeof SourceSemanticQueryAlternativeSchema>): boolean {
  const positives = alternatives.filter((row) => row.purpose !== "counterexample");
  if (positives.length !== 1 || positives[0]!.frames.length !== 1 || counterexample.frames.length !== 2) return false;
  const positive = positives[0]!, body = positive.frames[0]!;
  if (body.operator !== undefined || body.source_act !== undefined || positive.context_obligations.length !== 1
    || !["asserted_at_source", "entailed_at_source"].includes(positive.context_obligations[0]!.kind)) return false;
  const negative = counterexample.frames.find((row) => row.operator === "not");
  const content = counterexample.frames.find((row) => row !== negative);
  if (negative === undefined || content === undefined || negative.role_requirements.length !== 0
    || negative.source_act !== undefined || content.operator !== undefined || content.source_act !== undefined) return false;
  const meaning = (frame: typeof body) => canonicalJson({ predicate: frame.predicate_reading, variable: frame.variable,
    roles: frame.role_requirements.map((row) => [row.role_reading, row.target_variable]).sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b))) });
  if (meaning(body) !== meaning(content) || counterexample.context_obligations.length !== 2) return false;
  return counterexample.context_obligations.some((row) => row.frame === negative.id && row.kind === "asserted_at_source"
    && row.incidence === undefined) && counterexample.context_obligations.some((row) => row.frame === content.id
    && row.kind === "explicit_embedded_structure" && row.incidence?.kind === "operator_operand"
    && row.incidence.other_frame === negative.id && (row.incidence.role ?? "content") === "content");
}

function refineAlternative(
  alternative: z.infer<typeof SourceSemanticQueryAlternativeSchema>,
  variables: ReadonlySet<string>,
  problem: (message: string) => void
): void {
  const frames = alternative.frames.map((row) => row.id);
  if (new Set(frames).size !== frames.length) problem("duplicate handles rejected");
  const frameSet = new Set(frames);
  for (const frame of alternative.frames) {
    if (!variables.has(frame.variable)) problem("unknown cross-reference");
    const roleIds = frame.role_requirements.map((row) => row.id);
    if (new Set(roleIds).size !== roleIds.length) problem("duplicate handles rejected");
    for (const role of frame.role_requirements) {
      if (!variables.has(role.target_variable)) problem("unknown cross-reference");
    }
  }
  for (const obligation of alternative.context_obligations) {
    if (!frameSet.has(obligation.frame)) problem("unknown cross-reference");
    if (obligation.incidence !== undefined && !frameSet.has(obligation.incidence.other_frame)) {
      problem("unknown cross-reference");
    }
  }
  const byId = new Map(alternative.frames.map((row) => [row.id, row]));
  for (const obligation of alternative.context_obligations) {
    const edge = obligation.incidence;
    if (edge === undefined) continue;
    if (edge.other_frame === obligation.frame) problem("query incidence cannot govern itself");
    const parent = byId.get(edge.other_frame);
    if (parent === undefined) continue;
    const role = edge.role ?? "content";
    if (edge.kind === "embedding" && (parent.operator !== undefined || role !== "content")) problem("embedding requires an ordinary content owner");
    if (edge.kind === "operator_operand" && (parent.operator === undefined || role === "reporter" ||
      (parent.operator === "conditional" ? role !== "antecedent" && role !== "consequent"
        : parent.operator === "forall" ? role !== "content" && role !== "restriction" : role !== "content"))) {
      problem("operator incidence requires its declared operand type");
    }
  }
  if (!queryAlternativeConnected(alternative)) problem("disconnected query is invalid");
}

export function queryAlternativeConnected(
  alternative: z.infer<typeof SourceSemanticQueryAlternativeSchema>
): boolean {
  const ids = alternative.frames.map((row) => row.id);
  if (ids.length <= 1) return true;
  const parent = new Map(ids.map((id) => [id, id]));
  const find = (id: string): string => {
    const current = parent.get(id)!;
    if (current === id) return id;
    const root = find(current);
    parent.set(id, root);
    return root;
  };
  const unite = (left: string, right: string) => {
    if (!parent.has(left) || !parent.has(right)) return;
    const a = find(left), b = find(right);
    if (a !== b) parent.set(a, b);
  };
  const byVariable = new Map<string, string[]>();
  for (const frame of alternative.frames) {
    const recorded = (variable: string) => {
      const list = byVariable.get(variable) ?? [];
      list.push(frame.id);
      byVariable.set(variable, list);
    };
    recorded(frame.variable);
    for (const role of frame.role_requirements) recorded(role.target_variable);
  }
  for (const handles of byVariable.values()) {
    for (let index = 1; index < handles.length; index += 1) unite(handles[0]!, handles[index]!);
  }
  for (const obligation of alternative.context_obligations) {
    if (obligation.incidence !== undefined) unite(obligation.frame, obligation.incidence.other_frame);
  }
  return new Set(ids.map(find)).size === 1;
}

export type SourceSemanticQueryVariable = z.infer<typeof SourceSemanticQueryVariableSchema>;
export type SourceSemanticQueryRoleRequirement = z.infer<typeof SourceSemanticQueryRoleRequirementSchema>;
export type SourceSemanticQueryFrame = z.infer<typeof SourceSemanticQueryFrameSchema>;
export type SourceSemanticQueryIncidence = z.infer<typeof SourceSemanticQueryIncidenceSchema>;
export type SourceSemanticContextObligation = z.infer<typeof SourceSemanticContextObligationSchema>;
export type SourceSemanticQueryAlternative = z.infer<typeof SourceSemanticQueryAlternativeSchema>;
export type SourceSemanticQueryProducerBody = z.infer<typeof SourceSemanticQueryProducerBodySchema>;
export type SourceSemanticQuery = z.infer<typeof SourceSemanticQuerySchema>;
