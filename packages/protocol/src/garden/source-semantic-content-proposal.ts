import { z } from "zod";
import { SourceAssertionIdSchema } from "../evidence/source-selection.js";
import { SourceReferenceSchema } from "../evidence/source-reference.js";
import {
  SOURCE_SEMANTIC_PACKET_CONTRACT, SOURCE_SEMANTIC_SOURCE_ACTS,
  SourceSemanticDomainSchema, SourceSemanticGapSchema, SourceSemanticHandleSchema,
  SourceSemanticMeasurementSchema, SourceSemanticReadingSchema, SourceSemanticReferentSchema,
  type SourceSemanticContextOwner, type SourceSemanticMention
} from "./source-semantic-draft.js";
import {
  SOURCE_SEMANTIC_RESPONSE_CONTRACT, SourceSemanticOutcomeSchema,
  SourceSemanticResponseEnvelopeSchema, type SourceSemanticResponseEnvelope
} from "./source-semantic-interpretation.js";
import {
  SourceSemanticResourceExhausted, SourceSemanticResourceLedger
} from "./source-semantic-resources.js";
import { chargeSourceSemanticValidation } from "./source-semantic-validation-cost.js";

export const SOURCE_SEMANTIC_CONTENT_PROPOSAL_CONTRACT = "source-semantic-proposal-v2" as const;
const Handle = SourceSemanticHandleSchema;
const Anchor = z.object({ assertion_id: SourceAssertionIdSchema, source_ref: SourceReferenceSchema }).strict().readonly();
const Anchors = (min = 0, max = 8) => z.array(Anchor).min(min).max(max).readonly();
const Target = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("entity"), id: Handle }).strict().readonly(),
  z.object({ kind: z.literal("reference"), id: Handle }).strict().readonly(),
  z.object({ kind: z.literal("content"), id: Handle }).strict().readonly(),
  z.object({ kind: z.literal("bound_variable"), quantifier: Handle }).strict().readonly(),
  z.object({ kind: z.literal("unresolved") }).strict().readonly()
]);
const Statement = z.object({
  id: Handle,
  predicate: z.object({ kind: z.enum(["explicit", "implicit"]), reading: SourceSemanticReadingSchema,
    evidence: Anchors(1) }).strict().readonly(),
  arguments: z.array(z.object({ role: SourceSemanticReadingSchema, target: Target, evidence: Anchors() }).strict().readonly()).max(8).readonly()
}).strict().readonly();
const OperatorBase = { id: Handle, evidence: Anchors(1) };
const Operator = z.discriminatedUnion("operator", [
  z.object({ ...OperatorBase, operator: z.literal("not"), content: Handle }).strict().readonly(),
  z.object({ ...OperatorBase, operator: z.literal("possible"), content: Handle }).strict().readonly(),
  z.object({ ...OperatorBase, operator: z.literal("opaque"), operands: z.array(Handle).min(1).max(8).readonly() }).strict().readonly(),
  z.object({ ...OperatorBase, operator: z.literal("reported"), content: Handle, reporter: Handle.optional() }).strict().readonly(),
  z.object({ ...OperatorBase, operator: z.literal("conditional"), antecedent: Handle, consequent: Handle }).strict().readonly(),
  z.object({ ...OperatorBase, operator: z.literal("forall"), domain: Handle, restriction: Handle.nullable(), content: Handle }).strict().readonly()
]);
const Content = z.object({
  entities: z.array(z.object({ id: Handle, referent_kind: SourceSemanticReferentSchema.unwrap().shape.referent_kind,
    mentions: Anchors(0, 64) }).strict().readonly()).max(256).readonly(),
  statements: z.array(Statement).max(256).readonly(),
  operators: z.array(Operator).max(256).readonly(),
  acts: z.array(z.object({ occurrence: Handle, act: z.enum(SOURCE_SEMANTIC_SOURCE_ACTS) }).strict().readonly()).max(512).readonly(),
  domains: z.array(SourceSemanticDomainSchema.unwrap().extend({ support: Anchors(1) }).readonly()).max(64).readonly().optional(),
  measurements: z.array(SourceSemanticMeasurementSchema.unwrap().extend({ support: Anchors(1) }).readonly()).max(256).readonly().optional(),
  gaps: z.array(z.object({ kind: SourceSemanticGapSchema.unwrap().shape.kind, evidence: Anchors(1),
    affected: z.array(Handle).max(56).readonly().optional(), description: z.string().min(1).max(1024).optional()
  }).strict().readonly()).max(256).readonly()
}).strict().readonly();
const Outcome = z.discriminatedUnion("status", [
  z.object({ status: z.literal("interpreted") }).strict().readonly(),
  ...SourceSemanticOutcomeSchema.options.filter((option) => option.unwrap().shape.status.value !== "interpreted")
]);
const Proposal = z.object({ contract: z.literal(SOURCE_SEMANTIC_CONTENT_PROPOSAL_CONTRACT),
  outcome: Outcome, content: Content.optional() }).strict().readonly();
