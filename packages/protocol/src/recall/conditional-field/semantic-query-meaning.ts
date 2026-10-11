import { z } from "zod";
import { ApprovedSemanticContextSchema, UtteranceAttributionSchema } from "../../conversation/utterance-attribution.js";
import {
  SOURCE_SEMANTIC_MAX_BYTES, SOURCE_SEMANTIC_MAX_DEPTH,
  SourceSemanticHandleSchema, SourceSemanticReadingSchema
} from "../../garden/source-semantic-draft.js";
import { SourceSemanticResourceLedger } from "../../garden/source-semantic-resources.js";
import {
  SOURCE_SEMANTIC_QUERY_CONTRACT, SourceSemanticQueryEvaluationSchema, SourceSemanticQuerySchema, SourceSemanticQueryGapSchema,
  SourceSemanticRequestedOperationSchema,
  type SourceSemanticContextObligation, type SourceSemanticQuery, type SourceSemanticQueryAlternative,
  type SourceSemanticQueryFrame, type SourceSemanticQueryRoleRequirement, type SourceSemanticQueryVariable
} from "./semantic-query.js";

export const SOURCE_SEMANTIC_QUERY_MEANING_CONTRACT = "source-semantic-query-meaning-v5" as const;
export const SOURCE_SEMANTIC_QUERY_MEANING_MAX_DEPTH = Math.min(8, SOURCE_SEMANTIC_MAX_DEPTH);
export const SOURCE_SEMANTIC_QUERY_CARRIER_MAX_NODES = 8192;
export const SourceSemanticQueryPresentationSchema = z.enum([
  "flat-carrier-v1", "nested-meaning-v1", "nested-referent-constraints-v1"
]);
export type SourceSemanticQueryPresentation = z.infer<typeof SourceSemanticQueryPresentationSchema>;

const Key = SourceSemanticHandleSchema;
const Reading = SourceSemanticReadingSchema;
const Obligation = z.enum(["asserted_at_source", "entailed_at_source", "unresolved"]);
const RequiredEvidenceAct = z.object({
  act: z.enum(["question", "directive"]), excerpt: z.string().min(1).max(1024)
}).strict().readonly();

/** A variable to bind; its excerpt supports a role but supplies no referent correspondence obligation. */
const FreeTarget = z.object({
  kind: z.literal("free"), key: Key, excerpt: z.string().min(1).max(1024).optional(), return: z.boolean().optional()
}).strict().readonly();
/** A query-text referential constraint, including deictic or definite expressions; no global identity is asserted. */
const NamedTarget = z.object({
  kind: z.literal("named"), key: Key, excerpt: z.string().min(1).max(1024), return: z.boolean().optional()
}).strict().readonly();
/** Reuses the declaration and its constraints; it never resolves an external referent. */
const LocalReference = z.object({ kind: z.literal("reference"), key: Key }).strict().readonly();
const EntityTarget = z.discriminatedUnion("kind", [FreeTarget, NamedTarget, LocalReference]);
const RoleArgument = z.object({
  role: Reading, target: EntityTarget, excerpt: z.string().min(1).max(1024).optional()
}).strict().readonly();
const OccurrenceShape = { kind: z.literal("occurrence"), key: Key };

type Path = readonly (string | number)[];
type EntityTargetValue = z.infer<typeof EntityTarget>;
type RoleArgumentValue = z.infer<typeof RoleArgument>;
type ObligationKind = z.infer<typeof Obligation>;
type RequiredEvidenceActValue = z.infer<typeof RequiredEvidenceAct>;

export type QueryMeaning =
  | QueryStatementMeaning
  | QueryNotMeaning
  | QueryPossibleMeaning
  | QueryReportedMeaning
  | QueryConditionalMeaning
  | QueryOpaqueMeaning
  | QueryOccurrenceMeaning;

