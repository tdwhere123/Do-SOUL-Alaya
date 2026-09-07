import { createHash } from "node:crypto";
import {
  CONDITIONAL_FIELD_SCHEMA_VERSION,
  ConditionalFieldIdSchema,
  ConditionalFieldSha256DigestSchema,
  IsoDatetimeStringSchema,
  QueryHoleSchema,
  QueryHypothesisSchema,
  QueryInterpretationSchema,
  QueryProgramSchema,
  QueryTimeWindowSchema,
  QueryViewSchema,
  RequestBudgetSchema,
  formatConditionalFieldDigest,
  type QueryBinding,
  type QueryHole,
  type QueryHypothesis,
  type QueryInterpretation,
  type QueryInterpretationStatus,
  type QueryProgram,
  type QueryTimeWindow,
  type QueryView,
  type RequestBudget
} from "@do-soul/alaya-protocol";
import { stableStringify } from "../../../shared/stable-stringify.js";
import { admitRequestBudget } from "../reference/bind-max-min.js";
import { interpretQuery } from "../reference/interpret-query.js";
import {
  SUPPORTED_FAILED_DEPLOYMENT_QUERY_ID,
  attachSourceFilters,
  calendarYesterdayWindow,
  classifyOrdinaryRequest,
  lexicalStoredRelationProgram,
  openAnchorTimeGuard,
  programFromOpenRelations,
  supportedFailedDeploymentProgram,
  UNBOUND_BINDING_CONTEXT,
  uninterpretedQueryHole,
  yesterdayAnchorGuard,
  type OpenRelationCapture,
  type OrdinarySourceFilters
} from "./ordinary-language.js";

export { SUPPORTED_FAILED_DEPLOYMENT_QUERY_ID };
export type { OpenRelationCapture };
export {
  ANCHOR_EVENT_VARIABLE,
  SERVICE_VARIABLE,
  UNBOUND_BINDING_CONTEXT,
  USES_SERVICE_RELATION,
  sourceBoundEntityGuard
} from "./ordinary-language.js";

const EPSILON: QueryProgram = { schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION, kind: "epsilon" };
const MAX_ORDINARY_TEXT = 4096;

export type QueryMemoryPort = Readonly<{
  readonly readAuthorizedSnapshot: (input: Readonly<{
    readonly snapshot_id: string;
    readonly budget: RequestBudget;
  }>) => void;
}>;

type CompileCommon = Readonly<{
  readonly snapshot_id: string;
  readonly budget: RequestBudget;
  readonly view?: QueryView;
  readonly query_id?: string;
  readonly memory?: QueryMemoryPort;
  readonly authorized_scopes?: readonly string[];
}>;

export type TypedQueryCompileInput = CompileCommon & Readonly<{
  readonly source: "typed";
  readonly program: QueryProgram;
  readonly holes?: readonly QueryHole[];
  readonly hypotheses?: readonly QueryHypothesis[];
  readonly interpretation_clock?: string;
  readonly time_window?: QueryTimeWindow;
}>;

export type OrdinaryLanguageCompileInput = CompileCommon & Readonly<{
  readonly source: "ordinary";
  readonly text: string;
  readonly interpretation_clock: string;
  readonly since?: string;
  readonly until?: string;
  readonly time_field?: "created_at" | "last_used_at";
  readonly dimension_filter?: readonly string[];
  readonly domain_tag_filter?: readonly string[];
  readonly relations?: readonly OpenRelationCapture[];
}>;

export type QueryCompileInput = TypedQueryCompileInput | OrdinaryLanguageCompileInput;

export type QueryRelation = Extract<QueryProgram, { readonly kind: "relation" }>;

