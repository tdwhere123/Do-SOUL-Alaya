import { z } from "zod";
import {
  SOURCE_SEMANTIC_GAP_KINDS, SOURCE_SEMANTIC_MAX_DEPTH, SOURCE_SEMANTIC_SOURCE_ACTS,
  SourceSemanticDecimalSchema, SourceSemanticReadingSchema
} from "./source-semantic-draft.js";
import { compileSourceSemanticCompact } from "./source-semantic-compact-lowering.js";
import { SourceSemanticOutcomeSchema, SourceSemanticNoPropositionOutcomeSchema, type SourceSemanticResponseEnvelope } from "./source-semantic-interpretation.js";
import { SourceAssertionIdSchema, SourceOccurrenceSchema } from "../evidence/source-selection.js";
import { sourceReferenceResolver, sourceReferencePreparationCost, type SourceReferenceCatalog } from "../evidence/source-reference.js";
import type { FieldContractSha256 } from "../recall/field-contract/canonical-identity.js";
import { SourceSemanticResourceExhausted, SourceSemanticResourceLedger } from "./source-semantic-resources.js";

/** Canonical coalesced spans retained after meaning-preserving merge; not a silent clip. */
export const SOURCE_SEMANTIC_SELECTION_SUPPORT_BOUND = 8 as const;
/** Producer list bound before coalescing adjacent support into spans. */
export const SOURCE_SEMANTIC_SELECTION_SUPPORT_LIST_BOUND = 64 as const;

