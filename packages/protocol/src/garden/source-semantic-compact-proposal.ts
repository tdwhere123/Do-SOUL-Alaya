import { z } from "zod";
import { SourceAssertionIdSchema } from "../evidence/source-selection.js";
import { SourceReferenceSchema } from "../evidence/source-reference.js";
import {
  SOURCE_SEMANTIC_GAP_KINDS, SOURCE_SEMANTIC_MAX_DEPTH, SOURCE_SEMANTIC_SOURCE_ACTS,
  SourceSemanticDecimalSchema, SourceSemanticReadingSchema
} from "./source-semantic-draft.js";
import { SOURCE_SEMANTIC_EXPRESSION_PROPOSAL_CONTRACT, materializeSourceSemanticExpressionProposal } from "./source-semantic-expression-proposal.js";
import { SourceSemanticOutcomeSchema, type SourceSemanticResponseEnvelope } from "./source-semantic-interpretation.js";
import { SourceSemanticResourceExhausted, SourceSemanticResourceLedger } from "./source-semantic-resources.js";

export const SOURCE_SEMANTIC_COMPACT_PROPOSAL_CONTRACT = "source-semantic-proposal-v4" as const;
export const SOURCE_SEMANTIC_COMPACT_GENERATION_CONTRACT = "host-owned-expression-schema-v1" as const;
export const SOURCE_SEMANTIC_COMPACT_GENERATION_DEPTH = SOURCE_SEMANTIC_MAX_DEPTH;
export const SOURCE_SEMANTIC_COMPACT_FEATURES = ["nested_expression", "quantified", "measurement"] as const;

const Key = z.string().min(1).max(64);
const SegmentId = z.string().regex(/^a[1-9][0-9]*s[0-9]+$/u).max(48);
const RangeAnchor = z.object({ first: SegmentId, last: SegmentId }).strict().readonly();
const FullAnchor = z.object({ assertion_id: SourceAssertionIdSchema, source_ref: SourceReferenceSchema }).strict().readonly();
const Anchor = z.union([SegmentId, RangeAnchor, FullAnchor]);
const Anchors = z.array(Anchor).min(1).max(8).readonly();
const ReferentKind = z.enum(["grouped", "unresolved", "unexpressed", "ambiguous"]);
const NamedEntity = z.object({ key: Key, at: Anchor.optional(), mentions: z.array(Anchor).min(1).max(64).readonly().optional(),
  referent_kind: ReferentKind.optional() }).strict().readonly();
const Entity = z.object({ kind: z.literal("entity"), key: Key.optional(), referent_kind: ReferentKind.optional(),
  mentions: z.array(Anchor).min(1).max(64).readonly() }).strict().readonly();
const ContentReference = z.object({ kind: z.literal("content_reference"), key: Key }).strict().readonly();
const Support = { key: Key.optional(), at: Anchor.optional(), evidence: Anchors.optional() };
const Predicate = z.object({ kind: z.enum(["explicit", "implicit"]), reading: SourceSemanticReadingSchema,
  at: Anchor.optional(), evidence: Anchors.optional() }).strict().readonly();
const Referent = z.union([SegmentId, NamedEntity, Entity]);
type Path = (string | number)[];
type AnchorValue = z.infer<typeof FullAnchor>;
type ExpressionValue = Readonly<{ kind: string; key?: string }>;
type TargetValue = unknown;
type OperandValue = ExpressionValue | z.infer<typeof ContentReference>;