export function compileConditionalFieldQuery(input: QueryCompileInput): QueryInterpretation {
  const snapshot = ConditionalFieldSha256DigestSchema.safeParse(input.snapshot_id);
  if (!snapshot.success) {
    throw new Error("conditional-field query snapshot_id is invalid");
  }
  const budget = RequestBudgetSchema.safeParse(input.budget);
  if (!budget.success) {
    return interpretationOf({
      query_id: fallbackQueryId(input.query_id, "malformed"),
      status: "malformed",
      snapshot_id: snapshot.data,
      program: EPSILON,
      view: defaultView()
    });
  }
  // Envelope rejection is not an empty complete index, and it must not read memory.
  if (admitRequestBudget(budget.data) === "resource_rejected") {
    return interpretationOf({
      query_id: fallbackQueryId(input.query_id, "resource-rejected"),
      status: "resource_rejected",
      snapshot_id: snapshot.data,
      program: typedProgramOrEpsilon(input),
      view: defaultView(),
      interpretation_clock: input.interpretation_clock
    });
  }
  return input.source === "typed"
    ? compileTyped(input, snapshot.data, budget.data)
    : compileOrdinary(input, snapshot.data, budget.data);
}

export function collectRelations(program: QueryProgram): readonly QueryRelation[] {
  const relations: QueryRelation[] = [];
  visitQueryProgram(program, (node) => {
    if (node.kind === "relation") relations.push(node);
  });
  return relations;
}

export function collectRecoverableBindings(program: QueryProgram): readonly QueryBinding[] {
  const bindings: QueryBinding[] = [];
  visitQueryProgram(program, (node) => {
    if (node.kind !== "relation") return;
    if (node.guard.kind !== "source_bound_entity") return;
    if (node.guard.variable === undefined || node.guard.entity_id === undefined) return;
    bindings.push({
      schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
      variable: node.guard.variable,
      value: node.guard.entity_id
    });
  });
  return bindings;
}

export function recoverableBindingContext(bindings: readonly QueryBinding[]): string {
  if (bindings.length === 0) return UNBOUND_BINDING_CONTEXT;
  return [...bindings]
    .sort((left, right) => left.variable === right.variable
      ? left.value.localeCompare(right.value)
      : left.variable.localeCompare(right.variable))
    .map((binding) => `${binding.variable}=${binding.value}`)
    .join(";");
}

export function interpretationIdentity(input: Readonly<{
  readonly interpretation_clock?: string;
  readonly model_id?: string;
}>): string {
  return formatConditionalFieldDigest(
    createHash("sha256").update(stableStringify({
      interpretation_clock: input.interpretation_clock ?? null,
      model_id: input.model_id ?? null
    }), "utf8").digest("hex")
  );
}

function compileTyped(
  input: TypedQueryCompileInput,
  snapshotId: string,
  budget: RequestBudget
): QueryInterpretation {
  const program = QueryProgramSchema.safeParse(input.program);
  const view = requiredView(input.view);
  const holes = parseItems(input.holes, QueryHoleSchema);
  const hypotheses = parseItems(input.hypotheses, QueryHypothesisSchema);
  const timeWindow = optionalWindow(input.time_window);
  const queryId = explicitQueryId(input.query_id);
  if (
    !program.success
    || view === undefined
    || holes === undefined
    || hypotheses === undefined
    || timeWindow === "invalid"
    || queryId === "invalid"
  ) {
    return interpretationOf({
      query_id: fallbackQueryId(input.query_id, "malformed"),
      status: "malformed",
      snapshot_id: snapshotId,
      program: program.success ? program.data : EPSILON,
      view: view ?? defaultView(),
      interpretation_clock: input.interpretation_clock
    });
  }
  consumeMemoryIfNeeded(program.data, snapshotId, budget, input.memory);
  return interpretationOf({
    query_id: identityFor(queryId, {
      program: program.data,
      view,
      hypotheses,
      interpretation_clock: input.interpretation_clock,
      time_window: timeWindow,
      authorized_scopes: input.authorized_scopes
    }),
    status: admissionStatus(program.data, holes, hypotheses),
    snapshot_id: snapshotId,
    program: program.data,
    view,
    holes,
    hypotheses,
    interpretation_clock: input.interpretation_clock,
    time_window: timeWindow
  });
}