const Key = z.string().min(1).max(64);
const SupportAtom = z.object({ assertion_id: SourceAssertionIdSchema,
  text: z.string().min(1).max(65536), occurrence: SourceOccurrenceSchema.optional() }).strict().readonly();
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
  const leaves = [SupportAtom, Entity, Occurrence, ContentReference,
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
    z.object({ kind: z.literal("reported"), ...OperatorFields, content: operand, reporter: z.union([SupportAtom, Entity]).optional() }).strict().readonly(),
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
  members: z.array(z.object({ referent: z.union([SupportAtom, Entity]), evidence: Key, restrictions: z.array(
    z.object({ restriction: Key, evidence: Key }).strict().readonly()).max(16).readonly() }).strict().readonly()).max(64).readonly(),
  exclusions: z.array(z.object({ referent: z.union([SupportAtom, Entity]), evidence: Key }).strict().readonly()).max(64).readonly(),
  closure: z.discriminatedUnion("kind", [z.object({ kind: z.literal("open") }).strict().readonly(),
    z.object({ kind: z.literal("closed"), evidence: Key }).strict().readonly()])
}).strict().readonly();
const Measurement = z.object({
  key: Key, subject: z.union([SupportAtom, Entity]), owner: Key, population: Key,
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
export const SourceSemanticSelectionContentShape = contentShape(Expression);
export const SourceSemanticSelectionOutcomeShape = z.discriminatedUnion("status", [z.object({ status: z.literal("interpreted") }).strict().readonly(),
  SourceSemanticNoPropositionOutcomeSchema.unwrap().extend({
    context_support: z.array(SupportAtom).min(1).max(8).readonly() }).strict().readonly(),
  ...SourceSemanticOutcomeSchema.options.filter(option => !["interpreted", "no_executable_proposition"].includes(option.unwrap().shape.status.value))]);
type ContentValue = z.infer<typeof SourceSemanticSelectionContentShape>;

/** Current table compiler phase: exact source text resolves to compact anchors. */
export function compileSourceSemanticSelection(contentValue: unknown, outcomeValue: unknown,
  binding: Readonly<{ catalog: SourceReferenceCatalog; sha256: FieldContractSha256 }>,
  meter: SourceSemanticResourceLedger): SourceSemanticResponseEnvelope {
  preflight({ outcome: outcomeValue, content: contentValue }, meter);
  const outcome = SourceSemanticSelectionOutcomeShape.parse(outcomeValue);
  if ((outcome.status === "interpreted") !== (contentValue !== undefined)) {
    invalid(["content"], "outcome_content_mismatch", "", "Interpreted outcome requires content; other outcomes must not carry content.");
  }
  const lowerer = contentValue !== undefined || outcome.status === "no_executable_proposition"
    ? new SelectionLowerer(binding, meter) : undefined;
  const loweredOutcome = outcome.status === "no_executable_proposition"
    ? { ...outcome, context_support: outcome.context_support.map((row, index) =>
      lowerer!.dispositionSupport(row, ["outcome", "context_support", index])) } : outcome;
  const compact = contentValue === undefined ? undefined : lowerer!.lower(SourceSemanticSelectionContentShape.parse(contentValue));
  meter.retain({ outcome: loweredOutcome, content: compact }, "selection compact lowering");
  return compileSourceSemanticCompact(compact, loweredOutcome, meter);
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
  private readonly resolver: ReturnType<typeof sourceReferenceResolver>;
  private readonly assertions: Map<number, string>;
  private readonly ordinals = new Map<string, number>();
  constructor(binding: Readonly<{ catalog: SourceReferenceCatalog; sha256: FieldContractSha256 }>,
    private readonly meter: SourceSemanticResourceLedger) {
    const assertions = binding.catalog.assertions.map(row => ({ assertion_id: row.assertion_id,
      text: row.segments.map(segment => segment.text).join("") }));
    const cost = sourceReferencePreparationCost(assertions);
    meter.charge(cost.work_units, cost.memory_bytes, "selection source reference preparation");
    this.resolver = sourceReferenceResolver(binding.catalog, binding.sha256);
    this.assertions = new Map(assertions.map(row => [row.assertion_id, row.text]));
    for (const row of binding.catalog.assertions) row.segments.forEach((segment, index) => this.ordinals.set(segment.id, index));
  }

  dispositionSupport(value: unknown, path: Path) {
    const { assertion_id, first, last } = this.derive(value, path);
    return { kind: "source_reference" as const, assertion_id, source_ref: { first, last } };
  }

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
    if (isSelection(value)) return this.referent(value, path);
    const record = asRecord(value, path);
    if (record.kind === "occurrence") return { kind: "reference", key: record.key };
    if (record.kind === "unresolved" || record.kind === "content_reference" || record.kind === "bound_variable") return record;
    if (typeof record.kind === "string" && EXPRESSION_KINDS.has(record.kind)) {
      return this.expression(record as ExpressionValue, path);
    }
    return this.referent(record, path);
  }

  private referent(value: unknown, path: Path): unknown {
    if (isSelection(value)) return { kind: "entity", mentions: this.support(value, path, 64) };
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
    const selection = SupportAtom.parse(value);
    const text = this.assertions.get(selection.assertion_id);
    if (text === undefined) invalid(path, "unknown_source_assertion", String(selection.assertion_id), "Selection requires a supplied assertion.");
    this.meter.charge(text.length + selection.text.length, 128, "exact source selection");
    const selected = this.resolver.selectExactText(selection.assertion_id, selection,
      (work, bytes) => this.meter.charge(work, bytes, "exact source selection indexing and candidates"));
    if ("reason" in selected) invalid(path, selected.reason === "unsupported_boundary"
      ? "unsupported_source_boundary" : `source_selection_${selected.reason}`, selection.text,
      "Exact source selection must identify one catalog-eligible occurrence within its assertion.");
    const reference = selected.reference;
    return { assertion_id: selection.assertion_id, ...reference,
      firstOrd: this.ordinals.get(reference.first)!, lastOrd: this.ordinals.get(reference.last)! };
  }
}

const EXPRESSION_KINDS = new Set(["statement", "not", "possible", "reported", "conditional", "forall", "opaque"]);

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

function isSelection(value: unknown): boolean {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && "assertion_id" in value && "text" in value;
}

function asRecord(value: unknown, path: Path): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalid(path, "invalid_semantic_value", "", "Expected a semantic object.");
  return value as Record<string, unknown>;
}

function invalid(path: Path, code: string, reference: string, message: string): never {
  throw new z.ZodError([{ code: "custom", path, message, params: { diagnostic_code: code, reference } }]);
}