function targetShape(expression?: z.ZodType<ExpressionValue>): z.ZodType<TargetValue> {
  const leaves = [SegmentId, RangeAnchor, FullAnchor, NamedEntity, Entity, ContentReference,
    z.object({ kind: z.literal("reference"), key: Key }).strict().readonly(),
    z.object({ kind: z.literal("bound_variable"), quantifier: Key }).strict().readonly(),
    z.object({ kind: z.literal("unresolved") }).strict().readonly()] as const;
  return expression === undefined ? z.union(leaves) : z.union([...leaves, expression]);
}
function expressionShape(target: z.ZodType<TargetValue>, operand: z.ZodType<OperandValue>): z.ZodType<ExpressionValue> {
  return z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("statement"), key: Key.optional(), predicate: Predicate,
      arguments: z.array(z.object({ role: SourceSemanticReadingSchema, target, at: Anchor.optional(),
        evidence: z.array(Anchor).max(8).readonly().optional() }).strict().readonly()).max(8).readonly()
    }).strict().readonly(),
    z.object({ kind: z.literal("not"), ...Support, content: operand }).strict().readonly(),
    z.object({ kind: z.literal("possible"), ...Support, content: operand }).strict().readonly(),
    z.object({ kind: z.literal("reported"), ...Support, content: operand, reporter: Referent.optional() }).strict().readonly(),
    z.object({ kind: z.literal("conditional"), ...Support, antecedent: operand, consequent: operand }).strict().readonly(),
    z.object({ kind: z.literal("opaque"), ...Support, operands: z.array(operand).min(1).max(8).readonly() }).strict().readonly(),
    z.object({ kind: z.literal("forall"), key: Key, domain: Key, restriction: operand.nullable(), content: operand,
      at: Anchor.optional(), evidence: Anchors.optional() }).strict().readonly()
  ]);
}
const Expression: z.ZodType<ExpressionValue> = z.lazy(() => expressionShape(Target, Operand));
const Target: z.ZodType<TargetValue> = z.lazy(() => targetShape(Expression));
const Operand: z.ZodType<OperandValue> = z.lazy(() => z.union([ContentReference, Expression]));
const Domain = z.object({
  key: Key, context: Key.nullable(), support: z.union([Anchor, Anchors]),
  members: z.array(z.object({ referent: Referent, evidence: Key, restrictions: z.array(
    z.object({ restriction: Key, evidence: Key }).strict().readonly()).max(16).readonly() }).strict().readonly()).max(64).readonly(),
  exclusions: z.array(z.object({ referent: Referent, evidence: Key }).strict().readonly()).max(64).readonly(),
  closure: z.discriminatedUnion("kind", [z.object({ kind: z.literal("open") }).strict().readonly(),
    z.object({ kind: z.literal("closed"), evidence: Key }).strict().readonly()])
}).strict().readonly();
const Measurement = z.object({
  key: Key, subject: Referent, owner: Key, population: Key, metric: SourceSemanticReadingSchema,
  unit: SourceSemanticReadingSchema, context: SourceSemanticReadingSchema, value: SourceSemanticDecimalSchema,
  support: z.union([Anchor, Anchors])
}).strict().readonly();
function contentShape(expression: z.ZodType<ExpressionValue>) {
  return z.object({
    roots: z.array(z.object({ act: z.enum(SOURCE_SEMANTIC_SOURCE_ACTS), expression }).strict().readonly()).max(512).readonly(),
    domains: z.array(Domain).max(64).readonly().optional(),
    measurements: z.array(Measurement).max(256).readonly().optional(),
    gaps: z.array(z.object({ kind: z.enum(SOURCE_SEMANTIC_GAP_KINDS), evidence: z.union([Anchor, Anchors]),
      affected: z.array(Key).max(56).readonly().optional(), description: z.string().min(1).max(1024).optional()
    }).strict().readonly()).max(256).readonly().optional()
  }).strict().readonly();
}
const Content = contentShape(Expression);
const Outcome = z.discriminatedUnion("status", [z.object({ status: z.literal("interpreted") }).strict().readonly(),
  ...SourceSemanticOutcomeSchema.options.filter(option => option.unwrap().shape.status.value !== "interpreted")]);
const CompactProposal = z.object({
  contract: z.literal(SOURCE_SEMANTIC_COMPACT_PROPOSAL_CONTRACT),
  outcome: Outcome, content: Content.optional()
}).strict().readonly();
type ContentValue = z.infer<typeof Content>;