type ContentValue = z.infer<typeof Content>;
type AnchorValue = z.infer<typeof Anchor>;
type OperatorValue = z.infer<typeof Operator>;

/** Schema consumers and the receiver share the same compiler and canonical authority. */
export const SourceSemanticContentProposalSchema = Proposal.superRefine((proposal, context) => {
  try { materializeSourceSemanticContentProposal(proposal); }
  catch (error) {
    if (!(error instanceof z.ZodError)) throw error;
    for (const issue of error.issues) context.addIssue({ ...issue });
  }
});

export function materializeSourceSemanticContentProposal(
  value: unknown, meter = new SourceSemanticResourceLedger({ work_units: 200000, memory_bytes: 20000000 })
): SourceSemanticResponseEnvelope {
  meter.retain(value, "content proposal input");
  const proposal = Proposal.parse(value);
  if ((proposal.outcome.status === "interpreted") !== (proposal.content !== undefined)) {
    invalid("interpreted outcome requires content; other outcomes must not carry content");
  }
  const draft = proposal.content === undefined ? undefined : lowerContent(proposal.content, meter);
  const envelope = { contract: SOURCE_SEMANTIC_RESPONSE_CONTRACT,
    outcome: proposal.outcome.status === "interpreted" ? { status: "interpreted", gaps: draft!.gaps } : proposal.outcome,
    ...(draft === undefined ? {} : { draft }) };
  meter.retain(envelope, "content proposal canonical validation");
  if (draft !== undefined) chargeSourceSemanticValidation(draft, meter);
  const parsed = SourceSemanticResponseEnvelopeSchema.safeParse(envelope);
  if (parsed.success) return parsed.data;
  if (parsed.error.issues.some((issue) => issue.code === "too_big" || issue.message.includes("exceeds its byte bound"))) {
    throw new SourceSemanticResourceExhausted("content proposal expansion");
  }
  throw parsed.error;
}

function lowerContent(content: ContentValue, meter: SourceSemanticResourceLedger) {
  // Precharge indexes and bounded expansion before retaining compiler-owned arrays.
  meter.retain(content, "content proposal indexes");
  const aliases = [...content.entities, ...content.statements, ...content.operators,
    ...content.domains ?? [], ...content.measurements ?? []].map((row) => row.id);
  const used = new Set(aliases);
  if (used.size !== aliases.length) invalid("duplicate semantic aliases");
  const entities = new Set(content.entities.map((row) => row.id));
  const occurrences = new Set([...content.statements, ...content.operators].map((row) => row.id));
  const owners = collectOwners(content, occurrences);
  const anchors = new AnchorInterner(used, meter);
  const referents = content.entities.map((row) => ({ id: row.id, referent_kind: row.referent_kind,
    mentions: anchors.ids(row.mentions) }));
  const frames = content.statements.map((row) => {
    meter.charge(1 + row.arguments.length, 512 + row.arguments.length * 512, "content statement expansion");
    const predicate = anchors.ids(row.predicate.evidence);
    const arguments_ = row.arguments.map((argument, index) => ({ id: `argument${index}`,
      role_reading: argument.role, support: anchors.support(argument.evidence),
      target: lowerTarget(argument.target, entities, occurrences) }));
    return { id: row.id, assertion_ids: assertionIds([...row.predicate.evidence, ...row.arguments.flatMap((argument) => argument.evidence)]),
      context_owner: owners.get(row.id)!, additional_support: [],
      predicate_support: row.predicate.kind === "explicit"
        ? { kind: "explicit" as const, reading: row.predicate.reading, mentions: predicate }
        : { kind: "implicit" as const, reading: row.predicate.reading, supporting_context: predicate },
      slots: arguments_.map(({ id, role_reading, support }) => ({ id, role_reading, support })),
      bindings: arguments_.map(({ id, target, support }) => ({ slot_id: id, target, support })) };
  });
  const operators = content.operators.map(({ evidence, ...row }) => ({ ...row,
    assertion_ids: assertionIds(evidence), context_owner: owners.get(row.id)!,
    additional_support: anchors.support(evidence), ...(row.operator === "forall" ? { binder: "member" } : {}) }));
  const domains = content.domains?.map(({ support, ...row }) => ({ ...row, support: anchors.support(support) }));
  const measurements = content.measurements?.map(({ support, ...row }) => ({ ...row, support: anchors.support(support) }));
  const gaps = content.gaps.map(({ evidence, affected, ...row }) => {
    for (const id of affected ?? []) if (!entities.has(id) && !occurrences.has(id)) invalid("gap affected alias must name a semantic entity or occurrence");
    return { ...row, affected_ids: [...new Set([...affected ?? [], ...anchors.ids(evidence)])], support: anchors.support(evidence) };
  });
  return { contract: SOURCE_SEMANTIC_PACKET_CONTRACT, mentions: anchors.mentions, referents, frames, operators, gaps,
    ...(domains === undefined ? {} : { domains }), ...(measurements === undefined ? {} : { measurements }) };
}