function compileOrdinary(
  input: OrdinaryLanguageCompileInput,
  snapshotId: string,
  budget: RequestBudget
): QueryInterpretation {
  const view = requiredView(input.view);
  const queryId = explicitQueryId(input.query_id);
  if (view === undefined || queryId === "invalid" || input.text.length > MAX_ORDINARY_TEXT) {
    return ordinaryMalformed(input, snapshotId, view ?? defaultView());
  }
  const yesterday = calendarYesterdayWindow(input.interpretation_clock);
  const hints = compileTimeHints(input.since, input.until);
  if (yesterday === undefined || hints.kind === "invalid") {
    return ordinaryMalformed(input, snapshotId, view);
  }
  const classified = classifyOrdinaryRequest(input.text);
  const relations = input.relations ?? [];
  if (relations.length > 0) {
    return compileOpenRelations(input, snapshotId, budget, view, queryId, classified, yesterday, hints);
  }
  if (classified.kind === "lexical") {
    return compileLexicalRequest(input, snapshotId, budget, view, queryId, hints);
  }
  return compileSupportedRequest(input, snapshotId, budget, view, queryId, classified, yesterday, hints);
}

function compileSupportedRequest(
  input: OrdinaryLanguageCompileInput,
  snapshotId: string,
  budget: RequestBudget,
  view: QueryView,
  queryId: string | undefined,
  classified: ReturnType<typeof classifyOrdinaryRequest>,
  yesterday: QueryTimeWindow,
  hints: TimeHints
): QueryInterpretation {
  if (classified.kind === "malformed") {
    return ordinaryMalformed(input, snapshotId, view);
  }
  if (classified.kind === "unsupported") {
    return interpretationOf({
      query_id: fallbackQueryId(queryId, "unsupported"),
      status: "unsupported",
      snapshot_id: snapshotId,
      program: EPSILON,
      view,
      interpretation_clock: input.interpretation_clock
    });
  }
  if (classified.kind === "lexical") {
    return compileLexicalRequest(input, snapshotId, budget, view, queryId, hints);
  }
  if (classified.kind === "hypotheses") {
    const program = admitOrdinaryProgram(
      supportedFailedDeploymentProgram(yesterdayAnchorGuard(yesterday)),
      input,
      hints
    );
    const hypotheses = ambiguousEventHypotheses();
    consumeMemoryIfNeeded(program, snapshotId, budget, input.memory);
    return interpretationOf({
      query_id: identityFor(queryId, {
        program,
        view,
        hypotheses,
        interpretation_clock: input.interpretation_clock,
        time_window: yesterday,
        authorized_scopes: input.authorized_scopes
      }),
      status: "hypotheses",
      snapshot_id: snapshotId,
      program,
      view,
      hypotheses,
      interpretation_clock: input.interpretation_clock,
      time_window: yesterday
    });
  }
  const window = classified.kind === "supported" ? yesterday : closedHintWindow(hints);
  const guard = window === undefined ? openAnchorTimeGuard() : yesterdayAnchorGuard(window);
  const program = admitOrdinaryProgram(supportedFailedDeploymentProgram(guard), input, hints);
  consumeMemoryIfNeeded(program, snapshotId, budget, input.memory);
  const holes = [
    ...(window === undefined ? [openTimeHole()] : []),
    ...openEndpointHoles(hints)
  ];
  return interpretationOf({
    query_id: identityFor(queryId, {
      program,
      view,
      interpretation_clock: input.interpretation_clock,
      time_window: window,
      authorized_scopes: input.authorized_scopes
    }),
    status: admissionStatus(program, holes, []),
    snapshot_id: snapshotId,
    program,
    view,
    holes,
    interpretation_clock: input.interpretation_clock,
    ...(window === undefined ? {} : { time_window: window })
  });
}