/** Decoder syntax only; admission remains the shared expression compiler after host expansion. */
export const SourceSemanticCompactGenerationSchema = (() => {
  let expression: z.ZodType<ExpressionValue> | undefined;
  for (let depth = SOURCE_SEMANTIC_COMPACT_GENERATION_DEPTH; depth >= 0; depth--) {
    const operand: z.ZodType<OperandValue> = expression === undefined ? ContentReference : z.union([ContentReference, expression]);
    expression = expressionShape(targetShape(expression), operand);
  }
  return CompactProposal.unwrap().extend({ content: contentShape(expression!).optional() }).readonly();
})();

export const SourceSemanticCompactProposalSchema = z.preprocess((value, context) => {
  const meter = new SourceSemanticResourceLedger({ work_units: 200000, memory_bytes: 20000000 });
  try {
    materializeSourceSemanticCompactProposal(value, meter);
    meter.retain(value, "compact schema output validation");
    return value;
  } catch (error) {
    if (!(error instanceof z.ZodError)) throw error;
    for (const issue of error.issues) context.addIssue({ ...issue });
    return z.NEVER;
  }
}, CompactProposal);

export function materializeSourceSemanticCompactProposal(value: unknown,
  meter = new SourceSemanticResourceLedger({ work_units: 200000, memory_bytes: 20000000 })): SourceSemanticResponseEnvelope {
  preflight(value, meter);
  const proposal = CompactProposal.parse(value);
  if ((proposal.outcome.status === "interpreted") !== (proposal.content !== undefined)) {
    invalid(["content"], "outcome_content_mismatch", "", "Interpreted outcome requires content; other outcomes must not carry content.");
  }
  const expanded = {
    contract: SOURCE_SEMANTIC_EXPRESSION_PROPOSAL_CONTRACT, outcome: proposal.outcome,
    ...(proposal.content === undefined ? {} : { content: new CompactExpander(meter).expand(proposal.content) })
  };
  meter.retain(expanded, "compact expression expansion");
  return materializeSourceSemanticExpressionProposal(expanded, meter);
}

function preflight(value: unknown, meter: SourceSemanticResourceLedger): void {
  meter.retain(value, "compact proposal input");
  const stack = [{ value, depth: 0, expressionDepth: 0, path: [] as Path }];
  const kinds = new Set(["statement", "not", "possible", "reported", "conditional", "forall", "opaque"]);
  while (stack.length > 0) {
    const row = stack.pop()!;
    meter.charge(1, 0, "compact depth preflight");
    if (row.depth > 8 * SOURCE_SEMANTIC_MAX_DEPTH + 32) throw new SourceSemanticResourceExhausted("compact input nesting");
    if (row.value === null || typeof row.value !== "object") continue;
    const object = row.value as Record<string, unknown>;
    const depth = row.expressionDepth + (typeof object.kind === "string" && kinds.has(object.kind) ? 1 : 0);
    if (depth > SOURCE_SEMANTIC_MAX_DEPTH + 1) invalid(row.path, "expression_depth_exceeded", String(object.key ?? ""), "Expression nesting exceeds canonical domination depth.");
    for (const [key, child] of Object.entries(object)) {
      meter.charge(0, 64 + 16 * (row.path.length + 1), "compact preflight stack");
      stack.push({ value: child, depth: row.depth + 1, expressionDepth: depth,
        path: [...row.path, Array.isArray(row.value) ? Number(key) : key] });
    }
  }
}

class CompactExpander {
  private readonly used = new Set<string>();
  private readonly generated = new Set<string>();
  private readonly entityKind = new Map<string, string>();
  private readonly entityMentions = new Map<string, AnchorValue[]>();
  private readonly mentionOwner = new Map<string, string>();
  private next = 0;
  constructor(private readonly meter: SourceSemanticResourceLedger) {}

