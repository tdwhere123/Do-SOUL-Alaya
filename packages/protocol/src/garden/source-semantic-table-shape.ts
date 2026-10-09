import { z } from "zod";
import { AlayaError } from "../shared/alaya-error.js";
import { SOURCE_SEMANTIC_GAP_KINDS, SOURCE_SEMANTIC_SOURCE_ACTS, SourceSemanticDraftSchema,
  SourceSemanticFrameSchema, SourceSemanticReadingSchema, SourceSemanticReferentSchema } from "./source-semantic-draft.js";
import { SOURCE_SEMANTIC_SELECTION_SUPPORT_LIST_BOUND, SourceSemanticSelectionContentShape,
  SourceSemanticSelectionOutcomeShape, SourceSemanticSelectionEntitySchema,
  sourceSemanticSelectionAtomSchema } from "./source-semantic-selection-lowering.js";
import { SourceSemanticInterpretationSchema } from "./source-semantic-interpretation.js";

export const SOURCE_SEMANTIC_TABLE_PROPOSAL_CONTRACT = "source-semantic-proposal-v8" as const;
export const SOURCE_SEMANTIC_TABLE_GENERATION_CONTRACT = "host-owned-table-schema-v1" as const;
export const SOURCE_SEMANTIC_INLINE_PROPOSAL_CONTRACT = "source-semantic-proposal-v9" as const;
export const SOURCE_SEMANTIC_INLINE_GENERATION_CONTRACT = "host-owned-inline-entity-use-schema-v1" as const;
export const SourceSemanticGenerationSchemaContractSchema = z.enum([
  SOURCE_SEMANTIC_TABLE_GENERATION_CONTRACT, SOURCE_SEMANTIC_INLINE_GENERATION_CONTRACT
]);
export type SourceSemanticGenerationSchemaContract = z.infer<typeof SourceSemanticGenerationSchemaContractSchema>;
export function sourceSemanticPresentationContracts(value?: SourceSemanticGenerationSchemaContract) {
  const generation = SourceSemanticGenerationSchemaContractSchema.parse(value ?? SOURCE_SEMANTIC_TABLE_GENERATION_CONTRACT);
  return generation === SOURCE_SEMANTIC_INLINE_GENERATION_CONTRACT
    ? { proposal_contract: SOURCE_SEMANTIC_INLINE_PROPOSAL_CONTRACT, generation_schema_contract: generation } as const
    : { proposal_contract: SOURCE_SEMANTIC_TABLE_PROPOSAL_CONTRACT, generation_schema_contract: generation } as const;
}
const SelectionContent = SourceSemanticSelectionContentShape.unwrap().shape;
const NativeDomain = SelectionContent.domains.unwrap().unwrap().element.unwrap();
const NativeMeasurement = SelectionContent.measurements.unwrap().unwrap().element.unwrap();
const NativeDomainMember = NativeDomain.shape.members.unwrap().element.unwrap();
const NativeDomainExclusion = NativeDomain.shape.exclusions.unwrap().element.unwrap();
const NativeGraph = SourceSemanticDraftSchema.unwrap().shape;
const NativeInterpretation = SourceSemanticInterpretationSchema.unwrap().shape;
function maxItems(schema: z.ZodType): number {
  const value = (z.toJSONSchema(schema, { io: "output" }) as { maxItems?: number }).maxItems;
  if (value === undefined || !Number.isSafeInteger(value)) throw new AlayaError("VALIDATION", "Protocol array bound is missing");
  return value;
}
export const SOURCE_SEMANTIC_TABLE_LIMIT = {
  roots: Math.min(maxItems(SelectionContent.roots), maxItems(NativeInterpretation.entry_roots)),
  entities: maxItems(NativeGraph.referents),
  frames: maxItems(NativeGraph.frames), operators: maxItems(NativeGraph.operators),
  domains: maxItems(SelectionContent.domains.unwrap()),
  measurements: maxItems(SelectionContent.measurements.unwrap()),
  gaps: maxItems(SelectionContent.gaps.unwrap()),
  arguments: maxItems(SourceSemanticFrameSchema.unwrap().shape.slots),
  mentions: maxItems(SourceSemanticReferentSchema.unwrap().shape.mentions),
  domainMembers: maxItems(NativeDomain.shape.members),
  domainExclusions: maxItems(NativeDomain.shape.exclusions),
  gapAffected: maxItems(SelectionContent.gaps.unwrap().unwrap().element.unwrap().shape.affected.unwrap())
} as const;
const Key = NativeDomain.shape.key;
const Atom = sourceSemanticSelectionAtomSchema();
const Support = z.union([Atom, z.array(Atom).min(1).max(SOURCE_SEMANTIC_SELECTION_SUPPORT_LIST_BOUND).readonly()]);
const EntityRef = z.object({ kind: z.literal("entity_ref"), key: Key }).strict().readonly();
const ContentRef = z.object({ kind: z.literal("content_ref"), key: Key }).strict().readonly();
const OccurrenceRef = z.object({ kind: z.literal("occurrence_ref"), key: Key }).strict().readonly();
const NativeContentRef = z.object({ kind: z.literal("content_reference"), key: Key }).strict().readonly();
const Unresolved = z.object({ kind: z.literal("unresolved") }).strict().readonly();
const BoundVariable = z.object({ kind: z.literal("bound_variable"), quantifier: Key }).strict().readonly();
const Target = z.discriminatedUnion("kind", [EntityRef, ContentRef, OccurrenceRef, NativeContentRef, Unresolved, BoundVariable]);
const Operand = z.union([ContentRef, NativeContentRef]);
const Entity = z.discriminatedUnion("form", [
  z.object({ form: z.literal("selection"), key: Key, semantic_key: Key.optional(), selection: Atom }).strict().readonly(),
  z.object({ form: z.literal("entity"), key: Key, semantic_key: Key.optional(),
    referent_kind: SourceSemanticReferentSchema.unwrap().shape.referent_kind.optional(),
    mentions: z.array(Atom).min(1).max(SOURCE_SEMANTIC_TABLE_LIMIT.mentions).readonly() }).strict().readonly()
]);
const Argument = z.object({ role: SourceSemanticReadingSchema, target: Target,
  support: Support.optional() }).strict().readonly();
