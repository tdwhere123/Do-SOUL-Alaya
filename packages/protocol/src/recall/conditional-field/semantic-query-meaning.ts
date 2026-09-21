import { z } from "zod";
import {
  SOURCE_SEMANTIC_MAX_BYTES, SOURCE_SEMANTIC_MAX_DEPTH, SourceSemanticGapSchema,
  SourceSemanticHandleSchema, SourceSemanticReadingSchema
} from "../../garden/source-semantic-draft.js";
import {
  SOURCE_SEMANTIC_QUERY_CONTRACT, SourceSemanticQueryEvaluationSchema, SourceSemanticQuerySchema,
  type SourceSemanticContextObligation, type SourceSemanticQuery, type SourceSemanticQueryAlternative,
  type SourceSemanticQueryFrame, type SourceSemanticQueryRoleRequirement, type SourceSemanticQueryVariable
} from "./semantic-query.js";

export const SOURCE_SEMANTIC_QUERY_MEANING_CONTRACT = "source-semantic-query-meaning-v1" as const;
export const SOURCE_SEMANTIC_QUERY_MEANING_MAX_DEPTH = Math.min(8, SOURCE_SEMANTIC_MAX_DEPTH);
export const SOURCE_SEMANTIC_QUERY_MEANING_GENERATION_DEPTH = 4;

const Key = SourceSemanticHandleSchema;
const Reading = SourceSemanticReadingSchema;
const Obligation = z.enum(["asserted_at_source", "entailed_at_source", "unresolved"]);
const SourceAct = z.enum(["question", "directive"]);

const FreeTarget = z.object({
  kind: z.literal("free"), key: Key, return: z.boolean().optional()
}).strict().readonly();
const NamedTarget = z.object({
  kind: z.literal("named"), key: Key, excerpt: z.string().min(1).max(1024), return: z.boolean().optional()
}).strict().readonly();
const LocalReference = z.object({ kind: z.literal("reference"), key: Key }).strict().readonly();
const EntityTarget = z.discriminatedUnion("kind", [FreeTarget, NamedTarget, LocalReference]);
const RoleArgument = z.object({
  role: Reading, target: EntityTarget, excerpt: z.string().min(1).max(1024).optional()
}).strict().readonly();
const Occurrence = z.object({ kind: z.literal("occurrence"), key: Key }).strict().readonly();

type Path = readonly (string | number)[];
type EntityTargetValue = z.infer<typeof EntityTarget>;
type RoleArgumentValue = z.infer<typeof RoleArgument>;
type ObligationKind = z.infer<typeof Obligation>;
type SourceActKind = z.infer<typeof SourceAct>;

export type QueryMeaning =
  | QueryStatementMeaning
  | QueryNotMeaning
  | QueryPossibleMeaning
  | QueryReportedMeaning
  | QueryConditionalMeaning
  | QueryOpaqueMeaning
  | QueryForallMeaning
  | QueryOccurrenceMeaning;

export type QueryStatementMeaning = Readonly<{
  readonly kind: "statement";
  readonly key?: string;
  readonly predicate: string;
  readonly arguments: readonly RoleArgumentValue[];
  readonly content?: QueryMeaning;
  readonly obligation?: ObligationKind;
  readonly source_act?: SourceActKind;
  readonly return?: boolean;
}>;
export type QueryNotMeaning = Readonly<{
  readonly kind: "not";
  readonly key?: string;
  readonly content: QueryMeaning;
  readonly obligation?: ObligationKind;
  readonly source_act?: SourceActKind;
}>;
export type QueryPossibleMeaning = Readonly<{
  readonly kind: "possible";
  readonly key?: string;
  readonly content: QueryMeaning;
  readonly obligation?: ObligationKind;
  readonly source_act?: SourceActKind;
}>;
export type QueryReportedMeaning = Readonly<{
  readonly kind: "reported";
  readonly key?: string;
  readonly content: QueryMeaning;
  readonly reporter?: EntityTargetValue;
  readonly obligation?: ObligationKind;
  readonly source_act?: SourceActKind;
}>;
export type QueryConditionalMeaning = Readonly<{
  readonly kind: "conditional";
  readonly key?: string;
  readonly antecedent: QueryMeaning;
  readonly consequent: QueryMeaning;
  readonly obligation?: ObligationKind;
  readonly source_act?: SourceActKind;
}>;
export type QueryOpaqueMeaning = Readonly<{
  readonly kind: "opaque";
  readonly key?: string;
  readonly operands: readonly QueryMeaning[];
  readonly obligation?: ObligationKind;
  readonly source_act?: SourceActKind;
}>;
export type QueryForallMeaning = Readonly<{
  readonly kind: "forall";
  readonly key?: string;
  readonly domain: string;
  readonly binder: string;
  readonly restriction?: QueryMeaning | null;
  readonly content: QueryMeaning;
  readonly obligation?: ObligationKind;
  readonly source_act?: SourceActKind;
}>;
export type QueryOccurrenceMeaning = Readonly<{ kind: "occurrence"; readonly key: string }>;

