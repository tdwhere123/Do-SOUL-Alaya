import { z } from "zod";
import { SourceSemanticContentProposalSchema, materializeSourceSemanticContentProposal } from "./source-semantic-content-proposal.js";
import { SOURCE_SEMANTIC_MAX_DEPTH, SOURCE_SEMANTIC_SOURCE_ACTS, SourceSemanticDomainSchema,
  SourceSemanticMeasurementSchema } from "./source-semantic-draft.js";
import { SourceSemanticOutcomeSchema, type SourceSemanticResponseEnvelope } from "./source-semantic-interpretation.js";
import { SourceSemanticResourceExhausted, SourceSemanticResourceLedger } from "./source-semantic-resources.js";

export const SOURCE_SEMANTIC_EXPRESSION_PROPOSAL_CONTRACT = "source-semantic-proposal-v3" as const;
const Key = z.string().min(1).max(64);
const Fields = SourceSemanticContentProposalSchema.unwrap().shape.content.unwrap().unwrap().shape;
const EntityFields = Fields.entities.unwrap().element.unwrap().shape;
const StatementFields = Fields.statements.unwrap().element.unwrap().shape;
const ArgumentFields = StatementFields.arguments.unwrap().element.unwrap().shape;
const Predicate = StatementFields.predicate;
const Evidence = Predicate.unwrap().shape.evidence;
const Entity = z.object({ kind: z.literal("entity"), key: Key,
  referent_kind: EntityFields.referent_kind, mentions: EntityFields.mentions }).strict().readonly();
const ContentReference = z.object({ kind: z.literal("content_reference"), key: Key }).strict().readonly();
type EntityValue = z.infer<typeof Entity>;
type EvidenceValue = z.infer<typeof Evidence>;
type ContentReferenceValue = z.infer<typeof ContentReference>;
type TargetValue = EntityValue | ContentReferenceValue | Readonly<{ kind: "reference"; key: string }>
  | Readonly<{ kind: "content"; expression: ExpressionValue }>
  | Readonly<{ kind: "bound_variable"; quantifier: string }> | Readonly<{ kind: "unresolved" }>;
type StatementValue = Readonly<{ kind: "statement"; key: string; predicate: z.infer<typeof Predicate>;
  arguments: readonly Readonly<{ role: string; target: TargetValue; evidence: z.infer<typeof ArgumentFields.evidence> }>[] }>;
type OperatorBase = Readonly<{ key: string; evidence: EvidenceValue }>;
type OperandValue = ExpressionValue | ContentReferenceValue;
type ExpressionValue = StatementValue
  | OperatorBase & Readonly<{ kind: "not" | "possible"; content: OperandValue }>
  | OperatorBase & Readonly<{ kind: "reported"; content: OperandValue; reporter?: EntityValue }>
  | OperatorBase & Readonly<{ kind: "conditional"; antecedent: OperandValue; consequent: OperandValue }>
  | OperatorBase & Readonly<{ kind: "opaque"; operands: readonly OperandValue[] }>
  | OperatorBase & Readonly<{ kind: "forall"; domain: string; restriction: OperandValue | null; content: OperandValue }>;