function compileLexicalRequest(
  input: OrdinaryLanguageCompileInput,
  snapshotId: string,
  budget: RequestBudget,
  view: QueryView,
  queryId: string | undefined,
  hints: TimeHints
): QueryInterpretation {
  const program = admitOrdinaryProgram(lexicalStoredRelationProgram(), input, hints);
  consumeMemoryIfNeeded(program, snapshotId, budget, input.memory);
  const holes = [uninterpretedQueryHole(), ...openEndpointHoles(hints)];
  const window = closedHintWindow(hints);
  return interpretationOf({
    query_id: identityFor(queryId, {
      program,
      view,
      interpretation_clock: input.interpretation_clock,
      time_window: window,
      authorized_scopes: input.authorized_scopes,
      lexical_text: input.text
    }),
    status: admissionStatus(program, holes, []),
    snapshot_id: snapshotId,
    program,
    view,
    holes,
    interpretation_clock: input.interpretation_clock,
    ...(window === undefined ? {} : { time_window: window })
  });
}

function compileOpenRelations(
  input: OrdinaryLanguageCompileInput,
  snapshotId: string,
  budget: RequestBudget,
  view: QueryView,
  queryId: string | undefined,
  classified: ReturnType<typeof classifyOrdinaryRequest>,
  yesterday: QueryTimeWindow,
  hints: TimeHints
): QueryInterpretation {
  const window = classified.kind === "supported" || classified.kind === "hypotheses"
    ? yesterday
    : closedHintWindow(hints);
  const compiled = programFromOpenRelations(
    input.relations ?? [],
    window === undefined ? undefined : yesterdayAnchorGuard(window)
  );
  const parsed = compiled === undefined ? undefined : QueryProgramSchema.safeParse(compiled);
  if (parsed === undefined || !parsed.success) {
    return ordinaryMalformed(input, snapshotId, view);
  }
  const program = admitOrdinaryProgram(parsed.data, input, hints);
  consumeMemoryIfNeeded(program, snapshotId, budget, input.memory);
  const holes = [
    ...(classified.kind === "partial" && window === undefined ? [openTimeHole()] : []),
    ...openEndpointHoles(hints)
  ];
  return interpretationOf({
    query_id: identityFor(queryId, {
      program,
      view,
      interpretation_clock: input.interpretation_clock,
      time_window: window,
      authorized_scopes: input.authorized_scopes
    }),
    status: admissionStatus(program, holes, []),
    snapshot_id: snapshotId,
    program,
    view,
    holes,
    interpretation_clock: input.interpretation_clock,
    ...(window === undefined ? {} : { time_window: window })
  });
}

function consumeMemoryIfNeeded(
  program: QueryProgram,
  snapshotId: string,
  budget: RequestBudget,
  memory: QueryMemoryPort | undefined
): void {
  // Pure parse may run earlier; entity reads still require the admitted snapshot pin.
  if (memory === undefined) return;
  if (!collectRelations(program).some((relation) =>
    relation.guard.kind === "source_bound_entity" && relation.guard.entity_id !== undefined
  )) {
    return;
  }
  memory.readAuthorizedSnapshot({ snapshot_id: snapshotId, budget });
}

function admissionStatus(
  program: QueryProgram,
  holes: readonly QueryHole[],
  hypotheses: readonly QueryHypothesis[]
): QueryInterpretationStatus {
  if (interpretQuery(program).kind === "unsupported") return "unsupported";
  if (hypotheses.length > 0) return "hypotheses";
  if (holes.some((hole) => hole.status !== "bound")) return "partial";
  return "resolved";
}

