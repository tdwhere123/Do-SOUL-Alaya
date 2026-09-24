import { z } from "zod";
import { AlayaError } from "../shared/alaya-error.js";
import {
  SOURCE_SEMANTIC_GAP_KINDS, SOURCE_SEMANTIC_MAX_DEPTH, SOURCE_SEMANTIC_SOURCE_ACTS,
  SourceSemanticDraftSchema, SourceSemanticFrameSchema, SourceSemanticReadingSchema,
  SourceSemanticReferentSchema
} from "./source-semantic-draft.js";
import {
  SOURCE_SEMANTIC_SELECTION_PROPOSAL_CONTRACT, SOURCE_SEMANTIC_SELECTION_SUPPORT_LIST_BOUND,
  SourceSemanticSelectionGenerationSchema, materializeSourceSemanticSelectionProposal
} from "./source-semantic-selection-proposal.js";
import { SourceAssertionIdSchema, SourceOccurrenceSchema } from "../evidence/source-selection.js";
import { SourceSemanticResourceLedger } from "./source-semantic-resources.js";
import { SourceSemanticInterpretationSchema } from "./source-semantic-interpretation.js";
import type { SourceReferenceCatalog } from "../evidence/source-reference.js";
import type { FieldContractSha256 } from "../recall/field-contract/canonical-identity.js";