function meaningShape(inner?: z.ZodType<QueryMeaning>): z.ZodType<QueryMeaning> {
  const operand = inner ?? Occurrence;
  return z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("statement"), key: Key.optional(), predicate: Reading,
      arguments: z.array(RoleArgument).max(8).readonly(), content: operand.optional(),
      obligation: Obligation.optional(), source_act: SourceAct.optional(), return: z.boolean().optional()
    }).strict().readonly(),
    z.object({
      kind: z.literal("not"), key: Key.optional(), content: operand,
      obligation: Obligation.optional(), source_act: SourceAct.optional()
    }).strict().readonly(),
    z.object({
      kind: z.literal("possible"), key: Key.optional(), content: operand,
      obligation: Obligation.optional(), source_act: SourceAct.optional()
    }).strict().readonly(),
    z.object({
      kind: z.literal("reported"), key: Key.optional(), content: operand, reporter: EntityTarget.optional(),
      obligation: Obligation.optional(), source_act: SourceAct.optional()
    }).strict().readonly(),
    z.object({
      kind: z.literal("conditional"), key: Key.optional(), antecedent: operand, consequent: operand,
      obligation: Obligation.optional(), source_act: SourceAct.optional()
    }).strict().readonly(),
    z.object({
      kind: z.literal("opaque"), key: Key.optional(), operands: z.array(operand).min(1).max(8).readonly(),
      obligation: Obligation.optional(), source_act: SourceAct.optional()
    }).strict().readonly(),
    z.object({
      kind: z.literal("forall"), key: Key.optional(), domain: Key, binder: Key,
      restriction: operand.nullable().optional(), content: operand,
      obligation: Obligation.optional(), source_act: SourceAct.optional()
    }).strict().readonly(),
    Occurrence
  ]);
}

const Meaning: z.ZodType<QueryMeaning> = z.lazy(() => meaningShape(Meaning));

const Alternative = z.object({
  meaning: Meaning.optional(),
  purpose: z.enum(["support", "counterexample"]).optional()
}).strict().readonly();

const Domain = z.object({
  key: Key, excerpt: z.string().min(1).max(1024)
}).strict().readonly();

function bodyShape(meaning: z.ZodType<QueryMeaning>) {
  return z.object({
    contract: z.literal(SOURCE_SEMANTIC_QUERY_MEANING_CONTRACT),
    alternatives: z.array(z.object({
      meaning: meaning.optional(),
      purpose: z.enum(["support", "counterexample"]).optional()
    }).strict().readonly()).min(1).max(16).readonly(),
    gaps: z.array(SourceSemanticGapSchema).max(256).readonly(),
    return: z.array(Key).max(64).readonly().optional(),
    domains: z.array(Domain).max(64).readonly().optional(),
    evaluation: SourceSemanticQueryEvaluationSchema.optional()
  }).strict().readonly();
}