  expand(content: ContentValue) {
    this.collectKeys(content);
    this.bindDeclaredEntities(content);
    return {
      roots: content.roots.map((root, index) => ({ act: root.act, expression: this.expression(root.expression, ["content", "roots", index, "expression"]) })),
      ...(content.domains === undefined ? {} : { domains: content.domains.map((row, index) => this.domain(row, ["content", "domains", index])) }),
      ...(content.measurements === undefined ? {} : { measurements: content.measurements.map((row, index) => this.measurement(row, ["content", "measurements", index])) }),
      gaps: (content.gaps ?? []).map((row, index) => ({ ...row, evidence: this.support(row.evidence, ["content", "gaps", index, "evidence"]) }))
    };
  }

  private collectKeys(value: unknown): void {
    const stack: unknown[] = [value];
    while (stack.length > 0) {
      const row = stack.pop();
      if (row === null || typeof row !== "object") continue;
      if (Array.isArray(row)) { stack.push(...row); continue; }
      const object = row as Record<string, unknown>;
      if (typeof object.key === "string") this.used.add(object.key);
      stack.push(...Object.values(object));
    }
  }

  private bindDeclaredEntities(value: unknown): void {
    const stack: unknown[] = [value];
    while (stack.length > 0) {
      const row = stack.pop();
      if (row === null || typeof row !== "object") continue;
      if (Array.isArray(row)) { stack.push(...row); continue; }
      const object = row as Record<string, unknown>;
      if (isDeclaredEntity(object) && typeof object.key === "string") {
        const mentions = this.inlineMentions(object, ["content"]);
        if (mentions.length > 0) {
          const kind = typeof object.referent_kind === "string" ? object.referent_kind : "grouped";
          this.bindOwners(object.key, kind, mentions, ["content"]);
        }
      }
      stack.push(...Object.values(object));
    }
  }

  private alias(): string {
    let key: string;
    do { key = `h${this.next++}`; } while (this.used.has(key));
    this.used.add(key); this.generated.add(key); return key;
  }

  private expression(value: ExpressionValue, path: Path): object {
    this.meter.charge(1, 256, "compact expression expansion");
    const key = typeof value.key === "string" ? value.key : this.alias();
    const record = value as Record<string, unknown>;
    if (value.kind === "statement") {
      const args = (record.arguments as readonly Record<string, unknown>[]) ?? [];
      return { kind: "statement", key, predicate: this.predicate(record.predicate, [...path, "predicate"]),
        arguments: args.map((argument, index) => this.argument(argument, [...path, "arguments", index])) };
    }
    const evidence = this.requiredEvidence(record, path);
    const base = { key, evidence };
    if (value.kind === "conditional") return { kind: "conditional", ...base,
      antecedent: this.operand(record.antecedent, [...path, "antecedent"]), consequent: this.operand(record.consequent, [...path, "consequent"]) };
    if (value.kind === "opaque") return { kind: "opaque", ...base,
      operands: (record.operands as unknown[]).map((operand, n) => this.operand(operand, [...path, "operands", n])) };
    const nested = { kind: value.kind, ...base, content: this.operand(record.content, [...path, "content"]) };
    if (value.kind === "reported" && record.reporter !== undefined) {
      return { ...nested, reporter: this.entity(record.reporter, [...path, "reporter"]) };
    }
    if (value.kind === "forall") return { ...nested, domain: record.domain,
      restriction: record.restriction === null ? null : this.operand(record.restriction, [...path, "restriction"]) };
    return nested;
  }

  private operand(value: unknown, path: Path): object {
    const record = asRecord(value, path);
    if (record.kind === "content_reference") return record;
    return this.expression(record as ExpressionValue, path);
  }

  private argument(value: Record<string, unknown>, path: Path) {
    if (value.evidence !== undefined && value.at !== undefined) {
      invalid([...path, "at"], "conflicting_source_support", "", "Argument at and evidence cannot both be present.");
    }
    const target = this.target(value.target, [...path, "target"]);
    const evidence = value.evidence !== undefined ? this.support(value.evidence, [...path, "evidence"])
      : value.at !== undefined ? [this.anchor(value.at, [...path, "at"])]
      : this.inlineMentions(value.target, [...path, "target"]);
    return { role: value.role, target, evidence };
  }

