import { z } from "zod";
import { SourceAssertionIdSchema } from "../evidence/source-selection.js";
import { SourceReferenceSchema } from "../evidence/source-reference.js";

export const SOURCE_SEMANTIC_PACKET_CONTRACT = "source-interpretation-v3" as const;
export const SOURCE_SEMANTIC_MAX_DEPTH = 16;
export const SOURCE_SEMANTIC_MAX_BYTES = 262144;
export const SOURCE_SEMANTIC_SOURCE_ACTS = ["assertion", "question", "directive", "unresolved"] as const;
export const SOURCE_SEMANTIC_GAP_KINDS = [
  "omitted_predicate_support", "unresolved_referent", "missing_binding", "opaque_structure",
  "uninterpreted_clause", "source_disjunction", "unsupported_meaning", "universal_quantification",
  "aggregate", "comparison", "counterfactual", "disconnected_query"
] as const;

export const SourceSemanticHandleSchema = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/u);
export const SourceSemanticReadingSchema = z.string().min(1).max(256);
const Handle = SourceSemanticHandleSchema;
const Handles = (max: number, min = 0) => z.array(Handle).min(min).max(max).readonly();

export const SourceSemanticSupportSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("lexical"), mentions: Handles(8, 1) }).strict().readonly(),
  z.object({ kind: z.literal("additional"), mentions: Handles(8), reading: SourceSemanticReadingSchema.optional() }).strict().readonly(),
  z.object({ kind: z.literal("dominating"), via_id: Handle }).strict().readonly()
]);

export const SourceSemanticPredicateSupportSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("explicit"), reading: SourceSemanticReadingSchema, mentions: Handles(8, 1) }).strict().readonly(),
  z.object({ kind: z.literal("implicit"), reading: SourceSemanticReadingSchema, supporting_context: Handles(8, 1) }).strict().readonly()
]);

export const SourceSemanticArgumentTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("node"), id: Handle }).strict().readonly(),
  z.object({ kind: z.literal("unresolved") }).strict().readonly()
]);

export const SourceSemanticSlotDefinitionSchema = z.object({
  id: Handle, role_reading: SourceSemanticReadingSchema,
  support: z.array(SourceSemanticSupportSchema).max(8).readonly()
}).strict().readonly();

export const SourceSemanticSlotBindingSchema = z.object({
  slot_id: Handle, target: SourceSemanticArgumentTargetSchema,
  support: z.array(SourceSemanticSupportSchema).max(8).readonly()
}).strict().readonly();

export const SourceSemanticContextOwnerSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("source_act"), source_act: z.enum(SOURCE_SEMANTIC_SOURCE_ACTS) }).strict().readonly(),
  z.object({ kind: z.literal("embedding"), parent_frame: Handle, content_argument: Handle }).strict().readonly(),
  z.object({ kind: z.literal("operator"), operator_handle: Handle }).strict().readonly()
]);

const OccurrenceBase = {
  id: Handle,
  assertion_ids: z.array(SourceAssertionIdSchema).min(1).max(64).readonly(),
  context_owner: SourceSemanticContextOwnerSchema,
  additional_support: z.array(SourceSemanticSupportSchema).max(8).readonly()
};

export const SourceSemanticFrameSchema = z.object({
  ...OccurrenceBase,
  predicate_support: SourceSemanticPredicateSupportSchema,
  slots: z.array(SourceSemanticSlotDefinitionSchema).max(8).readonly(),
  bindings: z.array(SourceSemanticSlotBindingSchema).max(8).readonly()
}).strict().readonly();

export const SourceSemanticOperatorSchema = z.discriminatedUnion("operator", [
  z.object({ ...OccurrenceBase, operator: z.literal("not"), content: Handle }).strict().readonly(),
  z.object({ ...OccurrenceBase, operator: z.literal("possible"), content: Handle }).strict().readonly(),
  z.object({ ...OccurrenceBase, operator: z.literal("opaque"),
    operands: Handles(8, 1) }).strict().readonly(),
  z.object({ ...OccurrenceBase, operator: z.literal("reported"), content: Handle,
    reporter: Handle.optional() }).strict().readonly(),
  z.object({ ...OccurrenceBase, operator: z.literal("conditional"), antecedent: Handle,
    consequent: Handle }).strict().readonly()
]);

export const SourceSemanticMentionSchema = z.object({
  id: Handle, assertion_id: SourceAssertionIdSchema, source_ref: SourceReferenceSchema
}).strict().readonly();

export const SourceSemanticReferentSchema = z.object({
  id: Handle,
  referent_kind: z.enum(["grouped", "unresolved", "unexpressed", "ambiguous"]),
  mentions: Handles(64)
}).strict().readonly();