export const SourceSemanticQueryMeaningBodySchema = bodyShape(Meaning).superRefine((body, context) => {
  const comparison = body.evaluation?.kind === "comparison";
  for (const [index, alternative] of body.alternatives.entries()) {
    if (comparison && alternative.meaning !== undefined) {
      context.addIssue({ code: "custom", path: ["alternatives", index, "meaning"],
        message: "comparison uses typed operand scope; nested meaning is not supported" });
    }
    if (!comparison && alternative.meaning === undefined) {
      context.addIssue({ code: "custom", path: ["alternatives", index, "meaning"],
        message: "query body requires a meaning node" });
    }
  }
});

export const SourceSemanticQueryMeaningGenerationSchema = (() => {
  let meaning: z.ZodType<QueryMeaning> | undefined;
  for (let depth = SOURCE_SEMANTIC_QUERY_MEANING_GENERATION_DEPTH; depth >= 0; depth -= 1) {
    meaning = meaningShape(meaning);
  }
  return bodyShape(meaning!);
})();

export type SourceSemanticQueryMeaningBody = z.infer<typeof SourceSemanticQueryMeaningBodySchema>;

export type SourceSemanticQueryMeaningEnvelope = Readonly<{
  readonly original_query_digest: string;
  readonly producer_id: string;
  readonly producer_version: string;
}>;

/** Host graph construction. Does not repair a legacy producer graph. */
export function materializeSourceSemanticQueryMeaning(
  body: unknown, envelope: SourceSemanticQueryMeaningEnvelope
): SourceSemanticQuery {
  preflight(body);
  const parsed = SourceSemanticQueryMeaningBodySchema.parse(body);
  const compiled = new QueryMeaningCompiler().compile(parsed);
  return SourceSemanticQuerySchema.parse({
    contract: SOURCE_SEMANTIC_QUERY_CONTRACT,
    original_query_digest: envelope.original_query_digest,
    producer_id: envelope.producer_id,
    producer_version: envelope.producer_version,
    contract_version: SOURCE_SEMANTIC_QUERY_CONTRACT,
    variables: compiled.variables,
    alternatives: compiled.alternatives,
    return_variables: compiled.return_variables,
    gaps: parsed.gaps,
    ...(parsed.domains === undefined ? {} : {
      domains: parsed.domains.map((row) => ({
        id: row.key, support: { kind: "query_text" as const, excerpt: row.excerpt }
      }))
    }),
    ...(parsed.evaluation === undefined ? {} : { evaluation: parsed.evaluation })
  });
}

function preflight(value: unknown): void {
  if (new TextEncoder().encode(JSON.stringify(value)).length > SOURCE_SEMANTIC_MAX_BYTES) {
    fail([], "source semantic query exceeds its byte bound");
  }
  const stack: { value: unknown; depth: number; meaningDepth: number; path: Path }[] = [
    { value, depth: 0, meaningDepth: 0, path: [] }
  ];
  const kinds = new Set(["statement", "not", "possible", "reported", "conditional", "opaque", "forall"]);
  while (stack.length > 0) {
    const row = stack.pop()!;
    if (row.depth > 8 * SOURCE_SEMANTIC_QUERY_MEANING_MAX_DEPTH + 32) {
      fail(row.path, "query meaning nesting exceeds its bound");
    }
    if (row.value === null || typeof row.value !== "object") continue;
    const object = row.value as Record<string, unknown>;
    const meaningDepth = row.meaningDepth + (typeof object.kind === "string" && kinds.has(object.kind) ? 1 : 0);
    if (meaningDepth > SOURCE_SEMANTIC_QUERY_MEANING_MAX_DEPTH + 1) {
      fail(row.path, "query meaning nesting exceeds its bound");
    }
    for (const [key, child] of Object.entries(object)) {
      stack.push({
        value: child, depth: row.depth + 1, meaningDepth,
        path: [...row.path, Array.isArray(row.value) ? Number(key) : key]
      });
    }
  }
}

class QueryMeaningCompiler {
  private readonly sorts = new Map<string, "entity" | "proposition" | "context">();
  private readonly named = new Map<string, string>();
  private readonly returned = new Set<string>();
  private readonly frames = new Map<string, { variable: string; operator?: QueryMeaning["kind"] }>();
  private readonly used = new Set<string>();
  private readonly counters = new Map<string, number>();
  private readonly compiling = new Set<string>();

