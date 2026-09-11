import {
  ConditionalFieldSha256DigestSchema,
  QueryHoleSchema,
  QueryHypothesisSchema,
  QueryProgramSchema,
  RequestBudgetSchema,
  type QueryHole,
  type QueryHypothesis,
  type QueryInterpretation,
  type QueryInterpretationProposal,
  type QueryProgram,
  type QueryTimeWindow,
  type QueryView,
  type RequestBudget
} from "@do-soul/alaya-protocol";
import { stableStringify } from "../../../shared/stable-stringify.js";
import { admitRequestBudget } from "../reference/bind-max-min.js";
import { compileOrdinary } from "./compile-query-ordinary.js";
import { identityFor } from "./compile-query-identity.js";
import type { OpenRelationCapture } from "./ordinary-language.js";
import {
  admissionStatus,
  admitBoundProposalFields,
  admitQueryPredicates,
  associativeCapDomainAdmission,
  consumeMemoryIfNeeded,
  defaultView,
  denotationForAdmission,
  EPSILON,
  explicitQueryId,
  extraGuardsForAdmission,
  fallbackQueryId,
  incompatibleCapInterpretation,
  interpretationOf,
  optionalWindow,
  parseItems,
  proposalRejectedInterpretation,
  requiredView,
  type QueryMemoryPort
} from "./query-admission.js";
import { admitQueryProposal } from "./query-proposal-admission.js";
import type { QueryProposalProducerRegistry } from "./query-proposal-producer-registry.js";

export {
  authorizedScopesMismatch,
  continuationViewMismatch,
  digestOriginalQuery,
  identityFor,
  interpretationIdentity,
  proposalBindsOriginalQuery
} from "./compile-query-identity.js";
export {
  collectRecoverableBindings,
  collectRelations,
  recoverableBindingContext,
  type QueryMemoryPort,
  type QueryRelation
} from "./query-admission.js";
export {
  FROZEN_SOURCE_PREDICATE_NAMES,
  UNSUPPORTED_POLICY_QUERY_ID
} from "./source-predicates.js";
export { SUPPORTED_FAILED_DEPLOYMENT_QUERY_ID } from "./ordinary-language.js";
export type { OpenRelationCapture } from "./ordinary-language.js";
export {
  ANCHOR_EVENT_VARIABLE,
  SERVICE_VARIABLE,
  UNBOUND_BINDING_CONTEXT,
  USES_SERVICE_RELATION,
  sourceBoundEntityGuard
} from "./ordinary-language.js";

type CompileCommon = Readonly<{
  readonly snapshot_id: string;
  readonly budget: RequestBudget;
  readonly view?: QueryView;
  readonly query_id?: string;
  readonly memory?: QueryMemoryPort;
  readonly authorized_scopes?: readonly string[] | null;
  readonly interpretation_proposal?: QueryInterpretationProposal;
  readonly proposal_registry?: QueryProposalProducerRegistry;
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
  readonly dimension_filter?: readonly string[];
  readonly domain_tag_filter?: readonly string[];
  readonly time_field?: "created_at" | "last_used_at";
  readonly relations?: readonly OpenRelationCapture[];
}>;

export type QueryCompileInput = TypedQueryCompileInput | OrdinaryLanguageCompileInput;

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
  const view = requiredView(input.view);
  const queryId = explicitQueryId(input.query_id);
  if (view === undefined || queryId === "invalid") {
    return interpretationOf({
      query_id: fallbackQueryId(input.query_id, "malformed"),
      status: "malformed",
      snapshot_id: snapshot.data,
      program: typedProgramOrEpsilon(input),
      view: view ?? defaultView(),
      interpretation_clock: input.interpretation_clock
    });
  }
  return input.source === "typed"
    ? compileTyped(input, snapshot.data, budget.data, view, queryId)
    : compileOrdinary(input, snapshot.data, budget.data, view, queryId);
}

function compileTyped(
  input: TypedQueryCompileInput,
  snapshotId: string,
  budget: RequestBudget,
  view: QueryView,
  queryId: string | undefined
): QueryInterpretation {
  const program = QueryProgramSchema.safeParse(input.program);
  const holes = parseItems(input.holes, QueryHoleSchema);
  const hypotheses = parseItems(input.hypotheses, QueryHypothesisSchema);
  const timeWindow = optionalWindow(input.time_window);
  if (
    !program.success
    || holes === undefined
    || hypotheses === undefined
    || timeWindow === "invalid"
  ) {
    return interpretationOf({
      query_id: fallbackQueryId(input.query_id, "malformed"),
      status: "malformed",
      snapshot_id: snapshotId,
      program: program.success ? program.data : EPSILON,
      view,
      interpretation_clock: input.interpretation_clock
    });
  }
  if (associativeCapDomainAdmission(view) === "incompatible") {
    return incompatibleCapInterpretation({
      query_id: queryId,
      snapshot_id: snapshotId,
      program: program.data,
      view,
      interpretation_clock: input.interpretation_clock
    });
  }
  const proposal = admitQueryProposal(
    input.interpretation_proposal,
    stableStringify(program.data),
    input.proposal_registry
  );
  if (proposal.kind === "invalid") {
    return interpretationOf({
      query_id: fallbackQueryId(input.query_id, "malformed"),
      status: "malformed",
      snapshot_id: snapshotId,
      program: program.data,
      view,
      interpretation_clock: input.interpretation_clock
    });
  }
  if (proposal.kind === "unsupported" || proposal.kind === "resource_rejected" || proposal.kind === "malformed") {
    return proposalRejectedInterpretation({
      admission: proposal,
      query_id: queryId,
      snapshot_id: snapshotId,
      program: program.data,
      view,
      interpretation_clock: input.interpretation_clock,
      authorized_scopes: input.authorized_scopes
    });
  }
  const admitted = admitBoundProposalFields({
    program: program.data,
    holes,
    hypotheses
  }, proposal.kind === "admitted" ? proposal : undefined);
  const predicates = admitQueryPredicates(
    admitted.program,
    extraGuardsForAdmission(undefined, proposal.kind === "admitted" ? proposal.conditions : [])
  );
  if (predicates.kind === "malformed") {
    return interpretationOf({
      query_id: fallbackQueryId(input.query_id, "malformed"),
      status: "malformed",
      snapshot_id: snapshotId,
      program: admitted.program,
      view,
      interpretation_clock: input.interpretation_clock
    });
  }
  consumeMemoryIfNeeded(admitted.program, snapshotId, budget, input.memory);
  const admittedHoles = predicates.kind === "unknown"
    ? [...admitted.holes, ...predicates.holes]
    : admitted.holes;
  return interpretationOf({
    query_id: identityFor(queryId, denotationForAdmission(proposal, {
      program: admitted.program,
      view,
      hypotheses: admitted.hypotheses,
      interpretation_clock: input.interpretation_clock,
      time_window: timeWindow,
      authorized_scopes: input.authorized_scopes
    })),
    status: admissionStatus(admitted.program, admittedHoles, admitted.hypotheses),
    snapshot_id: snapshotId,
    program: admitted.program,
    view,
    holes: admittedHoles,
    hypotheses: admitted.hypotheses,
    interpretation_clock: input.interpretation_clock,
    time_window: timeWindow,
    interpretation_proposal: proposal.kind === "admitted" ? proposal.stored_proposal : undefined
  });
}

function typedProgramOrEpsilon(input: QueryCompileInput): QueryProgram {
  if (input.source !== "typed") return EPSILON;
  const parsed = QueryProgramSchema.safeParse(input.program);
  return parsed.success ? parsed.data : EPSILON;
}