const Qualification = Argument.unwrap().extend({ support: Support }).strict().readonly();
const Predicate = z.object({ kind: z.enum(["explicit", "implicit"]),
  reading: SourceSemanticReadingSchema, support: Support }).strict().readonly();
const Statement = z.object({ kind: z.literal("statement"), key: Key,
  predicate: Predicate, arguments: z.array(Argument).max(SOURCE_SEMANTIC_TABLE_LIMIT.arguments).readonly(),
  qualifications: z.array(Qualification).max(SOURCE_SEMANTIC_TABLE_LIMIT.arguments).readonly() }).strict().readonly();
const OperatorBase = { key: Key, support: Support };
const Negated = z.object({ kind: z.literal("not"), ...OperatorBase, content: Operand }).strict().readonly();
const Possible = z.object({ kind: z.literal("possible"), ...OperatorBase, content: Operand }).strict().readonly();
const Reported = z.object({ kind: z.literal("reported"), ...OperatorBase, content: Operand,
    reporter: EntityRef.optional() }).strict().readonly();
const Conditional = z.object({ kind: z.literal("conditional"), ...OperatorBase, antecedent: Operand,
    consequent: Operand }).strict().readonly();
const Opaque = z.object({ kind: z.literal("opaque"), ...OperatorBase,
    operands: z.array(Operand).min(1).max(SOURCE_SEMANTIC_TABLE_LIMIT.arguments).readonly() }).strict().readonly();
const Universal = z.object({ kind: z.literal("forall"), ...OperatorBase, domain: Key,
    restriction: Operand.nullable(), content: Operand }).strict().readonly();