  compile(body: SourceSemanticQueryMeaningBody): {
    variables: SourceSemanticQueryVariable[];
    alternatives: SourceSemanticQueryAlternative[];
    return_variables: string[];
  } {
    this.collect(body);
    if (body.return !== undefined) {
      for (const key of body.return) this.markReturn(key, ["return"]);
    }
    const alternatives = body.alternatives.map((alternative, index) =>
      this.alternative(alternative, ["alternatives", index], body.evaluation?.kind === "comparison"));
    const variables: SourceSemanticQueryVariable[] = [...this.sorts.entries()].map(([id, sort]) => ({
      id, sort, ...(sort === "entity" && this.named.has(id)
        ? { reference: { kind: "query_text" as const, excerpt: this.named.get(id)! } } : {})
    }));
    if (variables.length === 0) fail(["alternatives"], "query meaning declares no variables");
    return { variables, alternatives, return_variables: [...this.returned] };
  }

  private collect(body: SourceSemanticQueryMeaningBody): void {
    for (const [index, alternative] of body.alternatives.entries()) {
      if (alternative.meaning !== undefined) this.collectMeaning(alternative.meaning, ["alternatives", index, "meaning"]);
    }
    for (const [index, domain] of (body.domains ?? []).entries()) this.reserve(domain.key, ["domains", index, "key"]);
    if (body.evaluation?.kind === "forall") {
      this.declareEntityKey(body.evaluation.binder, ["evaluation", "binder"]);
      this.reserve(body.evaluation.domain, ["evaluation", "domain"]);
    }
    if (body.evaluation?.kind === "comparison") {
      this.declareEntityKey(body.evaluation.left, ["evaluation", "left"]);
      if (body.evaluation.right !== undefined) this.declareEntityKey(body.evaluation.right, ["evaluation", "right"]);
    }
  }

  private collectMeaning(meaning: QueryMeaning, path: Path): void {
    if (meaning.kind === "occurrence") return;
    if (meaning.kind === "statement") {
      this.declareOccurrence(meaning.key, "proposition", path);
      for (const [index, argument] of meaning.arguments.entries()) {
        this.collectTarget(argument.target, [...path, "arguments", index, "target"]);
      }
      if (meaning.content !== undefined) this.collectMeaning(meaning.content, [...path, "content"]);
      if (meaning.return === true && meaning.key !== undefined) this.returned.add(meaning.key);
      return;
    }
    this.declareOccurrence(meaning.key, "context", path);
    if (meaning.kind === "reported" && meaning.reporter !== undefined) {
      this.collectTarget(meaning.reporter, [...path, "reporter"]);
    }
    if (meaning.kind === "conditional") {
      this.collectMeaning(meaning.antecedent, [...path, "antecedent"]);
      this.collectMeaning(meaning.consequent, [...path, "consequent"]);
      return;
    }
    if (meaning.kind === "opaque") {
      meaning.operands.forEach((operand, index) => this.collectMeaning(operand, [...path, "operands", index]));
      return;
    }
    if (meaning.kind === "forall") {
      this.declareEntityKey(meaning.binder, [...path, "binder"]);
      this.reserve(meaning.domain, [...path, "domain"]);
      if (meaning.restriction !== undefined && meaning.restriction !== null) {
        this.collectMeaning(meaning.restriction, [...path, "restriction"]);
      }
      this.collectMeaning(meaning.content, [...path, "content"]);
      return;
    }
    this.collectMeaning(meaning.content, [...path, "content"]);
  }

  private collectTarget(target: EntityTargetValue, path: Path): void {
    if (target.kind === "reference") return;
    this.declareEntityKey(target.key, path);
    if (target.kind === "named") {
      const previous = this.named.get(target.key);
      if (previous !== undefined && previous !== target.excerpt) {
        fail(path, "named constraint excerpt conflicts with an earlier declaration");
      }
      this.named.set(target.key, target.excerpt);
    }
    if (target.return === true) this.returned.add(target.key);
  }

