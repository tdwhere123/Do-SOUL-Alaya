import { z } from "zod";
import { BoundedIdSchema, BoundedLabelSchema } from "../../shared/schema-primitives.js";
import { Sha256DigestSchema } from "./common.js";
import {
  SOURCE_SEMANTIC_MAX_BYTES, SourceSemanticGapSchema, SourceSemanticHandleSchema,
  SourceSemanticReadingSchema
} from "../../garden/source-semantic-draft.js";

export const SOURCE_SEMANTIC_QUERY_CONTRACT = "source-semantic-query-v1" as const;
export const SOURCE_SEMANTIC_CONTEXT_OBLIGATION_KINDS = [
  "asserted_at_source", "explicit_embedded_structure", "unresolved"
] as const;

const Handle = SourceSemanticHandleSchema;

export const SourceSemanticQueryVariableSchema = z.object({
  id: Handle,
  sort: z.enum(["entity", "proposition", "context"]),
  reference: z.object({ kind: z.literal("query_text"), excerpt: z.string().min(1).max(1024) }).strict().readonly().optional()
}).strict().readonly();

export const SourceSemanticQueryRoleRequirementSchema = z.object({
  id: Handle,
  role_reading: SourceSemanticReadingSchema,
  target_variable: Handle,
  support: z.object({ kind: z.literal("query_text"), excerpt: z.string().min(1).max(1024) }).strict().readonly()
}).strict().readonly();

export const SourceSemanticQueryFrameSchema = z.object({
  id: Handle,
  variable: Handle,
  predicate_reading: SourceSemanticReadingSchema,
  operator: z.enum(["not", "possible", "reported", "conditional", "opaque"]).optional(),
  role_requirements: z.array(SourceSemanticQueryRoleRequirementSchema).max(8).readonly(),
  source_act: z.enum(["question", "directive"]).optional()
}).strict().readonly();

export const SourceSemanticQueryIncidenceSchema = z.object({
  kind: z.enum(["embedding", "operator_operand"]),
  other_frame: Handle,
  role: z.enum(["content", "antecedent", "consequent", "reporter"]).optional()
}).strict().readonly();

export const SourceSemanticContextObligationSchema = z.object({
  frame: Handle,
  kind: z.enum(SOURCE_SEMANTIC_CONTEXT_OBLIGATION_KINDS),
  incidence: SourceSemanticQueryIncidenceSchema.optional()
}).strict().readonly();

export const SourceSemanticQueryAlternativeSchema = z.object({
  frames: z.array(SourceSemanticQueryFrameSchema).min(1).max(256).readonly(),
  context_obligations: z.array(SourceSemanticContextObligationSchema).max(256).readonly()
}).strict().readonly();

export const SourceSemanticQuerySchema = z.object({
  contract: z.literal(SOURCE_SEMANTIC_QUERY_CONTRACT),
  original_query_digest: Sha256DigestSchema,
  producer_id: BoundedIdSchema,
  producer_version: BoundedLabelSchema,
  contract_version: BoundedLabelSchema,
  variables: z.array(SourceSemanticQueryVariableSchema).min(1).max(256).readonly(),
  alternatives: z.array(SourceSemanticQueryAlternativeSchema).min(1).max(16).readonly(),
  return_variables: z.array(Handle).max(64).readonly(),
  gaps: z.array(SourceSemanticGapSchema).max(256).readonly()
}).strict().superRefine((query, context) => {
  const problem = (message: string) => context.addIssue({ code: "custom", message });
  if (new TextEncoder().encode(JSON.stringify(query)).length > SOURCE_SEMANTIC_MAX_BYTES) {
    problem("source semantic query exceeds its byte bound");
  }
  const variables = new Set(query.variables.map((row) => row.id));
  if (variables.size !== query.variables.length) problem("duplicate handles rejected");
  if (query.return_variables.some((id) => !variables.has(id))) problem("unknown cross-reference");
  if (new Set(query.return_variables).size !== query.return_variables.length) problem("duplicate handles rejected");
  const sorts = new Map(query.variables.map((row) => [row.id, row.sort]));
  for (const variable of query.variables) {
    if (variable.reference !== undefined && variable.sort !== "entity") problem("query reference requires an entity variable");
  }
  for (const alternative of query.alternatives) {
    refineAlternative(alternative, variables, problem);
    const used = new Set(alternative.frames.flatMap((row) => [row.variable, ...row.role_requirements.map((role) => role.target_variable)]));
    if (query.return_variables.some((id) => !used.has(id))) problem("return variable is unbound in an alternative");
    for (const frame of alternative.frames) {
      if (sorts.get(frame.variable) !== (frame.operator === undefined ? "proposition" : "context")) problem("frame variable has wrong sort");
      if (frame.operator !== undefined && frame.role_requirements.some((role) =>
        frame.operator !== "reported" || role.id !== "reporter" || sorts.get(role.target_variable) !== "entity")) {
        problem("operator roles require typed reporter participation");
      }
    }
  }
}).readonly();

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
      (parent.operator === "conditional" ? role !== "antecedent" && role !== "consequent" : role !== "content"))) {
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
export type SourceSemanticQuery = z.infer<typeof SourceSemanticQuerySchema>;
