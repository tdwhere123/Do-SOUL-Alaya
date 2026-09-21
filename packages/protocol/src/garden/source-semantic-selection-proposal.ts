import { z } from "zod";
import {
  SOURCE_SEMANTIC_GAP_KINDS, SOURCE_SEMANTIC_MAX_DEPTH, SOURCE_SEMANTIC_SOURCE_ACTS,
  SourceSemanticDecimalSchema, SourceSemanticReadingSchema
} from "./source-semantic-draft.js";
import {
  SOURCE_SEMANTIC_COMPACT_PROPOSAL_CONTRACT, materializeSourceSemanticCompactProposal
} from "./source-semantic-compact-proposal.js";
import { SourceSemanticOutcomeSchema, type SourceSemanticResponseEnvelope } from "./source-semantic-interpretation.js";
import { SourceSemanticResourceExhausted, SourceSemanticResourceLedger } from "./source-semantic-resources.js";

export const SOURCE_SEMANTIC_SELECTION_PROPOSAL_CONTRACT = "source-semantic-proposal-v5" as const;
export const SOURCE_SEMANTIC_SELECTION_GENERATION_CONTRACT = "host-owned-selection-schema-v1" as const;
export const SOURCE_SEMANTIC_SELECTION_GENERATION_DEPTH = SOURCE_SEMANTIC_MAX_DEPTH;
export const SOURCE_SEMANTIC_SELECTION_FEATURES = ["nested_expression", "quantified", "measurement"] as const;
/** Canonical coalesced spans retained after meaning-preserving merge; not a silent clip. */
export const SOURCE_SEMANTIC_SELECTION_SUPPORT_BOUND = 8 as const;
/** Producer list bound before coalescing contiguous scalars into spans. */
export const SOURCE_SEMANTIC_SELECTION_SUPPORT_LIST_BOUND = 64 as const;

const Key = z.string().min(1).max(64);
const SegmentId = z.string().regex(/^a[1-9][0-9]*s[0-9]+$/u).max(48);
const RangeAnchor = z.object({ first: SegmentId, last: SegmentId }).strict().readonly();
const SupportAtom = z.union([SegmentId, RangeAnchor]);
const SupportList = z.array(SupportAtom).min(1).max(SOURCE_SEMANTIC_SELECTION_SUPPORT_LIST_BOUND).readonly();
const Support = z.union([SupportAtom, SupportList]);
const ReferentKind = z.enum(["grouped", "unresolved", "unexpressed", "ambiguous"]);
const Entity = z.object({
  kind: z.literal("entity"), key: Key.optional(), referent_kind: ReferentKind.optional(),
  mentions: z.array(SupportAtom).min(1).max(64).readonly()
}).strict().readonly();
const ContentReference = z.object({ kind: z.literal("content_reference"), key: Key }).strict().readonly();
const Occurrence = z.object({ kind: z.literal("occurrence"), key: Key }).strict().readonly();
const OperatorFields = { key: Key.optional(), support: Support };
const Predicate = z.object({
  kind: z.enum(["explicit", "implicit"]), reading: SourceSemanticReadingSchema, support: Support
}).strict().readonly();
type Path = (string | number)[];
type ExpressionValue = Readonly<{ kind: string; key?: string }>;
type TargetValue = unknown;
type OperandValue = ExpressionValue | z.infer<typeof ContentReference>;
type SurfaceAtom = string | { readonly first: string; readonly last: string };
type Derived = Readonly<{ assertion_id: number; first: string; last: string; firstOrd: number; lastOrd: number }>;