type QueryStatementMeaning = Readonly<{
  readonly kind: "statement";
  readonly key?: string;
  readonly predicate: string;
  readonly arguments: readonly RoleArgumentValue[];
  readonly content?: QueryMeaning;
  readonly obligation?: ObligationKind;
  readonly required_evidence_act?: RequiredEvidenceActValue;
  readonly return?: boolean;
}>;
type QueryNotMeaning = Readonly<{
  readonly kind: "not";
  readonly key?: string;
  readonly return?: boolean;
  readonly content: QueryMeaning;
  readonly obligation?: ObligationKind;
  readonly required_evidence_act?: RequiredEvidenceActValue;
}>;
type QueryPossibleMeaning = Readonly<{
  readonly kind: "possible";
  readonly key?: string;
  readonly return?: boolean;
  readonly content: QueryMeaning;
  readonly obligation?: ObligationKind;
  readonly required_evidence_act?: RequiredEvidenceActValue;
}>;
type QueryReportedMeaning = Readonly<{
  readonly kind: "reported";
  readonly key?: string;
  readonly return?: boolean;
  readonly content: QueryMeaning;
  readonly reporter?: EntityTargetValue;
  readonly obligation?: ObligationKind;
  readonly required_evidence_act?: RequiredEvidenceActValue;
}>;
type QueryConditionalMeaning = Readonly<{
  readonly kind: "conditional";
  readonly key?: string;
  readonly return?: boolean;
  readonly antecedent: QueryMeaning;
  readonly consequent: QueryMeaning;
  readonly obligation?: ObligationKind;
  readonly required_evidence_act?: RequiredEvidenceActValue;
}>;
type QueryOpaqueMeaning = Readonly<{
  readonly kind: "opaque";
  readonly key?: string;
  readonly return?: boolean;
  readonly operands: readonly QueryMeaning[];
  readonly obligation?: ObligationKind;
  readonly required_evidence_act?: RequiredEvidenceActValue;
}>;
type QueryOccurrenceMeaning = Readonly<{ kind: "occurrence"; readonly key: string }>;

function meaningShape<Operand extends z.ZodTypeAny, const Serialized extends Record<string, z.ZodTypeAny>>(
  operand: Operand, token: Serialized
) {
  return z.discriminatedUnion("kind", [
    z.object({
      ...token,
      kind: z.literal("statement"), key: Key.optional(), predicate: Reading,
      arguments: z.array(RoleArgument).max(8).readonly(), content: operand.optional(),
      obligation: Obligation.optional(), required_evidence_act: RequiredEvidenceAct.optional(), return: z.boolean().optional()
    }).strict().readonly(),
    z.object({
      ...token,
      kind: z.literal("not"), key: Key.optional(), return: z.boolean().optional(), content: operand,
      obligation: Obligation.optional(), required_evidence_act: RequiredEvidenceAct.optional()
    }).strict().readonly(),
    z.object({
      ...token,
      kind: z.literal("possible"), key: Key.optional(), return: z.boolean().optional(), content: operand,
      obligation: Obligation.optional(), required_evidence_act: RequiredEvidenceAct.optional()
    }).strict().readonly(),
    z.object({
      ...token,
      kind: z.literal("reported"), key: Key.optional(), return: z.boolean().optional(), content: operand, reporter: EntityTarget.optional(),
      obligation: Obligation.optional(), required_evidence_act: RequiredEvidenceAct.optional()
    }).strict().readonly(),
    z.object({
      ...token,
      kind: z.literal("conditional"), key: Key.optional(), return: z.boolean().optional(), antecedent: operand, consequent: operand,
      obligation: Obligation.optional(), required_evidence_act: RequiredEvidenceAct.optional()
    }).strict().readonly(),
    z.object({
      ...token,
      kind: z.literal("opaque"), key: Key.optional(), return: z.boolean().optional(), operands: z.array(operand).min(1).max(8).readonly(),
      obligation: Obligation.optional(), required_evidence_act: RequiredEvidenceAct.optional()
    }).strict().readonly(),
    z.object({ ...OccurrenceShape, ...token }).strict().readonly()
  ]);
}