  private target(value: unknown, path: Path): object {
    if (value === null || value === undefined) invalid(path, "missing_target", "", "Argument target is required.");
    if (isAnchor(value)) return this.entity(value, path);
    const record = asRecord(value, path);
    if (record.kind === "unresolved" || record.kind === "reference" || record.kind === "content_reference"
      || record.kind === "bound_variable") return record;
    if (typeof record.kind === "string" && EXPRESSION_KINDS.has(record.kind)) {
      return { kind: "content", expression: this.expression(record as ExpressionValue, path) };
    }
    return this.entity(record, path);
  }

  private entity(value: unknown, path: Path): object {
    const mentions = this.inlineMentions(value, path);
    const record = typeof value === "string" ? undefined : asRecord(value, path);
    const kind = typeof record?.referent_kind === "string" ? record.referent_kind : "grouped";
    const producer = typeof record?.key === "string" ? record.key : undefined;
    const key = this.entityKey(mentions, kind, path, producer);
    return { kind: "entity", key, referent_kind: kind, mentions: this.entityMentions.get(key) ?? mentions };
  }

  private entityKey(mentions: readonly AnchorValue[], kind: string, path: Path, producer?: string): string {
    const owners = [...new Set(mentions.map((row) => this.mentionOwner.get(fingerprint(row))).filter((row): row is string => row !== undefined))];
    if (producer !== undefined) {
      if (owners.some((owner) => owner !== producer && !this.isGenerated(owner))) {
        invalid(path, "duplicate_semantic_key", producer, "The same source mention cannot name distinct producer aliases.");
      }
      this.bindEntity(producer, kind, mentions, path); return producer;
    }
    if (owners.length > 1) invalid(path, "duplicate_semantic_key", owners[0]!, "Unkeyed mentions collide across distinct entities.");
    if (owners.length === 1) { this.bindEntity(owners[0]!, kind, mentions, path); return owners[0]!; }
    const key = this.alias(); this.bindEntity(key, kind, mentions, path); return key;
  }

  private bindOwners(key: string, kind: string, mentions: readonly AnchorValue[], path: Path): void {
    const previous = this.entityKind.get(key);
    if (previous !== undefined && previous !== kind) invalid([...path, "referent_kind"], "conflicting_referent_kind", key, "Repeated entity key has incompatible referent kinds.");
    this.entityKind.set(key, kind);
    for (const mention of mentions) {
      const seen = fingerprint(mention), owner = this.mentionOwner.get(seen);
      if (owner !== undefined && owner !== key && !this.isGenerated(owner)) {
        invalid(path, "duplicate_semantic_key", key, "The same source mention cannot name distinct producer aliases.");
      }
      this.mentionOwner.set(seen, key);
    }
  }

  private bindEntity(key: string, kind: string, mentions: readonly AnchorValue[], path: Path): void {
    this.bindOwners(key, kind, mentions, path);
    const list = this.entityMentions.get(key) ?? [];
    for (const mention of mentions) {
      const seen = fingerprint(mention);
      if (!list.some((row) => fingerprint(row) === seen)) list.push(mention);
    }
    this.entityMentions.set(key, list);
  }

  private isGenerated(key: string): boolean { return this.generated.has(key); }

  private predicate(value: unknown, path: Path) {
    const record = asRecord(value, path);
    return { kind: record.kind, reading: record.reading, evidence: this.requiredEvidence(record, path) };
  }

  private requiredEvidence(record: Record<string, unknown>, path: Path): AnchorValue[] {
    if (record.evidence !== undefined && record.at !== undefined) {
      invalid([...path, "at"], "conflicting_source_support", "", "at and evidence cannot both be present.");
    }
    if (record.evidence !== undefined) return this.support(record.evidence, [...path, "evidence"]);
    if (record.at !== undefined) return [this.anchor(record.at, [...path, "at"])];
    invalid(path, "missing_source_support", String(record.key ?? ""), "Predicate and operator support must select source evidence.");
  }