export const SourceSemanticGapSchema = z.object({
  kind: z.enum(SOURCE_SEMANTIC_GAP_KINDS),
  affected_ids: Handles(64),
  support: z.array(SourceSemanticSupportSchema).max(8).readonly(),
  description: z.string().min(1).max(1024).optional()
}).strict().readonly();

export const SourceSemanticGraphFields = {
  mentions: z.array(SourceSemanticMentionSchema).max(512).readonly(),
  referents: z.array(SourceSemanticReferentSchema).max(256).readonly(),
  frames: z.array(SourceSemanticFrameSchema).max(256).readonly(),
  operators: z.array(SourceSemanticOperatorSchema).max(256).readonly(),
  gaps: z.array(SourceSemanticGapSchema).max(256).readonly()
};

export type SourceSemanticSupport = z.infer<typeof SourceSemanticSupportSchema>;
export type SourceSemanticPredicateSupport = z.infer<typeof SourceSemanticPredicateSupportSchema>;
export type SourceSemanticArgumentTarget = z.infer<typeof SourceSemanticArgumentTargetSchema>;
export type SourceSemanticSlotDefinition = z.infer<typeof SourceSemanticSlotDefinitionSchema>;
export type SourceSemanticSlotBinding = z.infer<typeof SourceSemanticSlotBindingSchema>;
export type SourceSemanticContextOwner = z.infer<typeof SourceSemanticContextOwnerSchema>;
export type SourceSemanticFrame = z.infer<typeof SourceSemanticFrameSchema>;
export type SourceSemanticOperator = z.infer<typeof SourceSemanticOperatorSchema>;
export type SourceSemanticMention = z.infer<typeof SourceSemanticMentionSchema>;
export type SourceSemanticReferent = z.infer<typeof SourceSemanticReferentSchema>;
export type SourceSemanticGap = z.infer<typeof SourceSemanticGapSchema>;

export type SourceSemanticGraph = Readonly<{
  readonly mentions: readonly SourceSemanticMention[];
  readonly referents: readonly SourceSemanticReferent[];
  readonly frames: readonly SourceSemanticFrame[];
  readonly operators: readonly SourceSemanticOperator[];
  readonly gaps: readonly SourceSemanticGap[];
}>;

type IssueContext = { addIssue: (issue: { code: "custom"; message: string }) => void };

export function refineSourceSemanticGraph(graph: SourceSemanticGraph, context: IssueContext): void {
  const problem = (message: string) => context.addIssue({ code: "custom", message });
  const encoded = new TextEncoder().encode(JSON.stringify(graph));
  if (encoded.length > SOURCE_SEMANTIC_MAX_BYTES) problem("source semantic graph exceeds its byte bound");
  const mentionIds = graph.mentions.map((row) => row.id);
  const referentIds = graph.referents.map((row) => row.id);
  const frameIds = graph.frames.map((row) => row.id);
  const operatorIds = graph.operators.map((row) => row.id);
  const occurrenceIds = [...frameIds, ...operatorIds];
  const nodeIds = [...mentionIds, ...referentIds, ...occurrenceIds];
  if (new Set(nodeIds).size !== nodeIds.length) problem("duplicate handles rejected");
  if (graph.frames.length + graph.operators.length === 0) problem("graph requires at least one occurrence");
  const mentions = new Set(mentionIds);
  const referents = new Set(referentIds);
  const frames = new Set(frameIds);
  const operators = new Set(operatorIds);
  const occurrences = new Set(occurrenceIds);
  const nodes = new Set([...referents, ...occurrences]);
  const mentionExists = (id: string) => mentions.has(id);
  const supportMentions = (support: readonly SourceSemanticSupport[]) => {
    for (const item of support) {
      if (item.kind === "lexical" || item.kind === "additional") {
        if (item.mentions.some((id) => !mentionExists(id))) problem("unknown cross-reference");
      } else if (!occurrences.has(item.via_id) && !referents.has(item.via_id)) problem("unknown cross-reference");
    }
  };
  for (const gap of graph.gaps) {
    if (gap.affected_ids.some((id) => !nodeIds.includes(id))) problem("unknown cross-reference");
    supportMentions(gap.support);
  }
  for (const referent of graph.referents) {
    if (referent.referent_kind === "grouped" && referent.mentions.length === 0) {
      problem("grouped referent requires mentions");
    }
    if (referent.mentions.some((id) => !mentionExists(id))) problem("unknown cross-reference");
  }
  for (const frame of graph.frames) {
    const slotIds = frame.slots.map((slot) => slot.id);
    if (new Set(slotIds).size !== slotIds.length) problem("duplicate handles rejected");
    const slots = new Set(slotIds);
    if (new Set(frame.bindings.map((row) => row.slot_id)).size !== frame.bindings.length) {
      problem("duplicate handles rejected");
    }
    for (const slot of frame.slots) supportMentions(slot.support);
    for (const binding of frame.bindings) {
      if (!slots.has(binding.slot_id)) problem("unknown cross-reference");
      supportMentions(binding.support);
      if (binding.target.kind === "node" && !nodes.has(binding.target.id)) problem("unknown cross-reference");
    }
    const pred = frame.predicate_support;
    if (pred.kind === "explicit" && pred.mentions.some((id) => !mentionExists(id))) problem("unknown cross-reference");
    if (pred.kind === "implicit" && pred.supporting_context.some((id) => !mentionExists(id))) problem("unknown cross-reference");
    supportMentions(frame.additional_support);
    refineContextOwner(frame.id, frame.context_owner, { frames, operators, occurrences }, problem);
  }
  for (const operator of graph.operators) {
    supportMentions(operator.additional_support);
    refineContextOwner(operator.id, operator.context_owner, { frames, operators, occurrences }, problem);
    refineOperatorOperands(operator, { referents, occurrences }, problem);
  }
  refineDomination(graph, problem);
}