function targetShape(expression?: z.ZodType<ExpressionValue>): z.ZodType<TargetValue> {
  const leaves = [SegmentId, RangeAnchor, Entity, Occurrence, ContentReference,
    z.object({ kind: z.literal("bound_variable"), quantifier: Key }).strict().readonly(),
    z.object({ kind: z.literal("unresolved") }).strict().readonly()] as const;
  return expression === undefined ? z.union(leaves) : z.union([...leaves, expression]);
}
function expressionShape(target: z.ZodType<TargetValue>, operand: z.ZodType<OperandValue>): z.ZodType<ExpressionValue> {
  return z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("statement"), key: Key.optional(), predicate: Predicate,
      arguments: z.array(z.object({ role: SourceSemanticReadingSchema, target, support: Support.optional()
      }).strict().readonly()).max(8).readonly()
    }).strict().readonly(),
    z.object({ kind: z.literal("not"), ...OperatorFields, content: operand }).strict().readonly(),
    z.object({ kind: z.literal("possible"), ...OperatorFields, content: operand }).strict().readonly(),
    z.object({ kind: z.literal("reported"), ...OperatorFields, content: operand, reporter: z.union([SegmentId, RangeAnchor, Entity]).optional() }).strict().readonly(),
    z.object({ kind: z.literal("conditional"), ...OperatorFields, antecedent: operand, consequent: operand }).strict().readonly(),
    z.object({ kind: z.literal("opaque"), ...OperatorFields, operands: z.array(operand).min(1).max(8).readonly() }).strict().readonly(),
    z.object({ kind: z.literal("forall"), key: Key, domain: Key, restriction: operand.nullable(), content: operand,
      support: Support }).strict().readonly()
  ]);
}
const Expression: z.ZodType<ExpressionValue> = z.lazy(() => expressionShape(Target, Operand));
const Target: z.ZodType<TargetValue> = z.lazy(() => targetShape(Expression));
const Operand: z.ZodType<OperandValue> = z.lazy(() => z.union([ContentReference, Expression]));
const Domain = z.object({
  key: Key, context: Key.nullable(), support: Support,
  members: z.array(z.object({ referent: z.union([SegmentId, RangeAnchor, Entity]), evidence: Key, restrictions: z.array(
    z.object({ restriction: Key, evidence: Key }).strict().readonly()).max(16).readonly() }).strict().readonly()).max(64).readonly(),
  exclusions: z.array(z.object({ referent: z.union([SegmentId, RangeAnchor, Entity]), evidence: Key }).strict().readonly()).max(64).readonly(),
  closure: z.discriminatedUnion("kind", [z.object({ kind: z.literal("open") }).strict().readonly(),
    z.object({ kind: z.literal("closed"), evidence: Key }).strict().readonly()])
}).strict().readonly();
const Measurement = z.object({
  key: Key, subject: z.union([SegmentId, RangeAnchor, Entity]), owner: Key, population: Key,
  metric: SourceSemanticReadingSchema, unit: SourceSemanticReadingSchema, context: SourceSemanticReadingSchema,
  value: SourceSemanticDecimalSchema, support: Support
}).strict().readonly();
function contentShape(expression: z.ZodType<ExpressionValue>) {
  return z.object({
    roots: z.array(z.object({ act: z.enum(SOURCE_SEMANTIC_SOURCE_ACTS), expression }).strict().readonly()).max(512).readonly(),
    domains: z.array(Domain).max(64).readonly().optional(),
    measurements: z.array(Measurement).max(256).readonly().optional(),
    gaps: z.array(z.object({ kind: z.enum(SOURCE_SEMANTIC_GAP_KINDS), support: Support,
      affected: z.array(Key).max(56).readonly().optional(), description: z.string().min(1).max(1024).optional()
    }).strict().readonly()).max(256).readonly().optional()
  }).strict().readonly();
}
const Content = contentShape(Expression);
const Outcome = z.discriminatedUnion("status", [z.object({ status: z.literal("interpreted") }).strict().readonly(),
  ...SourceSemanticOutcomeSchema.options.filter(option => option.unwrap().shape.status.value !== "interpreted")]);
const SelectionProposal = z.object({
  contract: z.literal(SOURCE_SEMANTIC_SELECTION_PROPOSAL_CONTRACT),
  outcome: Outcome, content: Content.optional()
}).strict().readonly();
type ContentValue = z.infer<typeof Content>;

/** Recursive decoder guidance. Unfolded compact-v4 remains too large for structured decode; this schema is the complete local contract. */
export const SourceSemanticSelectionGenerationSchema = SelectionProposal;