const Meaning: z.ZodType<QueryMeaning> = z.lazy(() => meaningShape(Meaning, {})) as z.ZodType<QueryMeaning>;
/** One structural authority projected with either nested operands or serialization references. */
const SourceSemanticQueryCarrierNodeSchema = meaningShape(Key, { node: Key });
function alternativeShape<Condition extends z.ZodTypeAny>(condition: Condition) {
  const conditions = z.array(condition).max(16).readonly();
  return z.object({
    conditions,
    evidence_inputs: z.array(z.object({ conditions: z.array(condition).min(1).max(16).readonly() })
      .strict().readonly()).min(1).max(16).readonly().optional(),
    purpose: z.enum(["support", "counterexample"]).optional()
  }).strict().readonly();
}
const Alternative = alternativeShape(Meaning);

const Domain = z.object({
  key: Key, excerpt: z.string().min(1).max(1024)
}).strict().readonly();

function meaningBodyShape<AlternativeSchema extends z.ZodTypeAny>(alternative: AlternativeSchema) {
  return {
    contract: z.literal(SOURCE_SEMANTIC_QUERY_MEANING_CONTRACT),
    alternatives: z.array(alternative).min(1).max(16).readonly(),
    gaps: z.array(SourceSemanticQueryGapSchema).max(256).readonly(),
    domains: z.array(Domain).max(64).readonly().optional(),
    entities: z.array(z.discriminatedUnion("kind", [FreeTarget, NamedTarget])).max(64).readonly().optional(),
    evaluation: SourceSemanticQueryEvaluationSchema.optional(),
    requested_operation: SourceSemanticRequestedOperationSchema.optional()
  };
}

function validateMeaningBody(body: { evaluation?: { kind: string }; requested_operation?: unknown;
  alternatives: readonly { conditions: readonly unknown[]; evidence_inputs?: unknown }[] }, context: z.RefinementCtx): void {
  const comparison = body.evaluation?.kind === "comparison";
  for (const [index, alternative] of body.alternatives.entries()) {
    if (comparison && alternative.conditions.length > 0) {
      context.addIssue({ code: "custom", path: ["alternatives", index, "conditions"],
        message: "comparison uses typed operand scope; nested meaning is not supported" });
    }
    if (!comparison && alternative.conditions.length === 0 && alternative.evidence_inputs === undefined) {
      context.addIssue({ code: "custom", path: ["alternatives", index, "conditions"],
        message: "query body requires answer conditions or evidence inputs" });
    }
    if (alternative.evidence_inputs !== undefined && body.requested_operation === undefined) {
      context.addIssue({ code: "custom", path: ["requested_operation"], message: "evidence inputs require the original requested operation" });
    }
    if (alternative.evidence_inputs !== undefined && body.evaluation !== undefined) {
      context.addIssue({ code: "custom", path: ["alternatives", index, "evidence_inputs"],
        message: "finite evaluation cannot include independent evidence branches" });
    }
  }
}

export const SourceSemanticQueryMeaningBodySchema = z.object(meaningBodyShape(Alternative))
  .strict().readonly().superRefine(validateMeaningBody);
export const SourceSemanticQueryCarrierBodySchema = z.object({
  ...meaningBodyShape(alternativeShape(Key)),
  nodes: z.array(SourceSemanticQueryCarrierNodeSchema).max(SOURCE_SEMANTIC_QUERY_CARRIER_MAX_NODES).readonly()
})
  .strict().readonly().superRefine(validateMeaningBody);

export type SourceSemanticQueryMeaningBody = z.infer<typeof SourceSemanticQueryMeaningBodySchema>;

export type SourceSemanticQueryMeaningEnvelope = Readonly<{
  readonly original_query: string;
  readonly original_query_digest: string;
  readonly producer_id: string;
  readonly producer_version: string;
  readonly approved_fixed_context: z.infer<typeof ApprovedSemanticContextSchema> | null;
  readonly attribution_context: z.infer<typeof UtteranceAttributionSchema>;
}>;