function targetShape(expression?: z.ZodType<ExpressionValue>): z.ZodType<TargetValue> {
  return z.discriminatedUnion("kind", [Entity, ContentReference,
  z.object({ kind: z.literal("reference"), key: Key }).strict().readonly(),
  ...(expression === undefined ? [] : [z.object({ kind: z.literal("content"), expression }).strict().readonly()]),
  z.object({ kind: z.literal("bound_variable"), quantifier: Key }).strict().readonly(),
  z.object({ kind: z.literal("unresolved") }).strict().readonly()
  ]);
}
const Target: z.ZodType<TargetValue> = z.lazy(() => targetShape(Expression));
const Operand: z.ZodType<OperandValue> = z.lazy(() => z.union([ContentReference, Expression]));
const OperatorFields = { key: Key, evidence: Evidence };
function expressionShape(target: z.ZodType<TargetValue>, operand: z.ZodType<OperandValue>): z.ZodType<ExpressionValue> {
  return z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("statement"), key: Key, predicate: Predicate,
    arguments: z.array(z.object({ role: ArgumentFields.role, evidence: ArgumentFields.evidence, target }).strict().readonly()).max(8).readonly()
  }).strict().readonly(),
  z.object({ kind: z.literal("not"), ...OperatorFields, content: operand }).strict().readonly(),
  z.object({ kind: z.literal("possible"), ...OperatorFields, content: operand }).strict().readonly(),
  z.object({ kind: z.literal("reported"), ...OperatorFields, content: operand, reporter: Entity.optional() }).strict().readonly(),
  z.object({ kind: z.literal("conditional"), ...OperatorFields, antecedent: operand, consequent: operand }).strict().readonly(),
  z.object({ kind: z.literal("opaque"), ...OperatorFields, operands: z.array(operand).min(1).max(8).readonly() }).strict().readonly(),
  z.object({ kind: z.literal("forall"), ...OperatorFields, domain: Key, restriction: operand.nullable(), content: operand }).strict().readonly()
  ]);
}
const Expression: z.ZodType<ExpressionValue> = z.lazy(() => expressionShape(Target, Operand));
const Domain = SourceSemanticDomainSchema.unwrap().omit({ id: true }).extend({ key: Key, context: Key.nullable(), support: Evidence,
  members: z.array(z.object({ referent: Entity, evidence: Key, restrictions: z.array(
    z.object({ restriction: Key, evidence: Key }).strict().readonly()).max(16).readonly() }).strict().readonly()).max(64).readonly(),
  exclusions: z.array(z.object({ referent: Entity, evidence: Key }).strict().readonly()).max(64).readonly(),
  closure: z.discriminatedUnion("kind", [z.object({ kind: z.literal("open") }).strict().readonly(),
    z.object({ kind: z.literal("closed"), evidence: Key }).strict().readonly()])
}).readonly();
const Measurement = SourceSemanticMeasurementSchema.unwrap().omit({ id: true }).extend({ key: Key, subject: Entity,
  owner: Key, population: Key, support: Evidence }).readonly();
function contentShape(expression: z.ZodType<ExpressionValue>) {
  return z.object({ roots: z.array(z.object({ act: z.enum(SOURCE_SEMANTIC_SOURCE_ACTS), expression }).strict().readonly()).max(512).readonly(),
  domains: z.array(Domain).max(64).readonly().optional(), measurements: z.array(Measurement).max(256).readonly().optional(),
  gaps: Fields.gaps.unwrap().element.unwrap().extend({ affected: z.array(Key).max(56).readonly().optional() }).readonly().array().max(256).readonly()
  }).strict().readonly();
}
const Content = contentShape(Expression);
const Outcome = z.discriminatedUnion("status", [z.object({ status: z.literal("interpreted") }).strict().readonly(),
  ...SourceSemanticOutcomeSchema.options.filter(option => option.unwrap().shape.status.value !== "interpreted")]);
const Proposal = z.object({ contract: z.literal(SOURCE_SEMANTIC_EXPRESSION_PROPOSAL_CONTRACT), outcome: Outcome,
  content: Content.optional() }).strict().readonly();

/** Decoder syntax only; the unchanged compiler remains the semantic admission authority.
 * Emit with reused: "ref" so shared layers become an acyclic definitions DAG. */
export const SourceSemanticExpressionGenerationSchema = (() => {
  let expression: z.ZodType<ExpressionValue> | undefined;
  // Canonical depth counts domination edges: a root plus MAX_DEPTH descendants.
  for (let depth = SOURCE_SEMANTIC_MAX_DEPTH; depth >= 0; depth--) {
    const operand: z.ZodType<OperandValue> = expression === undefined ? ContentReference : z.union([ContentReference, expression]);
    expression = expressionShape(targetShape(expression), operand);
  }
  return Proposal.unwrap().extend({ content: contentShape(expression!).optional() }).readonly();
})();
type ContentValue = z.infer<typeof Content>;
type Path = (string | number)[];
type SymbolKind = "entity" | "statement" | "operator" | "domain" | "measurement";
type SymbolValue = { id: string; kind: SymbolKind; path: Path; parent?: string };