export const SourceSemanticSelectionProposalSchema = z.preprocess((value, context) => {
  const meter = new SourceSemanticResourceLedger({ work_units: 200000, memory_bytes: 20000000 });
  try {
    materializeSourceSemanticSelectionProposal(value, meter);
    meter.retain(value, "selection schema output validation");
    return value;
  } catch (error) {
    if (!(error instanceof z.ZodError)) throw error;
    for (const issue of error.issues) context.addIssue({ ...issue });
    return z.NEVER;
  }
}, SelectionProposal);

export function materializeSourceSemanticSelectionProposal(value: unknown,
  meter = new SourceSemanticResourceLedger({ work_units: 200000, memory_bytes: 20000000 })): SourceSemanticResponseEnvelope {
  preflight(value, meter);
  const proposal = SelectionProposal.parse(value);
  if ((proposal.outcome.status === "interpreted") !== (proposal.content !== undefined)) {
    invalid(["content"], "outcome_content_mismatch", "", "Interpreted outcome requires content; other outcomes must not carry content.");
  }
  const compact = {
    contract: SOURCE_SEMANTIC_COMPACT_PROPOSAL_CONTRACT, outcome: proposal.outcome,
    ...(proposal.content === undefined ? {} : { content: new SelectionLowerer(meter).lower(proposal.content) })
  };
  meter.retain(compact, "selection compact lowering");
  return materializeSourceSemanticCompactProposal(compact, meter);
}

function preflight(value: unknown, meter: SourceSemanticResourceLedger): void {
  meter.retain(value, "selection proposal input");
  const stack = [{ value, depth: 0, expressionDepth: 0, path: [] as Path }];
  const kinds = new Set(["statement", "not", "possible", "reported", "conditional", "forall", "opaque"]);
  while (stack.length > 0) {
    const row = stack.pop()!;
    meter.charge(1, 0, "selection depth preflight");
    if (row.depth > 8 * SOURCE_SEMANTIC_MAX_DEPTH + 32) throw new SourceSemanticResourceExhausted("selection input nesting");
    if (row.value === null || typeof row.value !== "object") continue;
    const object = row.value as Record<string, unknown>;
    const depth = row.expressionDepth + (typeof object.kind === "string" && kinds.has(object.kind) ? 1 : 0);
    if (depth > SOURCE_SEMANTIC_MAX_DEPTH + 1) {
      invalid(row.path, "expression_depth_exceeded", String(object.key ?? ""), "Expression nesting exceeds canonical domination depth.");
    }
    for (const [key, child] of Object.entries(object)) {
      meter.charge(0, 64 + 16 * (row.path.length + 1), "selection preflight stack");
      stack.push({ value: child, depth: row.depth + 1, expressionDepth: depth,
        path: [...row.path, Array.isArray(row.value) ? Number(key) : key] });
    }
  }
}

class SelectionLowerer {
  constructor(private readonly meter: SourceSemanticResourceLedger) {}

  lower(content: ContentValue) {
    return {
      roots: content.roots.map((root, index) => ({
        act: root.act, expression: this.expression(root.expression, ["content", "roots", index, "expression"])
      })),
      ...(content.domains === undefined ? {} : { domains: content.domains.map((row, index) => this.domain(row, ["content", "domains", index])) }),
      ...(content.measurements === undefined ? {} : {
        measurements: content.measurements.map((row, index) => this.measurement(row, ["content", "measurements", index]))
      }),
      ...(content.gaps === undefined ? {} : { gaps: content.gaps.map((row, index) => ({
        kind: row.kind, evidence: this.support(row.support, ["content", "gaps", index, "support"], SOURCE_SEMANTIC_SELECTION_SUPPORT_BOUND),
        ...(row.affected === undefined ? {} : { affected: row.affected }),
        ...(row.description === undefined ? {} : { description: row.description })
      })) })
    };
  }