/** Host graph construction. Does not repair a legacy producer graph. */
export function materializeSourceSemanticQueryMeaning(
  body: unknown, envelope: SourceSemanticQueryMeaningEnvelope, meter?: SourceSemanticResourceLedger
): SourceSemanticQuery {
  meter?.retain(body, "query meaning materialization");
  assertSourceSemanticQueryMeaningBounds(body);
  if (typeof envelope.original_query !== "string" || envelope.original_query.length === 0) {
    fail(["original_query"], "query meaning requires original query text");
  }
  const parsed = SourceSemanticQueryMeaningBodySchema.parse(body);
  const compiled = new QueryMeaningCompiler(envelope.original_query).compile(parsed);
  const query = SourceSemanticQuerySchema.parse({
    contract: SOURCE_SEMANTIC_QUERY_CONTRACT,
    original_query_digest: envelope.original_query_digest,
    approved_fixed_context: ApprovedSemanticContextSchema.nullable().parse(envelope.approved_fixed_context),
    attribution_context: UtteranceAttributionSchema.parse(envelope.attribution_context),
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
    ...(parsed.evaluation === undefined ? {} : { evaluation: parsed.evaluation }),
    ...(parsed.requested_operation === undefined ? {} : { requested_operation: parsed.requested_operation })
  });
  meter?.retain(query, "query canonical meaning");
  return query;
}

/** Shared structural bound before recursive parsing or presentation copies. */
export function assertSourceSemanticQueryMeaningBounds(value: unknown): void {
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
  if (new TextEncoder().encode(JSON.stringify(value)).length > SOURCE_SEMANTIC_MAX_BYTES) {
    fail([], "source semantic query exceeds its byte bound");
  }
}

class QueryMeaningCompiler {
  private readonly sorts = new Map<string, "entity" | "proposition" | "context">();
  private readonly named = new Map<string, string>();
  private readonly entityKinds = new Map<string, "free" | "named">();
  private readonly entitySupport = new Map<string, Set<string>>();
  private readonly returned = new Set<string>();
  private readonly frames = new Map<string, { variable: string; operator?: QueryMeaning["kind"] }>();
  private readonly used = new Set<string>();
  private readonly counters = new Map<string, number>();
  private readonly compiling = new Set<string>();
  private readonly anonymousOccurrenceAliases = new Set<string>();
  private readonly occurrenceDeclarations = new Map<string, number>();
  private evidence = false;

  constructor(private readonly originalQuery: string) {}

  compile(body: SourceSemanticQueryMeaningBody): {
    variables: SourceSemanticQueryVariable[];
    alternatives: SourceSemanticQueryAlternative[];
    return_variables: string[];
  } {
    this.collectAnonymousOccurrenceAliases(body);
    this.collect(body);
    for (const entity of body.entities ?? []) if (entity.return === true) this.returned.add(entity.key);
    const alternatives = body.alternatives.map((alternative, index) =>
      this.alternative(alternative, ["alternatives", index], body.evaluation?.kind === "comparison"));
    const variables: SourceSemanticQueryVariable[] = [...this.sorts.entries()].map(([id, sort]) => ({
      id, sort, ...(sort === "entity" && this.named.has(id)
        ? { reference: { kind: "query_text" as const, excerpt: this.named.get(id)! } } : {})
    }));
    if (variables.length === 0) fail(["alternatives"], "query meaning declares no variables");
    return { variables, alternatives, return_variables: [...this.returned] };
  }