/** Identity preprocessing guards recursive parsing. JSON Schema uses the unchanged output syntax. */
export const SourceSemanticExpressionProposalSchema = z.preprocess((value, context) => {
  const meter = new SourceSemanticResourceLedger({ work_units: 200000, memory_bytes: 20000000 });
  try {
    materializeSourceSemanticExpressionProposal(value, meter);
    meter.retain(value, "expression schema output validation");
    return value;
  } catch (error) {
    if (!(error instanceof z.ZodError)) throw error;
    for (const issue of error.issues) context.addIssue({ ...issue });
    return z.NEVER;
  }
}, Proposal);

export function materializeSourceSemanticExpressionProposal(value: unknown,
  meter = new SourceSemanticResourceLedger({ work_units: 200000, memory_bytes: 20000000 })): SourceSemanticResponseEnvelope {
  preflight(value, meter);
  const proposal = Proposal.parse(value);
  if ((proposal.outcome.status === "interpreted") !== (proposal.content !== undefined)) {
    invalid(["content"], "outcome_content_mismatch", "", "Interpreted outcome requires content; other outcomes must not carry content.");
  }
  const content = proposal.content === undefined ? undefined : new ExpressionLowerer(meter).lower(proposal.content);
  return materializeSourceSemanticContentProposal({ contract: "source-semantic-proposal-v2", outcome: proposal.outcome,
    ...(content === undefined ? {} : { content }) }, meter);
}

/** Iterative traversal bounds unknown nesting before Zod can recurse, including malformed fields. */
function preflight(value: unknown, meter: SourceSemanticResourceLedger): void {
  meter.retain(value, "expression proposal input");
  const stack = [{ value, depth: 0, expressionDepth: 0, path: [] as Path }];
  const kinds = new Set(["statement", "not", "possible", "reported", "conditional", "forall", "opaque"]);
  while (stack.length > 0) {
    const row = stack.pop()!;
    meter.charge(1, 0, "expression depth preflight");
    if (row.depth > 8 * SOURCE_SEMANTIC_MAX_DEPTH + 32) throw new SourceSemanticResourceExhausted("expression input nesting");
    if (row.value === null || typeof row.value !== "object") continue;
    const object = row.value as Record<string, unknown>;
    const depth = row.expressionDepth + (typeof object.kind === "string" && kinds.has(object.kind) ? 1 : 0);
    if (depth > SOURCE_SEMANTIC_MAX_DEPTH + 1) invalid(row.path, "expression_depth_exceeded", String(object.key ?? ""), "Expression nesting exceeds canonical domination depth.");
    for (const [key, child] of Object.entries(object)) {
      meter.charge(0, 64 + 16 * (row.path.length + 1), "expression preflight stack");
      stack.push({ value: child, depth: row.depth + 1, expressionDepth: depth,
        path: [...row.path, Array.isArray(row.value) ? Number(key) : key] });
    }
  }
}

class ExpressionLowerer {
  private readonly symbols = new Map<string, SymbolValue>();
  private readonly entities = new Map<string, { id: string; referent_kind: EntityValue["referent_kind"]; mentions: EvidenceValue[number][] }>();
  private readonly anchors = new Map<string, Set<string>>();
  private readonly expressions: { value: ExpressionValue; path: Path }[] = [];
  private readonly counts: Record<SymbolKind, number> = { entity: 0, statement: 0, operator: 0, domain: 0, measurement: 0 };
  constructor(private readonly meter: SourceSemanticResourceLedger) {}

  lower(content: ContentValue) {
    this.meter.retain(content, "expression indexes");
    content.roots.forEach((root, index) => this.collect(root.expression, ["content", "roots", index, "expression"]));
    content.domains?.forEach((row, index) => {
      const path = ["content", "domains", index]; this.declare(row.key, "domain", path);
      row.members.forEach((member, n) => this.entity(member.referent, [...path, "members", n, "referent"]));
      row.exclusions.forEach((member, n) => this.entity(member.referent, [...path, "exclusions", n, "referent"]));
    });
    content.measurements?.forEach((row, index) => {
      const path = ["content", "measurements", index]; this.declare(row.key, "measurement", path);
      this.entity(row.subject, [...path, "subject"]);
    });
    const statements = this.expressions.filter(row => row.value.kind === "statement").map(({ value, path }) => this.statement(value as StatementValue, path));
    const operators = this.expressions.filter(row => row.value.kind !== "statement").map(({ value, path }) => this.operator(value as Exclude<ExpressionValue, StatementValue>, path));
    return { entities: [...this.entities.values()], statements, operators,
      acts: content.roots.map((row, index) => ({ occurrence: this.id(row.expression.key, ["statement", "operator"], ["content", "roots", index, "expression", "key"]), act: row.act })),
      ...(content.domains === undefined ? {} : { domains: content.domains.map((row, index) => this.domain(row, ["content", "domains", index])) }),
      ...(content.measurements === undefined ? {} : { measurements: content.measurements.map((row, index) => this.measurement(row, ["content", "measurements", index])) }),
      gaps: content.gaps.map((row, index) => ({ ...row, ...(row.affected === undefined ? {} : { affected: row.affected.map((key, n) =>
        this.id(key, ["entity", "statement", "operator"], ["content", "gaps", index, "affected", n])) }) })) };
  }