  private expression(value: ExpressionValue, path: Path): object {
    this.meter.charge(1, 256, "selection expression lowering");
    const record = value as Record<string, unknown>;
    if (value.kind === "statement") {
      const args = (record.arguments as readonly Record<string, unknown>[]) ?? [];
      return {
        kind: "statement", ...(typeof value.key === "string" ? { key: value.key } : {}),
        predicate: this.predicate(record.predicate, [...path, "predicate"]),
        arguments: args.map((argument, index) => this.argument(argument, [...path, "arguments", index]))
      };
    }
    const support = this.supportFields(record.support, [...path, "support"]);
    const base = { ...(typeof value.key === "string" ? { key: value.key } : {}), ...support };
    if (value.kind === "conditional") {
      return { kind: "conditional", ...base, antecedent: this.operand(record.antecedent, [...path, "antecedent"]),
        consequent: this.operand(record.consequent, [...path, "consequent"]) };
    }
    if (value.kind === "opaque") {
      return { kind: "opaque", ...base,
        operands: (record.operands as unknown[]).map((operand, n) => this.operand(operand, [...path, "operands", n])) };
    }
    const nested = { kind: value.kind, ...base, content: this.operand(record.content, [...path, "content"]) };
    if (value.kind === "reported" && record.reporter !== undefined) {
      return { ...nested, reporter: this.referent(record.reporter, [...path, "reporter"]) };
    }
    if (value.kind === "forall") {
      return { ...nested, domain: record.domain,
        restriction: record.restriction === null ? null : this.operand(record.restriction, [...path, "restriction"]) };
    }
    return nested;
  }

  private operand(value: unknown, path: Path): object {
    const record = asRecord(value, path);
    if (record.kind === "content_reference") return record;
    return this.expression(record as ExpressionValue, path);
  }

  private argument(value: Record<string, unknown>, path: Path) {
    return {
      role: value.role, target: this.target(value.target, [...path, "target"]),
      ...(value.support === undefined ? {} : this.supportFields(value.support, [...path, "support"]))
    };
  }

  private target(value: unknown, path: Path): unknown {
    if (isAnchor(value)) return value;
    const record = asRecord(value, path);
    if (record.kind === "occurrence") return { kind: "reference", key: record.key };
    if (record.kind === "unresolved" || record.kind === "content_reference" || record.kind === "bound_variable") return record;
    if (typeof record.kind === "string" && EXPRESSION_KINDS.has(record.kind)) {
      return this.expression(record as ExpressionValue, path);
    }
    return this.referent(record, path);
  }

  private referent(value: unknown, path: Path): unknown {
    if (isAnchor(value)) return value;
    const record = asRecord(value, path);
    if (record.kind !== "entity" && record.kind !== undefined) {
      invalid(path, "invalid_semantic_value", String(record.kind), "Expected an entity or source selection.");
    }
    const mentions = Array.isArray(record.mentions)
      ? this.support(record.mentions, [...path, "mentions"], 64)
      : undefined;
    return {
      kind: "entity", ...(typeof record.key === "string" ? { key: record.key } : {}),
      ...(typeof record.referent_kind === "string" ? { referent_kind: record.referent_kind } : {}),
      ...(mentions === undefined ? {} : { mentions })
    };
  }

  private predicate(value: unknown, path: Path) {
    const record = asRecord(value, path);
    return { kind: record.kind, reading: record.reading, ...this.supportFields(record.support, [...path, "support"]) };
  }

  private domain(value: z.infer<typeof Domain>, path: Path) {
    return {
      ...value, support: this.support(value.support, [...path, "support"], SOURCE_SEMANTIC_SELECTION_SUPPORT_BOUND),
      members: value.members.map((row, index) => ({ ...row, referent: this.referent(row.referent, [...path, "members", index, "referent"]) })),
      exclusions: value.exclusions.map((row, index) => ({ ...row, referent: this.referent(row.referent, [...path, "exclusions", index, "referent"]) }))
    };
  }

  private measurement(value: z.infer<typeof Measurement>, path: Path) {
    return { ...value, subject: this.referent(value.subject, [...path, "subject"]),
      support: this.support(value.support, [...path, "support"], SOURCE_SEMANTIC_SELECTION_SUPPORT_BOUND) };
  }