  private collectAnonymousOccurrenceAliases(body: SourceSemanticQueryMeaningBody): void {
    const referenced = new Set([
      ...body.gaps.flatMap((gap) => gap.affected_ids),
      ...(body.domains ?? []).map((domain) => domain.key)
    ]);
    const evaluation = body.evaluation;
    if (evaluation !== undefined) {
      referenced.add(evaluation.domain);
      if (evaluation.kind === "forall") {
        for (const key of [evaluation.binder, ...evaluation.local_variables]) referenced.add(key);
      } else {
        referenced.add(evaluation.left);
        if (evaluation.right !== undefined) referenced.add(evaluation.right);
      }
    }
    const entities = new Set<string>(), occurrences = new Map<string, number>();
    const target = (value: EntityTargetValue): void => {
      if (value.kind === "reference" || value.return === true) referenced.add(value.key);
      if (value.kind !== "reference") entities.add(value.key);
    };
    const visit = (value: QueryMeaning): void => {
      if (value.kind === "occurrence") { referenced.add(value.key); return; }
      if (value.key !== undefined) occurrences.set(value.key, (occurrences.get(value.key) ?? 0) + 1);
      if (value.return === true && value.key !== undefined) referenced.add(value.key);
      if (value.kind === "statement") {
        for (const argument of value.arguments) target(argument.target);
        if (value.content !== undefined) visit(value.content);
      } else if (value.kind === "conditional") {
        visit(value.antecedent); visit(value.consequent);
      } else if (value.kind === "opaque") {
        value.operands.forEach(visit);
      } else {
        if (value.kind === "reported" && value.reporter !== undefined) target(value.reporter);
        visit(value.content);
      }
    };
    body.entities?.forEach(target);
    for (const alternative of body.alternatives) {
      alternative.conditions.forEach(visit);
      alternative.evidence_inputs?.forEach((input) => input.conditions.forEach(visit));
    }
    // Only an unused, single occurrence alias may yield to an entity declaration.
    // References retain strict identity; fresh allocation never retargets them.
    for (const [key, count] of occurrences) {
      if (count === 1 && entities.has(key) && !referenced.has(key)) this.anonymousOccurrenceAliases.add(key);
    }
  }