  private declare(key: string, kind: SymbolKind, path: Path, parent?: string): SymbolValue {
    const previous = this.symbols.get(key);
    if (previous !== undefined) invalid([...path, "key"], "duplicate_semantic_key", key,
      `Semantic key already declared at ${JSON.stringify(previous.path)}.`);
    const limit = kind === "domain" ? 64 : 256;
    if (this.counts[kind] >= limit) throw new SourceSemanticResourceExhausted(`expression ${kind} expansion`);
    this.meter.charge(1, 256, "expression symbol indexing");
    const symbol = { id: `host${kind}${this.counts[kind]++}`, kind, path, ...(parent === undefined ? {} : { parent }) };
    this.symbols.set(key, symbol); return symbol;
  }

  private entity(value: EntityValue, path: Path): void {
    let entity = this.entities.get(value.key);
    if (entity === undefined) {
      const symbol = this.declare(value.key, "entity", path);
      entity = { id: symbol.id, referent_kind: value.referent_kind, mentions: [] };
      this.entities.set(value.key, entity); this.anchors.set(value.key, new Set());
    } else if (entity.referent_kind !== value.referent_kind) invalid([...path, "referent_kind"], "conflicting_referent_kind", value.key, "Repeated entity key has incompatible referent kinds.");
    const seen = this.anchors.get(value.key)!;
    for (const anchor of value.mentions) {
      const key = JSON.stringify(anchor); if (seen.has(key)) continue;
      if (entity.mentions.length >= 64) throw new SourceSemanticResourceExhausted("expression entity anchor expansion");
      this.meter.charge(1, 128, "expression entity anchor indexing"); seen.add(key); entity.mentions.push(anchor);
    }
  }

  private collect(value: ExpressionValue, path: Path, parent?: string): void {
    this.declare(value.key, value.kind === "statement" ? "statement" : "operator", path, parent);
    this.expressions.push({ value, path });
    if (value.kind === "statement") value.arguments.forEach((argument, index) => {
      const target = argument.target, at = [...path, "arguments", index, "target"];
      if (target.kind === "entity") this.entity(target, at);
      if (target.kind === "content") this.collect(target.expression, [...at, "expression"], value.key);
    });
    else {
      if (value.kind === "reported" && value.reporter !== undefined) this.entity(value.reporter, [...path, "reporter"]);
      for (const [operand, at] of operandRows(value, path)) if (operand.kind !== "content_reference") this.collect(operand, at, value.key);
    }
  }

  private id(key: string, kinds: readonly SymbolKind[], path: Path): string {
    const symbol = this.symbols.get(key);
    if (symbol === undefined || !kinds.includes(symbol.kind)) invalid(path, "unknown_or_wrong_kind_key", key, `Reference requires a declared ${kinds.join(" or ")} key.`);
    return symbol.id;
  }

  private owned(value: OperandValue, parent: string, path: Path): string {
    const id = this.id(value.key, ["statement", "operator"], [...path, "key"]);
    if (this.symbols.get(value.key)!.parent !== parent) invalid([...path, "key"], "foreign_content_reference", value.key,
      "Content reference must reuse an expression defined under the same immediate parent.");
    return id;
  }