function interpretationOf(input: {
  readonly query_id: string;
  readonly status: QueryInterpretationStatus;
  readonly snapshot_id: string;
  readonly program: QueryProgram;
  readonly view: QueryView;
  readonly holes?: readonly QueryHole[];
  readonly hypotheses?: readonly QueryHypothesis[];
  readonly interpretation_clock?: string;
  readonly time_window?: QueryTimeWindow;
}): QueryInterpretation {
  return QueryInterpretationSchema.parse({
    schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
    query_id: input.query_id,
    status: input.status,
    snapshot_id: input.snapshot_id,
    program: input.program,
    view: input.view,
    holes: input.holes ?? [],
    hypotheses: input.hypotheses ?? [],
    ...(input.interpretation_clock === undefined
      ? {}
      : { interpretation_clock: input.interpretation_clock }),
    ...(input.time_window === undefined ? {} : { time_window: input.time_window })
  });
}

function ordinaryMalformed(
  input: OrdinaryLanguageCompileInput,
  snapshotId: string,
  view: QueryView
): QueryInterpretation {
  return interpretationOf({
    query_id: fallbackQueryId(input.query_id, "malformed"),
    status: "malformed",
    snapshot_id: snapshotId,
    program: EPSILON,
    view,
    interpretation_clock: input.interpretation_clock
  });
}

function defaultView(): QueryView {
  return QueryViewSchema.parse({
    schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
    requested_roles: ["requested", "associated"]
  });
}

function requiredView(view: QueryView | undefined): QueryView | undefined {
  if (view === undefined) return defaultView();
  const parsed = QueryViewSchema.safeParse(view);
  return parsed.success ? parsed.data : undefined;
}

function parseItems<T>(
  values: readonly T[] | undefined,
  schema: { readonly safeParse: (value: unknown) => { success: true; data: T } | { success: false } }
): readonly T[] | undefined {
  if (values === undefined) return [];
  const parsed: T[] = [];
  for (const item of values) {
    const result = schema.safeParse(item);
    if (!result.success) return undefined;
    parsed.push(result.data);
  }
  return parsed;
}

function optionalWindow(
  window: QueryTimeWindow | undefined
): QueryTimeWindow | undefined | "invalid" {
  if (window === undefined) return undefined;
  const parsed = QueryTimeWindowSchema.safeParse(window);
  return parsed.success ? parsed.data : "invalid";
}

type TimeHints =
  | { readonly kind: "none" }
  | { readonly kind: "window"; readonly window: QueryTimeWindow }
  | { readonly kind: "partial"; readonly since?: string; readonly until?: string }
  | { readonly kind: "invalid" };

function compileTimeHints(
  since: string | undefined,
  until: string | undefined
): TimeHints {
  if (since === undefined && until === undefined) return { kind: "none" };
  if (since !== undefined && until !== undefined) {
    const parsed = optionalWindow({ start: since, end: until });
    return parsed === "invalid" || parsed === undefined
      ? { kind: "invalid" }
      : { kind: "window", window: parsed };
  }
  const present = since ?? until;
  if (present === undefined || !IsoDatetimeStringSchema.safeParse(present).success) {
    return { kind: "invalid" };
  }
  return {
    kind: "partial",
    ...(since === undefined ? {} : { since }),
    ...(until === undefined ? {} : { until })
  };
}

function closedHintWindow(hints: TimeHints): QueryTimeWindow | undefined {
  return hints.kind === "window" ? hints.window : undefined;
}

function openEndpointHoles(hints: TimeHints): readonly QueryHole[] {
  if (hints.kind !== "partial") return [];
  if (hints.since !== undefined && hints.until === undefined) {
    return [{ schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION, hole_id: "hole.time.until", variable: "r", status: "open" }];
  }
  if (hints.until !== undefined && hints.since === undefined) {
    return [{ schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION, hole_id: "hole.time.since", variable: "r", status: "open" }];
  }
  return [];
}