  private collect(body: SourceSemanticQueryMeaningBody): void {
    for (const [index, entity] of (body.entities ?? []).entries()) {
      this.collectTarget(entity, ["entities", index]);
    }
    for (const [index, alternative] of body.alternatives.entries()) {
      alternative.conditions.forEach((condition, n) => this.collectMeaning(condition, ["alternatives", index, "conditions", n]));
      this.evidence = true;
      (alternative.evidence_inputs ?? []).forEach((input, n) => input.conditions.forEach((condition, k) =>
        this.collectMeaning(condition, ["alternatives", index, "evidence_inputs", n, "conditions", k])));
      this.evidence = false;
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
        this.collectTarget(argument.target, [...path, "arguments", index, "target"], argument.excerpt);
      }
      if (meaning.content !== undefined) this.collectMeaning(meaning.content, [...path, "content"]);
      if (this.evidence && meaning.return === true) fail(path, "evidence input cannot declare a returned target");
      return;
    }
    this.declareOccurrence(meaning.key, "context", path);
    if (this.evidence && meaning.return === true) fail(path, "evidence input cannot declare a returned target");
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
    this.collectMeaning(meaning.content, [...path, "content"]);
  }

  private collectTarget(target: EntityTargetValue, path: Path, argumentExcerpt?: string): void {
    if (target.kind === "reference") return;
    const declaredKind = this.entityKinds.get(target.key);
    if (declaredKind !== undefined && declaredKind !== target.kind) {
      fail(path, "entity declaration kind conflicts with an earlier declaration");
    }
    this.entityKinds.set(target.key, target.kind);
    this.declareEntityKey(target.key, path);
    const excerpt = target.excerpt ?? argumentExcerpt;
    if (excerpt !== undefined) {
      const supports = this.entitySupport.get(target.key) ?? new Set<string>();
      supports.add(excerpt);
      this.entitySupport.set(target.key, supports);
    }
    if (target.kind === "named") {
      const previous = this.named.get(target.key);
      if (previous !== undefined && previous !== target.excerpt) {
        fail(path, "named constraint excerpt conflicts with an earlier declaration");
      }
      this.named.set(target.key, target.excerpt);
    }
    if (target.return === true && this.evidence) fail(path, "evidence input cannot declare a returned target");
  }

  private alternative(
    alternative: z.infer<typeof Alternative>, path: Path, comparison: boolean
  ): SourceSemanticQueryAlternative {
    if (comparison) {
      return { frames: [], context_obligations: [], ...(alternative.purpose === undefined ? {} : { purpose: alternative.purpose }) };
    }
    const frames: SourceSemanticQueryFrame[] = [];
    const obligations: SourceSemanticContextObligation[] = [];
    const answer_frames = alternative.conditions.map((condition, n) =>
      this.compileMeaning(condition, [...path, "conditions", n], frames, obligations, undefined));
    this.evidence = true;
    const evidence_inputs = alternative.evidence_inputs?.map((input, n) => ({ frames: input.conditions.map((condition, k) =>
      this.compileMeaning(condition, [...path, "evidence_inputs", n, "conditions", k], frames, obligations, undefined)) }));
    this.evidence = false;
    return {
      frames, context_obligations: obligations,
      ...(evidence_inputs === undefined ? {} : { answer_frames, evidence_inputs }),
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
    if (!this.evidence && meaning.return === true) this.returned.add(frameId);
    const operator = meaning.kind === "statement" ? undefined
      : meaning.kind === "opaque" ? "opaque" : meaning.kind === "conditional" ? "conditional"
      : meaning.kind === "reported" ? "reported" : meaning.kind === "possible" ? "possible" : "not";
    this.frames.set(frameId, { variable, ...(operator === undefined ? {} : { operator }) });
    const roleIds = new Set<string>();
    const roles: SourceSemanticQueryRoleRequirement[] = meaning.kind === "statement"
      ? meaning.arguments.map((argument, index) => this.role(argument, [...path, "arguments", index], roleIds))
      : meaning.kind === "reported" && meaning.reporter !== undefined
        ? [this.reporterRole(meaning.reporter, [...path, "reporter"], roleIds)]
        : [];
    if (meaning.required_evidence_act !== undefined && !this.originalQuery.includes(meaning.required_evidence_act.excerpt)) {
      fail([...path, "required_evidence_act", "excerpt"], "required evidence act excerpt is absent from the original query");
    }
    frames.push({
      id: frameId, variable,
      predicate_reading: meaning.kind === "statement" ? meaning.predicate : meaning.kind,
      ...(operator === undefined ? {} : { operator }),
      role_requirements: roles,
      ...(meaning.required_evidence_act === undefined ? {} : { source_act: meaning.required_evidence_act.act })
    });
    if (parent === undefined) {
      // A requested question or directive supplies evidence without asserting its content.
      obligations.push({ frame: frameId, kind: meaning.obligation
        ?? (meaning.required_evidence_act === undefined ? "asserted_at_source" : "unresolved") });
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
    const target = argument.target.key;
    if (argument.target.kind !== "reference" && argument.target.return === true) this.returned.add(target);
    const sort = this.sorts.get(target);
    if (sort === undefined) fail([...path, "target"], "undeclared local reference");
    if (sort !== "entity") {
      if (argument.target.kind !== "reference" || this.occurrenceDeclarations.get(target) !== 1) {
        fail([...path, "target"], "role reference requires a unique occurrence declaration");
      }
      if (argument.excerpt === undefined) fail(path, "occurrence role requires explicit query text support");
      if (!this.originalQuery.includes(argument.excerpt)) fail([...path, "excerpt"], "role excerpt is absent from the original query");
    }
    const declared = this.entitySupport.get(target);
    const excerpt = argument.excerpt
      ?? (argument.target.kind === "reference" ? undefined : argument.target.excerpt)
      ?? this.named.get(target)
      ?? (declared?.size === 1 ? [...declared][0] : undefined);
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
    this.entityId(target, path);
    return this.role({ role: "reporter", target }, path, used);
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
    this.used.add(id);
    return id;
  }

  private occurrenceId(key: string | undefined, prefix: string, path: Path): string {
    const expected = prefix === "s" ? "proposition" : "context";
    if (key !== undefined && !this.anonymousOccurrenceAliases.has(key)) {
      if (this.sorts.get(key) !== expected) fail(path, "local key has the wrong node kind");
      this.used.add(key);
      return key;
    }
    const id = this.fresh(prefix);
    this.sorts.set(id, expected);
    return id;
  }

  private declareOccurrence(key: string | undefined, sort: "proposition" | "context", path: Path): void {
    if (key === undefined || this.anonymousOccurrenceAliases.has(key)) return;
    this.declare(key, sort, path);
    this.occurrenceDeclarations.set(key, (this.occurrenceDeclarations.get(key) ?? 0) + 1);
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