function collectOwners(content: ContentValue, occurrences: ReadonlySet<string>) {
  const owners = new Map<string, SourceSemanticContextOwner>();
  const own = (id: string, owner: SourceSemanticContextOwner, explicitAct = false) => {
    if (!occurrences.has(id)) invalid("ownership requires a declared occurrence");
    const previous = owners.get(id);
    if (previous !== undefined) {
      if (explicitAct || JSON.stringify(previous) !== JSON.stringify(owner)) invalid("occurrence has conflicting or duplicate ownership declarations");
      return;
    }
    owners.set(id, owner);
  };
  for (const row of content.acts) own(row.occurrence, { kind: "source_act", source_act: row.act }, true);
  for (const statement of content.statements) for (const argument of statement.arguments) {
    if (argument.target.kind === "content") own(argument.target.id,
      { kind: "embedding", parent_frame: statement.id, content_argument: argument.target.id });
  }
  for (const operator of content.operators) for (const operand of operands(operator)) {
    own(operand, { kind: "operator", operator_handle: operator.id });
  }
  for (const id of occurrences) if (!owners.has(id)) invalid("occurrence requires an explicit source act or governing content edge");
  return owners;
}

function operands(operator: OperatorValue): readonly string[] {
  if (operator.operator === "conditional") return [operator.antecedent, operator.consequent];
  if (operator.operator === "opaque") return operator.operands;
  if (operator.operator === "forall" && operator.restriction !== null) return [operator.restriction, operator.content];
  return [operator.content];
}

function lowerTarget(target: z.infer<typeof Target>, entities: ReadonlySet<string>, occurrences: ReadonlySet<string>) {
  if (target.kind === "unresolved") return target;
  if (target.kind === "bound_variable") return { ...target, binder: "member" };
  if (!(target.kind === "entity" ? entities : occurrences).has(target.id)) invalid("argument target references an unknown or wrong-kind semantic alias");
  return { kind: "node" as const, id: target.id };
}

class AnchorInterner {
  readonly mentions: SourceSemanticMention[] = [];
  private readonly byAnchor = new Map<string, string>();
  private ordinal = 0;
  constructor(private readonly used: Set<string>, private readonly meter: SourceSemanticResourceLedger) {}
  ids(anchors: readonly AnchorValue[]): string[] {
    return [...new Set(anchors.map((anchor) => this.intern(anchor)))];
  }
  support(anchors: readonly AnchorValue[]) {
    return anchors.length === 0 ? [] : [{ kind: "lexical" as const, mentions: this.ids(anchors) }];
  }
  private intern(anchor: AnchorValue): string {
    this.meter.charge(1, 128, "source anchor indexing");
    const key = JSON.stringify(anchor), previous = this.byAnchor.get(key);
    if (previous !== undefined) return previous;
    if (this.mentions.length >= 512) throw new SourceSemanticResourceExhausted("content mention expansion");
    this.meter.charge(1, 512, "content mention expansion");
    let id: string;
    do { id = `hostMention${this.ordinal++}`; } while (this.used.has(id));
    this.used.add(id); this.byAnchor.set(key, id); this.mentions.push({ id, ...anchor });
    return id;
  }
}

function assertionIds(anchors: readonly AnchorValue[]): number[] {
  return [...new Set(anchors.map((anchor) => anchor.assertion_id))].sort((a, b) => a - b);
}

function invalid(message: string): never {
  throw new z.ZodError([{ code: "custom", path: ["content"], message }]);
}