  private target(value: TargetValue, parent: string, path: Path): object {
    if (value.kind === "unresolved") return value;
    if (value.kind === "bound_variable") return { kind: value.kind, quantifier: this.id(value.quantifier, ["operator"], [...path, "quantifier"]) };
    if (value.kind === "content") return { kind: "content", id: this.owned(value.expression, parent, [...path, "expression"]) };
    if (value.kind === "content_reference") return { kind: "content", id: this.owned(value, parent, path) };
    return { kind: value.kind, id: this.id(value.key, value.kind === "entity" ? ["entity"] : ["statement", "operator"], [...path, "key"]) };
  }

  private statement(value: StatementValue, path: Path) {
    return { id: this.id(value.key, ["statement"], [...path, "key"]), predicate: value.predicate,
      arguments: value.arguments.map((argument, index) => ({ ...argument,
        target: this.target(argument.target, value.key, [...path, "arguments", index, "target"]) })) };
  }

  private operator(value: Exclude<ExpressionValue, StatementValue>, path: Path) {
    const base = { id: this.id(value.key, ["operator"], [...path, "key"]), operator: value.kind, evidence: value.evidence };
    if (value.kind === "conditional") return { ...base,
      antecedent: this.owned(value.antecedent, value.key, [...path, "antecedent"]), consequent: this.owned(value.consequent, value.key, [...path, "consequent"]) };
    if (value.kind === "opaque") return { ...base, operands: value.operands.map((operand, n) => this.owned(operand, value.key, [...path, "operands", n])) };
    return { ...base, content: this.owned(value.content, value.key, [...path, "content"]),
      ...(value.kind === "reported" && value.reporter !== undefined ? { reporter: this.id(value.reporter.key, ["entity"], [...path, "reporter", "key"]) } : {}),
      ...(value.kind === "forall" ? { domain: this.id(value.domain, ["domain"], [...path, "domain"]),
        restriction: value.restriction === null ? null : this.owned(value.restriction, value.key, [...path, "restriction"]) } : {}) };
  }

  private domain(value: z.infer<typeof Domain>, path: Path) {
    const occurrence = (key: string, at: Path) => this.id(key, ["statement", "operator"], at);
    return { id: this.id(value.key, ["domain"], [...path, "key"]), context: value.context === null ? null : occurrence(value.context, [...path, "context"]), support: value.support,
      members: value.members.map((row, index) => ({ referent: this.id(row.referent.key, ["entity"], [...path, "members", index, "referent", "key"]),
        evidence: occurrence(row.evidence, [...path, "members", index, "evidence"]), restrictions: row.restrictions.map((restriction, n) => ({
          restriction: occurrence(restriction.restriction, [...path, "members", index, "restrictions", n, "restriction"]),
          evidence: occurrence(restriction.evidence, [...path, "members", index, "restrictions", n, "evidence"]) })) })),
      exclusions: value.exclusions.map((row, index) => ({ referent: this.id(row.referent.key, ["entity"], [...path, "exclusions", index, "referent", "key"]),
        evidence: occurrence(row.evidence, [...path, "exclusions", index, "evidence"]) })),
      closure: value.closure.kind === "open" ? value.closure : { kind: "closed", evidence: occurrence(value.closure.evidence, [...path, "closure", "evidence"]) } };
  }

  private measurement(value: z.infer<typeof Measurement>, path: Path) {
    const { key, subject, owner, population, ...reading } = value;
    return { ...reading, id: this.id(key, ["measurement"], [...path, "key"]), subject: this.id(subject.key, ["entity"], [...path, "subject", "key"]),
      owner: this.id(owner, ["statement", "operator"], [...path, "owner"]), population: this.id(population, ["domain"], [...path, "population"]) };
  }
}

function operandRows(value: Exclude<ExpressionValue, StatementValue>, path: Path): readonly (readonly [OperandValue, Path])[] {
  if (value.kind === "conditional") return [[value.antecedent, [...path, "antecedent"]], [value.consequent, [...path, "consequent"]]];
  if (value.kind === "opaque") return value.operands.map((operand, n) => [operand, [...path, "operands", n]] as const);
  if (value.kind === "forall" && value.restriction !== null) return [[value.restriction, [...path, "restriction"]], [value.content, [...path, "content"]]];
  return [[value.content, [...path, "content"]]];
}

function invalid(path: Path, code: string, reference: string, message: string): never {
  throw new z.ZodError([{ code: "custom", path, message, params: { diagnostic_code: code, reference } }]);
}