const Nodes = z.discriminatedUnion("kind", [Statement, Negated, Possible, Reported, Conditional, Opaque, Universal]);
const Domain = NativeDomain.extend({
  members: z.array(NativeDomainMember.extend({ referent: EntityRef }).readonly()).max(SOURCE_SEMANTIC_TABLE_LIMIT.domainMembers).readonly(),
  exclusions: z.array(NativeDomainExclusion.extend({ referent: EntityRef }).readonly()).max(SOURCE_SEMANTIC_TABLE_LIMIT.domainExclusions).readonly()
}).readonly();
const Measurement = NativeMeasurement.extend({ subject: EntityRef }).readonly();
const GapTarget = z.discriminatedUnion("kind", [EntityRef, OccurrenceRef]);
export const SourceSemanticTableProposalSchema = z.object({ contract: z.literal(SOURCE_SEMANTIC_TABLE_PROPOSAL_CONTRACT),
  outcome: SourceSemanticSelectionOutcomeShape,
  content: z.object({ nodes: z.array(Nodes).max(SOURCE_SEMANTIC_TABLE_LIMIT.frames + SOURCE_SEMANTIC_TABLE_LIMIT.operators).readonly(),
    entities: z.array(Entity).max(SOURCE_SEMANTIC_TABLE_LIMIT.entities).readonly(),
    roots: z.array(z.object({ act: z.enum(SOURCE_SEMANTIC_SOURCE_ACTS),
    expression: ContentRef }).strict().readonly()).max(SOURCE_SEMANTIC_TABLE_LIMIT.roots).readonly(),
    domains: z.array(Domain).max(SOURCE_SEMANTIC_TABLE_LIMIT.domains).readonly().optional(),
    measurements: z.array(Measurement).max(SOURCE_SEMANTIC_TABLE_LIMIT.measurements).readonly().optional(),
    gaps: z.array(z.object({ affected: z.array(GapTarget).max(SOURCE_SEMANTIC_TABLE_LIMIT.gapAffected).readonly(),
      kind: z.enum(SOURCE_SEMANTIC_GAP_KINDS), support: Support,
      description: z.string().min(1).max(1024).optional() }).strict().readonly()).max(SOURCE_SEMANTIC_TABLE_LIMIT.gaps).readonly()
  }).strict().readonly().optional()
}).strict().readonly();
type SourceSemanticTableProposal = z.infer<typeof SourceSemanticTableProposalSchema>;
export type SourceSemanticTableContent = NonNullable<SourceSemanticTableProposal["content"]>;
export type SourceSemanticTableNode = SourceSemanticTableContent["nodes"][number];
export type SourceSemanticTableTarget = z.infer<typeof Target>;
export type SourceSemanticTableOperand = z.infer<typeof Operand>;

function presentationJsonSchema(schema: z.ZodType): object {
  return z.toJSONSchema(schema, { io: "output", reused: "ref",
    override: ({ jsonSchema }) => {
      if (jsonSchema.const !== undefined) { jsonSchema.enum = [jsonSchema.const]; delete jsonSchema.const; }
    } });
}
export function sourceSemanticTableJsonSchema(): object {
  return presentationJsonSchema(SourceSemanticTableProposalSchema);
}

const InlineTarget = z.discriminatedUnion("kind", [SourceSemanticSelectionEntitySchema, ContentRef, OccurrenceRef,
  NativeContentRef, Unresolved, BoundVariable]);
const InlineArgument = Argument.unwrap().extend({ target: InlineTarget }).readonly();
const InlineQualification = Qualification.unwrap().extend({ target: InlineTarget }).readonly();
const InlineStatement = Statement.unwrap().extend({
  arguments: z.array(InlineArgument).max(SOURCE_SEMANTIC_TABLE_LIMIT.arguments).readonly(),
  qualifications: z.array(InlineQualification).max(SOURCE_SEMANTIC_TABLE_LIMIT.arguments).readonly()
}).readonly();
const InlineReported = Reported.unwrap().extend({ reporter: SourceSemanticSelectionEntitySchema.optional() }).readonly();
const InlineNodes = z.discriminatedUnion("kind", [InlineStatement, Negated, Possible, InlineReported,
  Conditional, Opaque, Universal]);
const InlineDomain = Domain.unwrap().extend({
  members: z.array(NativeDomainMember.extend({ referent: SourceSemanticSelectionEntitySchema }).readonly())
    .max(SOURCE_SEMANTIC_TABLE_LIMIT.domainMembers).readonly(),
  exclusions: z.array(NativeDomainExclusion.extend({ referent: SourceSemanticSelectionEntitySchema }).readonly())
    .max(SOURCE_SEMANTIC_TABLE_LIMIT.domainExclusions).readonly()
}).readonly();
const InlineMeasurement = Measurement.unwrap().extend({ subject: SourceSemanticSelectionEntitySchema }).readonly();
const TableContent = SourceSemanticTableProposalSchema.unwrap().shape.content.unwrap().unwrap();
export const SourceSemanticInlineProposalSchema = SourceSemanticTableProposalSchema.unwrap().extend({
  contract: z.literal(SOURCE_SEMANTIC_INLINE_PROPOSAL_CONTRACT),
  content: TableContent.omit({ entities: true }).extend({
    nodes: z.array(InlineNodes).max(SOURCE_SEMANTIC_TABLE_LIMIT.frames + SOURCE_SEMANTIC_TABLE_LIMIT.operators).readonly(),
    domains: z.array(InlineDomain).max(SOURCE_SEMANTIC_TABLE_LIMIT.domains).readonly().optional(),
    measurements: z.array(InlineMeasurement).max(SOURCE_SEMANTIC_TABLE_LIMIT.measurements).readonly().optional()
  }).readonly().optional()
}).readonly();
export function sourceSemanticInlineJsonSchema(): object {
  return presentationJsonSchema(SourceSemanticInlineProposalSchema);
}
