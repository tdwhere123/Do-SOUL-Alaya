import { createHash } from "node:crypto";
import {
  CONDITIONAL_FIELD_SCHEMA_VERSION,
  ConditionalFieldIdSchema,
  ConditionalFieldSha256DigestSchema,
  QueryHoleSchema,
  QueryHypothesisSchema,
  QueryInterpretationSchema,
  QueryProgramSchema,
  QueryTimeWindowSchema,
  QueryViewSchema,
  RequestBudgetSchema,
  formatConditionalFieldDigest,
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
  calendarYesterdayWindow,
  classifyOrdinaryRequest,
  openAnchorTimeGuard,
  programFromOpenRelations,
  supportedFailedDeploymentProgram,
  yesterdayAnchorGuard,
  type OpenRelationCapture
} from "./ordinary-language.js";

export { SUPPORTED_FAILED_DEPLOYMENT_QUERY_ID };
export type { OpenRelationCapture };

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
    query_id: identityFor(queryId, program.data),
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
  if (yesterday === undefined || hints === "invalid") {
    return ordinaryMalformed(input, snapshotId, view);
  }
  const classified = classifyOrdinaryRequest(input.text);
  const relations = input.relations ?? [];
  if (relations.length > 0) {
    return compileOpenRelations(input, snapshotId, budget, view, queryId, classified, yesterday, hints);
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
  hints: QueryTimeWindow | undefined
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
  if (classified.kind === "hypotheses") {
    const program = supportedFailedDeploymentProgram(yesterdayAnchorGuard(yesterday));
    consumeMemoryIfNeeded(program, snapshotId, budget, input.memory);
    return interpretationOf({
      query_id: fallbackQueryId(queryId, SUPPORTED_FAILED_DEPLOYMENT_QUERY_ID),
      status: "hypotheses",
      snapshot_id: snapshotId,
      program,
      view,
      hypotheses: ambiguousEventHypotheses(),
      interpretation_clock: input.interpretation_clock,
      time_window: yesterday
    });
  }
  const window = classified.kind === "supported" ? yesterday : hints;
  const guard = window === undefined ? openAnchorTimeGuard() : yesterdayAnchorGuard(window);
  const program = supportedFailedDeploymentProgram(guard);
  consumeMemoryIfNeeded(program, snapshotId, budget, input.memory);
  const holes = window === undefined ? [openTimeHole()] : [];
  return interpretationOf({
    query_id: fallbackQueryId(queryId, SUPPORTED_FAILED_DEPLOYMENT_QUERY_ID),
    status: holes.length > 0 ? "partial" : "resolved",
    snapshot_id: snapshotId,
    program,
    view,
    holes,
    interpretation_clock: input.interpretation_clock,
    time_window: window
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
  hints: QueryTimeWindow | undefined
): QueryInterpretation {
  const window = classified.kind === "supported" || classified.kind === "hypotheses"
    ? yesterday
    : hints;
  const program = programFromOpenRelations(
    input.relations ?? [],
    window === undefined ? undefined : yesterdayAnchorGuard(window)
  );
  const parsed = program === undefined ? undefined : QueryProgramSchema.safeParse(program);
  if (parsed === undefined || !parsed.success) {
    return ordinaryMalformed(input, snapshotId, view);
  }
  consumeMemoryIfNeeded(parsed.data, snapshotId, budget, input.memory);
  return interpretationOf({
    query_id: identityFor(queryId, parsed.data, SUPPORTED_FAILED_DEPLOYMENT_QUERY_ID),
    status: "resolved",
    snapshot_id: snapshotId,
    program: parsed.data,
    view,
    interpretation_clock: input.interpretation_clock,
    time_window: window
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
  if (!collectRelations(program).some((relation) => relation.guard.kind === "source_bound_entity")) {
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

function compileTimeHints(
  since: string | undefined,
  until: string | undefined
): QueryTimeWindow | undefined | "invalid" {
  if (since === undefined && until === undefined) return undefined;
  if (since === undefined || until === undefined) return "invalid";
  return optionalWindow({ start: since, end: until });
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
  program: QueryProgram,
  fallback?: string
): string {
  if (queryId !== undefined) return queryId;
  if (fallback !== undefined) return fallback;
  return formatConditionalFieldDigest(
    createHash("sha256").update(stableStringify(program), "utf8").digest("hex")
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