  private alternative(
    alternative: z.infer<typeof Alternative>, path: Path, comparison: boolean
  ): SourceSemanticQueryAlternative {
    if (comparison) {
      return { frames: [], context_obligations: [], ...(alternative.purpose === undefined ? {} : { purpose: alternative.purpose }) };
    }
    const frames: SourceSemanticQueryFrame[] = [];
    const obligations: SourceSemanticContextObligation[] = [];
    this.compileMeaning(alternative.meaning!, [...path, "meaning"], frames, obligations, undefined);
    return {
      frames, context_obligations: obligations,
      ...(alternative.purpose === undefined ? {} : { purpose: alternative.purpose })
    };
  }

  private compileMeaning(
    meaning: QueryMeaning, path: Path, frames: SourceSemanticQueryFrame[],
    obligations: SourceSemanticContextObligation[],
    parent: Readonly<{ frame: string; operator?: string; role: "content" | "antecedent" | "consequent" | "restriction" }> | undefined
  ): string {
    if (meaning.kind === "occurrence") {
      const frame = this.frames.get(meaning.key);
      if (frame === undefined) fail(path, "undeclared local reference");
      this.link(meaning.key, parent, obligations);
      return meaning.key;
    }
    const frameId = this.occurrenceId(meaning.key, meaning.kind === "statement" ? "s" : "c", path);
    if (this.compiling.has(frameId)) fail(path, "cyclic local reference");
    this.compiling.add(frameId);
    const variable = frameId;
    if (meaning.kind === "statement" && meaning.return === true) this.returned.add(frameId);
    const operator = meaning.kind === "statement" ? undefined : meaning.kind === "forall" ? "forall"
      : meaning.kind === "opaque" ? "opaque" : meaning.kind === "conditional" ? "conditional"
      : meaning.kind === "reported" ? "reported" : meaning.kind === "possible" ? "possible" : "not";
    this.frames.set(frameId, { variable, ...(operator === undefined ? {} : { operator }) });
    const roleIds = new Set<string>();
    const roles: SourceSemanticQueryRoleRequirement[] = meaning.kind === "statement"
      ? meaning.arguments.map((argument, index) => this.role(argument, [...path, "arguments", index], roleIds))
      : meaning.kind === "reported" && meaning.reporter !== undefined
        ? [this.reporterRole(meaning.reporter, [...path, "reporter"], roleIds)]
        : [];
    frames.push({
      id: frameId, variable,
      predicate_reading: meaning.kind === "statement" ? meaning.predicate : meaning.kind,
      ...(operator === undefined ? {} : { operator }),
      role_requirements: roles,
      ...(meaning.source_act === undefined ? {} : { source_act: meaning.source_act })
    });
    if (parent === undefined) {
      obligations.push({ frame: frameId, kind: meaning.obligation ?? "asserted_at_source" });
    } else {
      this.link(frameId, parent, obligations);
      if (meaning.obligation !== undefined) obligations.push({ frame: frameId, kind: meaning.obligation });
    }
    if (meaning.kind === "statement" && meaning.content !== undefined) {
      this.compileMeaning(meaning.content, [...path, "content"], frames, obligations,
        { frame: frameId, role: "content" });
    } else if (meaning.kind === "conditional") {
      this.compileMeaning(meaning.antecedent, [...path, "antecedent"], frames, obligations,
        { frame: frameId, operator: "conditional", role: "antecedent" });
      this.compileMeaning(meaning.consequent, [...path, "consequent"], frames, obligations,
        { frame: frameId, operator: "conditional", role: "consequent" });
    } else if (meaning.kind === "opaque") {
      meaning.operands.forEach((operand, index) => this.compileMeaning(operand, [...path, "operands", index],
        frames, obligations, { frame: frameId, operator: "opaque", role: "content" }));
    } else if (meaning.kind === "forall") {
      if (meaning.restriction !== undefined && meaning.restriction !== null) {
        this.compileMeaning(meaning.restriction, [...path, "restriction"], frames, obligations,
          { frame: frameId, operator: "forall", role: "restriction" });
      }
      this.compileMeaning(meaning.content, [...path, "content"], frames, obligations,
        { frame: frameId, operator: "forall", role: "content" });
    } else if (meaning.kind !== "statement") {
      this.compileMeaning(meaning.content, [...path, "content"], frames, obligations,
        { frame: frameId, operator: meaning.kind, role: "content" });
    }
    this.compiling.delete(frameId);
    return frameId;
  }