function admitOrdinaryProgram(
  program: QueryProgram,
  input: OrdinaryLanguageCompileInput,
  hints: TimeHints
): QueryProgram {
  return attachSourceFilters(program, sourceFiltersFrom(input, hints));
}

function sourceFiltersFrom(
  input: OrdinaryLanguageCompileInput,
  hints: TimeHints
): OrdinarySourceFilters {
  const since = hints.kind === "window" ? hints.window.start : hints.kind === "partial" ? hints.since : input.since;
  const until = hints.kind === "window" ? hints.window.end : hints.kind === "partial" ? hints.until : input.until;
  return {
    ...(input.dimension_filter === undefined || input.dimension_filter.length === 0
      ? {}
      : { dimension_filter: input.dimension_filter }),
    ...(input.domain_tag_filter === undefined || input.domain_tag_filter.length === 0
      ? {}
      : { domain_tag_filter: input.domain_tag_filter }),
    ...(input.time_field === undefined ? {} : { time_field: input.time_field }),
    ...(since === undefined ? {} : { since }),
    ...(until === undefined ? {} : { until })
  };
}

function explicitQueryId(value: string | undefined): string | undefined | "invalid" {
  if (value === undefined) return undefined;
  const parsed = ConditionalFieldIdSchema.safeParse(value);
  return parsed.success ? parsed.data : "invalid";
}

function fallbackQueryId(value: string | undefined, fallback: string): string {
  const parsed = value === undefined ? undefined : ConditionalFieldIdSchema.safeParse(value);
  return parsed?.success === true ? parsed.data : fallback;
}

function identityFor(
  queryId: string | undefined,
  parts: Readonly<{
    readonly program: QueryProgram;
    readonly view?: QueryView;
    readonly hypotheses?: readonly QueryHypothesis[];
    readonly interpretation_clock?: string;
    readonly time_window?: QueryTimeWindow;
    readonly authorized_scopes?: readonly string[];
    readonly lexical_text?: string;
  }>
): string {
  if (queryId !== undefined) return queryId;
  return formatConditionalFieldDigest(
    createHash("sha256").update(stableStringify({
      program: parts.program,
      view: parts.view ?? null,
      hypotheses: parts.hypotheses ?? [],
      interpretation_clock: parts.interpretation_clock ?? null,
      time_window: parts.time_window ?? null,
      authorized_scopes: [...(parts.authorized_scopes ?? [])].sort(),
      lexical_text: parts.lexical_text ?? ""
    }), "utf8").digest("hex")
  );
}

function typedProgramOrEpsilon(input: QueryCompileInput): QueryProgram {
  if (input.source !== "typed") return EPSILON;
  const parsed = QueryProgramSchema.safeParse(input.program);
  return parsed.success ? parsed.data : EPSILON;
}

function visitQueryProgram(program: QueryProgram, visit: (node: QueryProgram) => void): void {
  visit(program);
  if (program.kind === "sequence") {
    for (const step of program.steps) visitQueryProgram(step, visit);
    return;
  }
  if (program.kind === "alternative") {
    for (const option of program.options) visitQueryProgram(option, visit);
    return;
  }
  if (program.kind === "repeat" || program.kind === "closure") {
    visitQueryProgram(program.body, visit);
    return;
  }
  if (program.kind === "hyperedge") {
    for (const premise of program.premises) visitQueryProgram(premise, visit);
  }
}

function openTimeHole(): QueryHole {
  return {
    schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
    hole_id: "hole.anchor.time",
    variable: "r",
    status: "open"
  };
}

function ambiguousEventHypotheses(): readonly QueryHypothesis[] {
  return [
    hypothesis("h-failed-deployment", "event", "failed_deployment"),
    hypothesis("h-unresolved-event", "event", "unresolved")
  ];
}

function hypothesis(id: string, variable: string, value: string): QueryHypothesis {
  return {
    schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
    hypothesis_id: id,
    bindings: [{
      schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
      variable,
      value
    }]
  };
}