/** Finite producer syntax; native selection and graph owners retain canonical meaning. */
export const SOURCE_SEMANTIC_TABLE_PROPOSAL_CONTRACT = "source-semantic-proposal-v8" as const;
export const SOURCE_SEMANTIC_TABLE_GENERATION_CONTRACT = "host-owned-table-schema-v1" as const;
const SelectionContent = SourceSemanticSelectionGenerationSchema.unwrap().shape.content.unwrap().unwrap().shape;
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
const LIMIT = {
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
const Atom = z.object({ assertion_id: SourceAssertionIdSchema,
  text: z.string().min(1).max(65536), occurrence: SourceOccurrenceSchema.optional() }).strict().readonly();
const Support = z.union([Atom, z.array(Atom).min(1).max(SOURCE_SEMANTIC_SELECTION_SUPPORT_LIST_BOUND).readonly()]);
const EntityRef = z.object({ kind: z.literal("entity_ref"), key: Key }).strict().readonly();
const ContentRef = z.object({ kind: z.literal("content_ref"), key: Key }).strict().readonly();
const OccurrenceRef = z.object({ kind: z.literal("occurrence_ref"), key: Key }).strict().readonly();
const NativeContentRef = z.object({ kind: z.literal("content_reference"), key: Key }).strict().readonly();
const Target = z.discriminatedUnion("kind", [EntityRef, ContentRef, OccurrenceRef, NativeContentRef,
  z.object({ kind: z.literal("unresolved") }).strict().readonly(),
  z.object({ kind: z.literal("bound_variable"), quantifier: Key }).strict().readonly()]);
const Operand = z.union([ContentRef, NativeContentRef]);
const Entity = z.discriminatedUnion("form", [
  z.object({ form: z.literal("selection"), key: Key, semantic_key: Key.optional(), selection: Atom }).strict().readonly(),
  z.object({ form: z.literal("entity"), key: Key, semantic_key: Key.optional(),
    referent_kind: SourceSemanticReferentSchema.unwrap().shape.referent_kind.optional(),
    mentions: z.array(Atom).min(1).max(LIMIT.mentions).readonly() }).strict().readonly()
]);
const Argument = z.object({ role: SourceSemanticReadingSchema, target: Target,
  support: Support.optional() }).strict().readonly();
const Qualification = Argument.unwrap().extend({ support: Support }).strict().readonly();
const Predicate = z.object({ kind: z.enum(["explicit", "implicit"]),
  reading: SourceSemanticReadingSchema, support: Support }).strict().readonly();
const Statement = z.object({ kind: z.literal("statement"), key: Key,
  predicate: Predicate, arguments: z.array(Argument).max(LIMIT.arguments).readonly(),
  qualifications: z.array(Qualification).max(LIMIT.arguments).readonly() }).strict().readonly();
const OperatorBase = { key: Key, support: Support };
const Nodes = z.discriminatedUnion("kind", [Statement,
  z.object({ kind: z.literal("not"), ...OperatorBase, content: Operand }).strict().readonly(),
  z.object({ kind: z.literal("possible"), ...OperatorBase, content: Operand }).strict().readonly(),
  z.object({ kind: z.literal("reported"), ...OperatorBase, content: Operand,
    reporter: EntityRef.optional() }).strict().readonly(),
  z.object({ kind: z.literal("conditional"), ...OperatorBase, antecedent: Operand,
    consequent: Operand }).strict().readonly(),
  z.object({ kind: z.literal("opaque"), ...OperatorBase,
    operands: z.array(Operand).min(1).max(LIMIT.arguments).readonly() }).strict().readonly(),
  z.object({ kind: z.literal("forall"), ...OperatorBase, domain: Key,
    restriction: Operand.nullable(), content: Operand }).strict().readonly()
]);
const Domain = NativeDomain.extend({
  members: z.array(NativeDomainMember.extend({ referent: EntityRef }).readonly()).max(LIMIT.domainMembers).readonly(),
  exclusions: z.array(NativeDomainExclusion.extend({ referent: EntityRef }).readonly()).max(LIMIT.domainExclusions).readonly()
}).readonly();
const Measurement = NativeMeasurement.extend({ subject: EntityRef }).readonly();
const GapTarget = z.discriminatedUnion("kind", [EntityRef, OccurrenceRef]);
const SourceSemanticTableProposalSchema = z.object({ contract: z.literal(SOURCE_SEMANTIC_TABLE_PROPOSAL_CONTRACT),
  outcome: SourceSemanticSelectionGenerationSchema.unwrap().shape.outcome,
  content: z.object({ roots: z.array(z.object({ act: z.enum(SOURCE_SEMANTIC_SOURCE_ACTS),
    expression: ContentRef }).strict().readonly()).max(LIMIT.roots).readonly(),
    entities: z.array(Entity).max(LIMIT.entities).readonly(),
    nodes: z.array(Nodes).max(LIMIT.frames + LIMIT.operators).readonly(),
    domains: z.array(Domain).max(LIMIT.domains).readonly().optional(),
    measurements: z.array(Measurement).max(LIMIT.measurements).readonly().optional(),
    gaps: z.array(z.object({ affected: z.array(GapTarget).max(LIMIT.gapAffected).readonly(),
      kind: z.enum(SOURCE_SEMANTIC_GAP_KINDS), support: Support,
      description: z.string().min(1).max(1024).optional() }).strict().readonly()).max(LIMIT.gaps).readonly()
  }).strict().readonly().optional()
}).strict().readonly();
type SourceSemanticTableProposal = z.infer<typeof SourceSemanticTableProposalSchema>;
type Content = NonNullable<SourceSemanticTableProposal["content"]>;
type Node = Content["nodes"][number];
type TargetValue = z.infer<typeof Target>;
type OperandValue = z.infer<typeof Operand>;

export function sourceSemanticTableJsonSchema(): object {
  return z.toJSONSchema(SourceSemanticTableProposalSchema, { io: "output", reused: "ref",
    override: ({ jsonSchema }) => {
      if (jsonSchema.const !== undefined) { jsonSchema.enum = [jsonSchema.const]; delete jsonSchema.const; }
    } });
}

function fail(code: string, key: string): never { throw new AlayaError("VALIDATION", `${code}: ${key}`); }
function references(node: Node): readonly OperandValue[] {
  if (node.kind === "statement") return [...node.arguments, ...node.qualifications]
    .flatMap(row => row.target.kind === "content_ref" || row.target.kind === "content_reference" ? [row.target] : []);
  if (node.kind === "conditional") return [node.antecedent, node.consequent];
  if (node.kind === "opaque") return node.operands;
  if (node.kind === "forall") return node.restriction === null ? [node.content] : [node.restriction, node.content];
  return [node.content];
}

/** Validate the finite ownership graph before expanding a single node. */
function index(content: Content, meter: SourceSemanticResourceLedger) {
  const nodes = new Map<string, Node>(), entities = new Map<string, Content["entities"][number]>();
  const materializedEntities = new Set<string>();
  let frames = 0, operators = 0;
  for (const entity of content.entities) {
    meter.charge(1, 96, "table entity index");
    if (entities.has(entity.key)) fail("duplicate_entity", entity.key);
    entities.set(entity.key, entity);
  }
  for (const node of content.nodes) {
    meter.charge(1, 96, "table occurrence index");
    if (nodes.has(node.key)) fail("duplicate_occurrence", node.key);
    if (node.kind === "statement" ? ++frames > LIMIT.frames : ++operators > LIMIT.operators) {
      fail("native_occurrence_capacity_exceeded", node.key);
    }
    if (node.kind === "statement" && node.arguments.length + node.qualifications.length > LIMIT.arguments) {
      fail("argument_capacity_exceeded", node.key);
    }
    nodes.set(node.key, node);
  }
  const owner = new Map<string, string>(), root = new Map<string, string>();
  const edges = new Map<string, string[]>();
  for (const node of content.nodes) {
    const children: string[] = [];
    for (const ref of references(node)) {
      if (ref.kind !== "content_ref") continue;
      if (!nodes.has(ref.key)) fail("missing_content", ref.key);
      if (owner.has(ref.key)) fail("ambiguous_content_owner", ref.key);
      owner.set(ref.key, node.key); children.push(ref.key);
    }
    edges.set(node.key, children);
    const targets = node.kind === "statement" ? [...node.arguments, ...node.qualifications].map(row => row.target) : [];
    for (const target of targets) {
      if (target.kind === "entity_ref") {
        if (!entities.has(target.key)) fail("missing_entity", target.key);
        materializedEntities.add(target.key);
      }
      if (target.kind === "occurrence_ref" && !nodes.has(target.key)) fail("missing_occurrence", target.key);
      if (target.kind === "content_ref" && !nodes.has(target.key)) fail("missing_content", target.key);
      if (target.kind === "bound_variable" && (nodes.get(target.quantifier) === undefined
        || nodes.get(target.quantifier)?.kind === "statement")) {
        fail("wrong_quantifier_kind", target.quantifier);
      }
    }
    if (node.kind === "reported" && node.reporter !== undefined && !entities.has(node.reporter.key)) {
      fail("missing_reporter", node.reporter.key);
    }
    if (node.kind === "reported" && node.reporter !== undefined) materializedEntities.add(node.reporter.key);
  }
  const domains = new Set<string>();
  const nativeKeys = new Set(nodes.keys());
  for (const row of content.domains ?? []) {
    meter.charge(1, 96, "table domain index");
    if (nativeKeys.has(row.key)) fail("duplicate_native_key", row.key);
    nativeKeys.add(row.key);
    domains.add(row.key);
    for (const member of [...row.members, ...row.exclusions]) {
      if (!entities.has(member.referent.key)) fail("missing_domain_entity", member.referent.key);
      materializedEntities.add(member.referent.key);
    }
  }
  const measurements = new Set<string>();
  for (const row of content.measurements ?? []) {
    meter.charge(1, 96, "table measurement index");
    if (nativeKeys.has(row.key)) fail("duplicate_native_key", row.key);
    nativeKeys.add(row.key);
    measurements.add(row.key);
    if (!entities.has(row.subject.key)) fail("missing_measurement_subject", row.subject.key);
    materializedEntities.add(row.subject.key);
  }
  for (const node of content.nodes) if (node.kind === "forall" && !domains.has(node.domain)) {
    fail("missing_quantifier_domain", node.domain);
  }
  for (const entity of content.entities) if (entity.semantic_key !== undefined && nativeKeys.has(entity.semantic_key)) {
    fail("duplicate_native_key", entity.semantic_key);
  }
  const occurrence = (key: string) => { if (!nodes.has(key)) fail("missing_occurrence", key); };
  for (const row of content.domains ?? []) {
    if (row.context !== null) occurrence(row.context);
    for (const member of row.members) {
      occurrence(member.evidence);
      for (const restriction of member.restrictions) {
        occurrence(restriction.restriction); occurrence(restriction.evidence);
      }
    }
    for (const exclusion of row.exclusions) occurrence(exclusion.evidence);
    if (row.closure.kind === "closed") occurrence(row.closure.evidence);
  }
  for (const row of content.measurements ?? []) {
    occurrence(row.owner);
    if (!domains.has(row.population)) fail("missing_measurement_population", row.population);
  }
  const queue: { key: string; root: string; depth: number }[] = [];
  for (const row of content.roots) {
    if (!nodes.has(row.expression.key)) fail("missing_root", row.expression.key);
    if (owner.has(row.expression.key)) fail("ambiguous_root_owner", row.expression.key);
    owner.set(row.expression.key, "@root");
    queue.push({ key: row.expression.key, root: row.expression.key, depth: 1 });
  }
  while (queue.length > 0) {
    const item = queue.pop()!;
    meter.charge(1, 128, "table ownership walk");
    if (item.depth > SOURCE_SEMANTIC_MAX_DEPTH + 1) fail("expression_depth_exceeded", item.key);
    if (root.has(item.key)) fail("cyclic_or_reused_content", item.key);
    root.set(item.key, item.root);
    for (const child of edges.get(item.key) ?? []) queue.push({ key: child, root: item.root, depth: item.depth + 1 });
  }
  if (root.size !== nodes.size) fail("disconnected_or_cyclic_content", String(nodes.size - root.size));
  for (const node of content.nodes) {
    for (const ref of references(node)) if (ref.kind === "content_reference") {
      if (!nodes.has(ref.key)) fail("missing_content_reuse", ref.key);
      if (owner.get(ref.key) !== node.key) fail("foreign_content_reference", ref.key);
    }
  }
  for (const gap of content.gaps) {
    for (const affected of gap.affected) {
      if (affected.kind === "occurrence_ref") {
        if (!nodes.has(affected.key)) fail("missing_gap_occurrence", affected.key);
      } else {
        const entity = entities.get(affected.key);
        if (entity === undefined) fail("missing_gap_entity", affected.key);
        if (entity.semantic_key === undefined) fail("gap_entity_requires_semantic_key", affected.key);
      }
    }
  }
  for (const row of content.entities) if (!materializedEntities.has(row.key)) fail("unused_entity_definition", row.key);
  return { nodes, entities };
}

/** Only a syntax/ownership adapter: the existing selection materializer decides canonical meaning. */
export function materializeSourceSemanticTableProposal(value: unknown,
  binding: Readonly<{ catalog: SourceReferenceCatalog; sha256: FieldContractSha256 }>,
  meter = new SourceSemanticResourceLedger({ work_units: 200000, memory_bytes: 20000000 })) {
  meter.retain(value, "table proposal input");
  const proposal = SourceSemanticTableProposalSchema.parse(value);
  if (["no_eligible_source", "unavailable", "unexercised", "preparation_required"].includes(proposal.outcome.status)) {
    fail("host_only_outcome", proposal.outcome.status);
  }
  if ((proposal.outcome.status === "interpreted") !== (proposal.content !== undefined)) {
    fail("outcome_content_mismatch", proposal.outcome.status);
  }
  const content = proposal.content;
  if (content === undefined) return materializeSourceSemanticSelectionProposal({
    contract: SOURCE_SEMANTIC_SELECTION_PROPOSAL_CONTRACT, outcome: proposal.outcome
  }, binding, meter);
  const { nodes, entities } = index(content, meter);
  const entity = (key: string): object => {
    const row = entities.get(key)!;
    if (row.form === "selection") return row.semantic_key === undefined ? row.selection : {
      kind: "entity", key: row.semantic_key, mentions: [row.selection]
    };
    return {
      kind: "entity", ...(row.semantic_key === undefined ? {} : { key: row.semantic_key }),
      ...(row.referent_kind === undefined ? {} : { referent_kind: row.referent_kind }), mentions: row.mentions
    };
  };
  const target = (row: TargetValue): object => {
    if (row.kind === "entity_ref") return entity(row.key);
    if (row.kind === "occurrence_ref") return { kind: "occurrence", key: row.key };
    if (row.kind === "content_ref") return expression(row.key);
    return row;
  };
  const operand = (row: OperandValue): object => row.kind === "content_ref" ? expression(row.key) : row;
  const expression = (key: string): object => {
    meter.charge(1, 256, "table node expansion");
    const row = nodes.get(key)!;
    if (row.kind === "statement") return { kind: row.kind, key: row.key, predicate: row.predicate,
      arguments: [...row.arguments, ...row.qualifications].map(arg => ({
        role: arg.role, target: target(arg.target), ...(arg.support === undefined ? {} : { support: arg.support })
      })) };
    if (row.kind === "conditional") return { kind: row.kind, key: row.key, support: row.support,
      antecedent: operand(row.antecedent), consequent: operand(row.consequent) };
    if (row.kind === "opaque") return { kind: row.kind, key: row.key, support: row.support,
      operands: row.operands.map(operand) };
    const base = { kind: row.kind, key: row.key, support: row.support, content: operand(row.content) };
    if (row.kind === "reported") return { ...base,
      ...(row.reporter === undefined ? {} : { reporter: entity(row.reporter.key) }) };
    if (row.kind === "forall") return { ...base, domain: row.domain,
      restriction: row.restriction === null ? null : operand(row.restriction) };
    return base;
  };
  const selection = { contract: SOURCE_SEMANTIC_SELECTION_PROPOSAL_CONTRACT, outcome: proposal.outcome,
    content: { roots: content.roots.map(row => ({ act: row.act, expression: expression(row.expression.key) })),
      ...(content.domains === undefined ? {} : { domains: content.domains.map(row => ({ ...row,
        members: row.members.map(member => ({ ...member, referent: entity(member.referent.key) })),
        exclusions: row.exclusions.map(exclusion => ({ ...exclusion, referent: entity(exclusion.referent.key) })) })) }),
      ...(content.measurements === undefined ? {} : { measurements: content.measurements.map(row => ({
        ...row, subject: entity(row.subject.key) })) }),
      gaps: content.gaps.map(row => ({ kind: row.kind, support: row.support,
        affected: row.affected.map(affected => affected.kind === "occurrence_ref" ? affected.key
          : entities.get(affected.key)!.semantic_key!),
        ...(row.description === undefined ? {} : { description: row.description }) })) } };
  meter.retain(selection, "table selection lowering");
  return materializeSourceSemanticSelectionProposal(selection, binding, meter);
}