  private link(
    frame: string,
    parent: Readonly<{ frame: string; operator?: string; role: "content" | "antecedent" | "consequent" | "restriction" }> | undefined,
    obligations: SourceSemanticContextObligation[]
  ): void {
    if (parent === undefined) return;
    if (parent.frame === frame) fail(["incidence"], "query incidence cannot govern itself");
    obligations.push({
      frame,
      kind: "explicit_embedded_structure",
      incidence: {
        kind: parent.operator === undefined ? "embedding" : "operator_operand",
        other_frame: parent.frame,
        role: parent.role
      }
    });
  }

  private role(
    argument: RoleArgumentValue, path: Path, used: Set<string>
  ): SourceSemanticQueryRoleRequirement {
    const target = this.entityId(argument.target, [...path, "target"]);
    const excerpt = argument.excerpt ?? (argument.target.kind === "named" ? argument.target.excerpt : undefined);
    if (excerpt === undefined) fail(path, "role argument requires query text support");
    const id = this.roleId(argument.role, used);
    return {
      id, role_reading: argument.role, target_variable: target,
      support: { kind: "query_text", excerpt }
    };
  }

  private reporterRole(
    target: EntityTargetValue, path: Path, used: Set<string>
  ): SourceSemanticQueryRoleRequirement {
    used.add("reporter");
    const excerpt = target.kind === "named" ? target.excerpt : target.kind === "free" ? target.key : undefined;
    if (excerpt === undefined) fail(path, "reporter requires a declared entity");
    return {
      id: "reporter", role_reading: "reporter", target_variable: this.entityId(target, path),
      support: { kind: "query_text", excerpt }
    };
  }

  private entityId(target: EntityTargetValue, path: Path): string {
    if (target.kind === "reference") {
      if (this.sorts.get(target.key) !== "entity") fail(path, "undeclared local reference");
      return target.key;
    }
    if (this.sorts.get(target.key) !== "entity") fail(path, "undeclared local reference");
    return target.key;
  }

  private roleId(role: string, used: Set<string>): string {
    const candidate = SourceSemanticHandleSchema.safeParse(role).success ? role : this.fresh("r");
    const id = used.has(candidate) ? this.fresh("r") : candidate;
    used.add(id);
    return id;
  }

  private occurrenceId(key: string | undefined, prefix: string, path: Path): string {
    const expected = prefix === "s" ? "proposition" : "context";
    if (key !== undefined) {
      if (this.sorts.get(key) !== expected) fail(path, "local key has the wrong node kind");
      this.used.add(key);
      return key;
    }
    const id = this.fresh(prefix);
    this.sorts.set(id, expected);
    return id;
  }

  private declareOccurrence(key: string | undefined, sort: "proposition" | "context", path: Path): void {
    if (key === undefined) return;
    this.declare(key, sort, path);
  }

  private declareEntityKey(key: string, path: Path): void {
    this.declare(key, "entity", path);
  }

  private declare(key: string, sort: "entity" | "proposition" | "context", path: Path): void {
    const existing = this.sorts.get(key);
    if (existing !== undefined && existing !== sort) fail(path, "a person and an event cannot share one variable");
    this.sorts.set(key, sort);
    this.used.add(key);
  }

  private reserve(key: string, _path: Path): void {
    this.used.add(key);
  }

  private markReturn(key: string, path: Path): void {
    if (!this.sorts.has(key)) fail(path, "return target is undeclared");
    this.returned.add(key);
  }

  private fresh(prefix: string): string {
    let n = this.counters.get(prefix) ?? 0;
    let id: string;
    do {
      n += 1;
      id = `${prefix}${n}`;
    } while (this.used.has(id) || this.sorts.has(id) || this.frames.has(id));
    this.counters.set(prefix, n);
    this.used.add(id);
    return id;
  }
}

function fail(path: Path, message: string): never {
  throw new z.ZodError([{ code: "custom", path: [...path], message }]);
}