  private domain(value: z.infer<typeof Domain>, path: Path) {
    return { ...value, support: this.support(value.support, [...path, "support"]),
      members: value.members.map((row, index) => ({ ...row, referent: this.entity(row.referent, [...path, "members", index, "referent"]) })),
      exclusions: value.exclusions.map((row, index) => ({ ...row, referent: this.entity(row.referent, [...path, "exclusions", index, "referent"]) })) };
  }

  private measurement(value: z.infer<typeof Measurement>, path: Path) {
    return { ...value, subject: this.entity(value.subject, [...path, "subject"]), support: this.support(value.support, [...path, "support"]) };
  }

  private support(value: unknown, path: Path): AnchorValue[] {
    return (Array.isArray(value) ? value : [value]).map((row, index) => this.anchor(row, [...path, index]));
  }

  private inlineMentions(value: unknown, path: Path): AnchorValue[] {
    if (isAnchor(value)) return [this.anchor(value, path)];
    if (value === null || typeof value !== "object") return [];
    const record = value as Record<string, unknown>;
    if (record.at !== undefined && Array.isArray(record.mentions)) {
      invalid(path, "conflicting_source_support", "", "Named entity at and mentions cannot both be present.");
    }
    if (record.at !== undefined) return [this.anchor(record.at, [...path, "at"])];
    if (Array.isArray(record.mentions)) {
      return record.mentions.map((row, index) => this.anchor(row, [...path, "mentions", index]));
    }
    return [];
  }

  private anchor(value: unknown, path: Path): AnchorValue {
    if (typeof value === "string") {
      const match = /^a([1-9][0-9]*)s[0-9]+$/u.exec(value);
      if (match === null) invalid(path, "invalid_source_anchor", value, "Compact source anchor must be a catalog segment id.");
      return { assertion_id: Number(match[1]), source_ref: { first: value, last: value } };
    }
    const record = asRecord(value, path);
    if (typeof record.first === "string" && typeof record.last === "string" && record.assertion_id === undefined) {
      const first = /^a([1-9][0-9]*)s[0-9]+$/u.exec(record.first), last = /^a([1-9][0-9]*)s[0-9]+$/u.exec(record.last);
      if (first === null || last === null || first[1] !== last[1]) {
        invalid(path, "invalid_source_anchor", record.first, "Compact span anchors must stay inside one assertion.");
      }
      return { assertion_id: Number(first[1]), source_ref: { first: record.first, last: record.last } };
    }
    if (typeof record.assertion_id === "number" && record.source_ref !== undefined) {
      return FullAnchor.parse(record);
    }
    invalid(path, "invalid_source_anchor", "", "Source support must select a catalog segment.");
  }
}

const EXPRESSION_KINDS = new Set(["statement", "not", "possible", "reported", "conditional", "forall", "opaque"]);

function isDeclaredEntity(object: Record<string, unknown>): boolean {
  if (object.kind === "entity") return true;
  return typeof object.key === "string" && object.kind === undefined && (object.at !== undefined || object.mentions !== undefined);
}

function isAnchor(value: unknown): boolean {
  if (typeof value === "string") return true;
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.first === "string" && typeof record.last === "string" && record.kind === undefined && record.key === undefined
    || typeof record.assertion_id === "number" && record.source_ref !== undefined && record.kind === undefined;
}

function fingerprint(value: AnchorValue): string { return JSON.stringify(value); }

function asRecord(value: unknown, path: Path): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalid(path, "invalid_semantic_value", "", "Expected a semantic object.");
  return value as Record<string, unknown>;
}

function invalid(path: Path, code: string, reference: string, message: string): never {
  throw new z.ZodError([{ code: "custom", path, message, params: { diagnostic_code: code, reference } }]);
}