  private supportFields(value: unknown, path: Path): { at: SurfaceAtom } | { evidence: SurfaceAtom[] } {
    const selected = this.support(value, path, SOURCE_SEMANTIC_SELECTION_SUPPORT_BOUND);
    return selected.length === 1 ? { at: selected[0]! } : { evidence: selected };
  }

  private support(value: unknown, path: Path, bound: number): SurfaceAtom[] {
    const atoms = (Array.isArray(value) ? value : [value]).map((row, index) => this.derive(row, [...path, index]));
    const merged = coalesce(atoms);
    if (merged.length > bound) {
      invalid(path, "source_support_limit", "", `Discontiguous source support exceeds the ${bound}-span bound; contiguous text must use one span.`);
    }
    return merged.map(surface);
  }

  private derive(value: unknown, path: Path): Derived {
    if (typeof value === "string") {
      const parsed = parseSegment(value);
      if (parsed === undefined) invalid(path, "invalid_source_anchor", value, "Selection support must be a catalog segment id.");
      return { assertion_id: parsed.assertion, first: value, last: value, firstOrd: parsed.ordinal, lastOrd: parsed.ordinal };
    }
    const record = asRecord(value, path);
    if (typeof record.first !== "string" || typeof record.last !== "string" || record.assertion_id !== undefined) {
      invalid(path, "invalid_source_anchor", "", "Selection support must be a catalog segment or a span.");
    }
    const first = parseSegment(record.first), last = parseSegment(record.last);
    if (first === undefined || last === undefined || first.assertion !== last.assertion || first.ordinal > last.ordinal) {
      invalid(path, "invalid_source_anchor", record.first, "Selection spans must stay inside one assertion in order.");
    }
    return { assertion_id: first.assertion, first: record.first, last: record.last, firstOrd: first.ordinal, lastOrd: last.ordinal };
  }
}

const EXPRESSION_KINDS = new Set(["statement", "not", "possible", "reported", "conditional", "forall", "opaque"]);

function parseSegment(value: string): { assertion: number; ordinal: number } | undefined {
  const match = /^a([1-9][0-9]*)s([0-9]+)$/u.exec(value);
  return match === null ? undefined : { assertion: Number(match[1]), ordinal: Number(match[2]) };
}

function coalesce(atoms: readonly Derived[]): Derived[] {
  const unique: Derived[] = [];
  const seen = new Set<string>();
  for (const row of atoms) {
    const key = `${row.assertion_id}:${row.first}:${row.last}`;
    if (seen.has(key)) continue;
    seen.add(key); unique.push(row);
  }
  unique.sort((left, right) => left.assertion_id - right.assertion_id || left.firstOrd - right.firstOrd || left.lastOrd - right.lastOrd);
  const merged: Derived[] = [];
  for (const row of unique) {
    const previous = merged[merged.length - 1];
    if (previous !== undefined && previous.assertion_id === row.assertion_id && row.firstOrd <= previous.lastOrd + 1) {
      if (row.lastOrd > previous.lastOrd) {
        merged[merged.length - 1] = { ...previous, last: row.last, lastOrd: row.lastOrd };
      }
      continue;
    }
    merged.push(row);
  }
  return merged;
}

function surface(value: Derived): SurfaceAtom {
  return value.first === value.last ? value.first : { first: value.first, last: value.last };
}

function isAnchor(value: unknown): boolean {
  if (typeof value === "string") return true;
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.first === "string" && typeof record.last === "string" && record.kind === undefined && record.key === undefined
    && record.assertion_id === undefined;
}

function asRecord(value: unknown, path: Path): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalid(path, "invalid_semantic_value", "", "Expected a semantic object.");
  return value as Record<string, unknown>;
}

function invalid(path: Path, code: string, reference: string, message: string): never {
  throw new z.ZodError([{ code: "custom", path, message, params: { diagnostic_code: code, reference } }]);
}