function refineContextOwner(
  ownerId: string,
  owner: SourceSemanticContextOwner,
  ids: Readonly<{ frames: Set<string>; operators: Set<string>; occurrences: Set<string> }>,
  problem: (message: string) => void
): void {
  if (owner.kind === "embedding") {
    if (!ids.frames.has(owner.parent_frame) || !ids.occurrences.has(owner.content_argument)) {
      problem("unknown cross-reference");
    }
    if (owner.content_argument !== ownerId) problem("embedding content_argument must name this occurrence");
    if (owner.parent_frame === ownerId) problem("invalid operator / operand types / wrong target types");
  } else if (owner.kind === "operator") {
    if (!ids.operators.has(owner.operator_handle)) problem("unknown cross-reference");
    if (owner.operator_handle === ownerId) problem("invalid operator / operand types / wrong target types");
  }
}

function refineOperatorOperands(
  operator: SourceSemanticOperator,
  ids: Readonly<{ referents: Set<string>; occurrences: Set<string> }>,
  problem: (message: string) => void
): void {
  const occurrence = (id: string) => {
    if (!ids.occurrences.has(id)) problem("invalid operator / operand types / wrong target types");
  };
  if (operator.operator === "not" || operator.operator === "possible" || operator.operator === "reported") {
    occurrence(operator.content);
    if (operator.operator === "reported" && operator.reporter !== undefined && !ids.referents.has(operator.reporter)) {
      problem("invalid operator / operand types / wrong target types");
    }
  } else if (operator.operator === "conditional") {
    occurrence(operator.antecedent);
    occurrence(operator.consequent);
  } else {
    if (operator.operands.some((id) => !ids.occurrences.has(id))) {
      problem("invalid operator / operand types / wrong target types");
    }
  }
}

function dominationChildren(graph: SourceSemanticGraph, id: string): readonly string[] {
  const operator = graph.operators.find((row) => row.id === id);
  if (operator !== undefined) {
    if (operator.operator === "conditional") return [operator.antecedent, operator.consequent];
    if (operator.operator === "opaque") return operator.operands;
    return [operator.content];
  }
  return graph.frames.flatMap((frame) =>
    frame.context_owner.kind === "embedding" && frame.context_owner.parent_frame === id
      ? [frame.id] : []).concat(graph.operators.flatMap((row) =>
    row.context_owner.kind === "embedding" && row.context_owner.parent_frame === id
      ? [row.id] : []));
}

function refineDomination(graph: SourceSemanticGraph, problem: (message: string) => void): void {
  const visiting = new Set<string>();
  const depth = new Map<string, number>();
  const walk = (id: string): number => {
    if (visiting.has(id)) {
      problem("domination cycle");
      return 0;
    }
    const known = depth.get(id);
    if (known !== undefined) return known;
    visiting.add(id);
    let longest = 0;
    for (const child of dominationChildren(graph, id)) {
      longest = Math.max(longest, 1 + walk(child));
    }
    visiting.delete(id);
    depth.set(id, longest);
    return longest;
  };
  let longest = 0;
  for (const node of [...graph.frames, ...graph.operators]) longest = Math.max(longest, walk(node.id));
  if (longest > SOURCE_SEMANTIC_MAX_DEPTH) problem("excess depth");
}

export const SourceSemanticDraftSchema = z.object({
  contract: z.literal(SOURCE_SEMANTIC_PACKET_CONTRACT),
  ...SourceSemanticGraphFields
}).strict().superRefine((draft, context) => refineSourceSemanticGraph(draft, context)).readonly();

export type SourceSemanticDraft = z.infer<typeof SourceSemanticDraftSchema>;
