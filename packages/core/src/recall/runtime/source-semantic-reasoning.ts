import {
  canonicalJson, interpretationNodeIdentity, SourceSemanticResourceLedger, SourceSemanticResourceExhausted,
  SourceSemanticInterpretationSchema, SourceSemanticPublishedInterpretationSchema, SOURCE_SEMANTIC_K_VERSION,
  SourceSemanticReasoningRequestSchema, SourceSemanticReasoningResultSchema,
  type InformationIndex, type SourceEvidenceTarget, type SourceSemanticReasoningRequest,
  type SourceSemanticReasoningResult
} from "@do-soul/alaya-protocol";
import { CoreError } from "../../shared/errors.js";
import { fieldContractSha256 } from "../../shared/field-hash.js";
import { compileConditionalFieldQuery } from "../conditional-field/query/compile-query.js";
import { defaultView } from "../conditional-field/query/query-admission.js";
import { admitSourceSemanticCorrespondence } from "../conditional-field/query/source-semantic-correspondence-admission.js";
import { compileSourceSemanticExecution, type SourceSemanticExecutionPlan, type SourceSemanticGroupPhase } from "../conditional-field/query/compile-source-semantic-finite.js";
import { withdrawDerivationLeaves, type FieldEngineState } from "../conditional-field/engine/field-engine.js";
import { observeField } from "./conditional-field-observe.js";
import { compileSourceSemanticPremises, sourceSemanticReaders } from "./source-semantic-premises.js";
import { planSourceSemanticBranches } from "./source-semantic-branch-plan.js";
import { traceSourceSemanticWithdrawals, type SourceSemanticWithdrawalTrace } from "./source-semantic-withdrawal.js";
import { projectSourceSemanticState, type SourceSemanticResultBody as ResultBody } from "./source-semantic-projection.js";
import { sourceSemanticProofDependencies } from "./source-semantic-delivery.js";

export const SOURCE_SEMANTIC_REASONING_BUDGET = { schema_version: 1 as const, work_units: 200000, memory_bytes: 20000000,
  page_budget: 100000, finalization_reserve: 10000, min_envelope: 10 };
export type ReasonSourceSemanticInterpretationInput = Readonly<{
  request?: SourceSemanticReasoningRequest;
  source_interpretation: unknown;
  query_semantics?: unknown;
  semantic_correspondence?: unknown;
  original_query?: string;
  workspaceId: string; scope: string; authorizedScopes: readonly string[] | null; asOf: string;
  sourceValidity?: Readonly<{ valid_from: string | null; valid_to: string | null }>;
  source_target?: SourceEvidenceTarget;
  /** Offline causal diagnostics only; never enabled by normal recall. */
  withdrawal_trial_limit?: number;
}>;
type Prepared = Readonly<{ body: ResultBody; index: InformationIndex | null; withdrawal_trace?: SourceSemanticWithdrawalTrace }>;
export type SourceSemanticInterpretationExecution = Readonly<{
  result: SourceSemanticReasoningResult; index: InformationIndex | null;
  /** Source coordinates from actual selected binding closures, for native support hydration only. */
  source_dependencies?: readonly string[];
  withdrawal_trace?: SourceSemanticWithdrawalTrace;
}>;

/** One budget and one fixed conditional computation; missing semantic preparation never calls a provider. */
export function reasonSourceSemanticInterpretation(input: ReasonSourceSemanticInterpretationInput): SourceSemanticReasoningResult {
  return executeSourceSemanticInterpretation(input).result;
}

/** Same one-source-interpretation and one-semantic-correspondence owner as reason, plus the accepting index that library delivery must reuse. */
export function executeSourceSemanticInterpretation(input: ReasonSourceSemanticInterpretationInput): SourceSemanticInterpretationExecution {
  const request = input.request === undefined ? undefined : SourceSemanticReasoningRequestSchema.parse(input.request);
  const budget = request?.budget ?? SOURCE_SEMANTIC_REASONING_BUDGET, meter = new SourceSemanticResourceLedger(budget);
  const original = request?.original_query ?? input.original_query;
  let body: ResultBody;
  let index: InformationIndex | null = null;
  let withdrawalTrace: SourceSemanticWithdrawalTrace | undefined;
  let sourceDependencies: readonly string[] | undefined;
  if (input.withdrawal_trial_limit !== undefined && (!Number.isInteger(input.withdrawal_trial_limit)
    || input.withdrawal_trial_limit < 1 || input.withdrawal_trial_limit > 64)) throw new CoreError("VALIDATION", "withdrawal trial limit must be 1..64");
  try {
    if (original === undefined || input.query_semantics === undefined || input.semantic_correspondence === undefined) {
      const missing = input.query_semantics === undefined
        ? input.semantic_correspondence === undefined ? "query_semantics_and_correspondence" : "query_semantics"
        : "semantic_correspondence";
      body = { outcome: { status: "preparation_required", missing }, consumed_leaves: [] };
    } else {
      meter.retain(input.source_interpretation, "source interpretation admission");
      meter.retain(input.query_semantics, "query semantics admission");
      meter.retain(input.semantic_correspondence, "semantic correspondence admission");
      const prepared = reasonPrepared(input, original, request, meter);
      body = prepared.body; index = prepared.index;
      withdrawalTrace = prepared.withdrawal_trace;
      if ((body.binding_results?.length ?? 0) > 0) sourceDependencies = sourceSemanticProofDependencies(body, meter);
    }
  } catch (error) {
    if (!(error instanceof SourceSemanticResourceExhausted)) throw error;
    body = { outcome: { status: "resource_exhausted" }, consumed_leaves: [] }; index = null;
  }
  const result = finish({ ...body, resource_usage: { work_units: meter.spentWork, memory_bytes: meter.spentBytes } }, request?.output_byte_limit);
  return { result, index: result.outcome.status === "truncated"
    || result.outcome.status === "resource_exhausted" && result.binding_results === undefined ? null : index,
    ...(result.binding_results === undefined || sourceDependencies === undefined ? {} : { source_dependencies: sourceDependencies }),
    ...(withdrawalTrace === undefined ? {} : { withdrawal_trace: withdrawalTrace }) };
}

function reasonPrepared(input: ReasonSourceSemanticInterpretationInput, original: string,
  request: SourceSemanticReasoningRequest | undefined, meter: SourceSemanticResourceLedger): Prepared {
  const published = SourceSemanticPublishedInterpretationSchema.safeParse(input.source_interpretation);
  const parsed = published.success ? { success: true as const, data: published.data.interpretation }
    : SourceSemanticInterpretationSchema.safeParse(input.source_interpretation);
  if (!parsed.success) return { body: invalid("malformed_interpretation"), index: null };
  if (parsed.data.k_version !== SOURCE_SEMANTIC_K_VERSION) return { body: invalid("unsupported_structural_contract"), index: null };
  const admission = admitSourceSemanticCorrespondence({
    semantic_correspondence: input.semantic_correspondence,
    source_interpretation: parsed.data,
    query_semantics: input.query_semantics,
    original_query: original
  });
  if (admission.kind !== "admitted") return { body: invalid(admission.kind === "unsupported" ? "unsupported_producer" : "malformed_correspondence"), index: null };
  if (request !== undefined && (request.source_interpretation_id !== admission.interpretation_id || request.query_semantics_id !== admission.query_id || request.semantic_correspondence_id !== admission.semantic_correspondence_id)) {
    return { body: invalid("identity_mismatch"), index: null };
  }
  if (input.authorizedScopes !== null && !input.authorizedScopes.includes(input.scope)) return { body: invalid("unauthorized_scope"), index: null };
  const sourceTarget = input.source_target ?? (published.success ? published.data.source_target : undefined) ?? {
    kind: "source_evidence" as const, workspace_id: input.workspaceId, root_kind: "source_record" as const,
    root_id: parsed.data.source.source_id, source_version: parsed.data.source.source_version,
    content_digest: parsed.data.source.content_digest, evidence_object_id: null
  };
  if (sourceTarget.workspace_id !== input.workspaceId || sourceTarget.source_version !== parsed.data.source.source_version
    || sourceTarget.content_digest !== parsed.data.source.content_digest) return { body: invalid("source_binding_mismatch"), index: null };
  const qualified = { conditional_computation_id: admission.context_id, source_interpretation_id: admission.interpretation_id, query_semantics_id: admission.query_id, semantic_correspondence_id: admission.semantic_correspondence_id,
    source_target: sourceTarget, query_gaps: admission.query.gaps };
  const branches = planSourceSemanticBranches(admission.query, admission.semantic_correspondence, meter);
  const population = compileSourceSemanticPremises({ interpretation: admission.interpretation, semantic_correspondence: admission.semantic_correspondence,
    context_id: admission.context_id, interpretation_id: admission.interpretation_id, scope: input.scope,
    source_target: sourceTarget, meter, sourceValidity: input.sourceValidity, query: admission.query, branches });
  const execution = compileSourceSemanticExecution({ source_interpretation: admission.interpretation, query_semantics: admission.query,
    semantic_correspondence: admission.semantic_correspondence, population, meter, branches });
  const seeds = [...admission.interpretation.entry_roots].sort().map((id) => interpretationNodeIdentity(population.coordinates.get(id)!));
  const snapshot = `sha256:${fieldContractSha256(canonicalJson({ conditional_computation_id: admission.context_id, scopes: input.authorizedScopes, as_of: input.asOf }))}`;
  const remaining = { ...(request?.budget ?? SOURCE_SEMANTIC_REASONING_BUDGET), ...meter.remaining() };
  if (remaining.work_units < remaining.finalization_reserve + remaining.min_envelope) throw new SourceSemanticResourceExhausted("engine envelope");
  const phases = execution.groupPhases ?? [];
  if (phases.length > 1) {
    return observeCorrespondenceGroups({
      input, request, meter, original, admission, population, execution, phases, seeds, snapshot, remaining, qualified, sourceTarget
    });
  }
  const program = execution.program;
  const query = compileConditionalFieldQuery({ source: "typed", snapshot_id: snapshot, budget: remaining,
    query_id: `sha256:${fieldContractSha256(canonicalJson({ conditional_computation_id: admission.context_id, query: original }))}`,
    program, interpretation_clock: input.asOf, hypotheses: [{ schema_version: 1, hypothesis_id: admission.context_id, bindings: [] }],
    view: { ...defaultView(), result_kind_view: "mixed", protocol_version: 1, supported_result_kinds: ["source_evidence", "memory_entry"] },
    authorized_scopes: input.authorizedScopes });
  const state = observeField(query, { workspace_id: input.workspaceId, query_text: original, as_of: input.asOf,
    budget: remaining, readers: sourceSemanticReaders(population, seeds), authorized_scopes: input.authorizedScopes });
  const beforeProjection = Math.max(0, state.remaining_exploration + state.remaining_reserve);
  meter.charge(Math.max(0, remaining.work_units - beforeProjection), Math.max(0, remaining.memory_bytes - state.remaining_memory_bytes), "engine");
  if (state.binding.kind !== "bound") return { body: { ...qualified, outcome: { status: "resource_exhausted" }, consumed_leaves: [] }, index: null };
  const prefixWork = meter.spentWork, prefixBytes = meter.spentBytes;
  const projection = { remaining, query, snapshot, admission, population, execution, sourceTarget, qualified };
  const baseline = projectSourceSemanticState({ ...projection, state, meter });
  if (input.withdrawal_trial_limit === undefined) return baseline;
  const withdrawal_trace = traceSourceSemanticWithdrawals({ state, origins: population.origins,
    prefix_resource_usage: { work_units: prefixWork, memory_bytes: prefixBytes },
    baseline: finish(baseline.body), limit: input.withdrawal_trial_limit, project: (withdrawn, _leafId) => {
      const trialMeter = new SourceSemanticResourceLedger(request?.budget ?? SOURCE_SEMANTIC_REASONING_BUDGET);
      let trial: ResultBody;
      try {
        trialMeter.charge(prefixWork, prefixBytes, "same compiled prefix");
        trial = projectSourceSemanticState({ ...projection, state: withdrawn, meter: trialMeter }).body;
      } catch (error) {
        if (!(error instanceof SourceSemanticResourceExhausted)) throw error;
        trial = { ...qualified, outcome: { status: "resource_exhausted" }, consumed_leaves: [] };
      }
      return finish({ ...trial, resource_usage: { work_units: trialMeter.spentWork, memory_bytes: trialMeter.spentBytes } }, request?.output_byte_limit);
    } });
  return { ...baseline, withdrawal_trace };
}

function observeCorrespondenceGroups(input: Readonly<{
  input: ReasonSourceSemanticInterpretationInput; request: SourceSemanticReasoningRequest | undefined;
  meter: SourceSemanticResourceLedger; original: string;
  admission: Extract<ReturnType<typeof admitSourceSemanticCorrespondence>, { kind: "admitted" }>;
  population: ReturnType<typeof compileSourceSemanticPremises>;
  execution: SourceSemanticExecutionPlan; phases: readonly SourceSemanticGroupPhase[];
  seeds: readonly string[]; snapshot: string; remaining: import("@do-soul/alaya-protocol").RequestBudget;
  qualified: Pick<SourceSemanticReasoningResult, "conditional_computation_id" | "source_interpretation_id" | "query_semantics_id" | "semantic_correspondence_id" | "source_target" | "query_gaps">;
  sourceTarget: SourceEvidenceTarget;
}>): Prepared {
  const { request, meter, original, admission, population, snapshot, qualified, sourceTarget } = input;
  type PhaseRun = Readonly<{
    state: FieldEngineState; query: ReturnType<typeof compileConditionalFieldQuery>;
    execution: SourceSemanticExecutionPlan; remaining: typeof input.remaining;
  }>;
  const runs: PhaseRun[] = [];
  let remaining = input.remaining;
  for (const phase of input.phases) {
    if (remaining.work_units < remaining.finalization_reserve + remaining.min_envelope) break;
    const execution = executionForPhase(phase);
    const query = compileConditionalFieldQuery({ source: "typed", snapshot_id: snapshot, budget: remaining,
      query_id: `sha256:${fieldContractSha256(canonicalJson({ conditional_computation_id: admission.context_id, query: original,
        alternative: phase.alternative, target: phase.plan.target, group: phase.groupFrame ?? "" }))}`,
      program: phase.program, interpretation_clock: input.input.asOf,
      hypotheses: [{ schema_version: 1, hypothesis_id: admission.context_id, bindings: [] }],
      view: { ...defaultView(), result_kind_view: "mixed", protocol_version: 1, supported_result_kinds: ["source_evidence", "memory_entry"] },
      authorized_scopes: input.input.authorizedScopes });
    const state = observeField(query, { workspace_id: input.input.workspaceId, query_text: original, as_of: input.input.asOf,
      budget: remaining, readers: sourceSemanticReaders(population, input.seeds), authorized_scopes: input.input.authorizedScopes });
    const beforeProjection = Math.max(0, state.remaining_exploration + state.remaining_reserve);
    meter.charge(Math.max(0, remaining.work_units - beforeProjection), Math.max(0, remaining.memory_bytes - state.remaining_memory_bytes), "engine");
    remaining = { ...remaining, ...meter.remaining(), work_units: Math.max(0, beforeProjection), memory_bytes: state.remaining_memory_bytes };
    if (state.binding.kind === "bound") runs.push({ state, query, execution, remaining });
  }
  if (runs.length === 0) return { body: { ...qualified, outcome: { status: "resource_exhausted" }, consumed_leaves: [] }, index: null };
  const prefixWork = meter.spentWork, prefixBytes = meter.spentBytes;
  const projected = runs.map((run, index) => {
    const result = projectSourceSemanticState({
      state: run.state, meter, remaining: run.remaining, query: run.query, snapshot, admission, population,
      execution: run.execution, sourceTarget, qualified
    });
    const prefix = `g${index}:`;
    return { ...result, body: prefixGroupBody(result.body, prefix), index: prefixGroupIndex(result.index, prefix) };
  });
  const incomplete = runs.length !== input.phases.length || projected.some(row => row.body.outcome.status !== "interpreted");
  const baseline = {
    body: mergeGroupBodies(qualified, projected.map((row) => row.body), incomplete),
    index: mergeGroupIndexes(projected.map((row) => row.index).filter((row): row is NonNullable<typeof row> => row !== null), incomplete)
  };
  if (input.input.withdrawal_trial_limit === undefined) return baseline;
  const withdrawal_trace = traceSourceSemanticWithdrawals({ state: runs[0]!.state, origins: population.origins,
    prefix_resource_usage: { work_units: prefixWork, memory_bytes: prefixBytes },
    baseline: finish(baseline.body), limit: input.input.withdrawal_trial_limit, project: (_withdrawn, leafId) => {
      const trialMeter = new SourceSemanticResourceLedger(request?.budget ?? SOURCE_SEMANTIC_REASONING_BUDGET);
      try {
        trialMeter.charge(prefixWork, prefixBytes, "same compiled prefix");
        const trials = runs.map((run, index) => {
          const state = leafId === undefined ? run.state : withdrawDerivationLeaves(run.state, leafId);
          return prefixGroupBody(projectSourceSemanticState({
            state, meter: trialMeter, remaining: run.remaining, query: run.query, snapshot, admission, population,
            execution: run.execution, sourceTarget, qualified
          }).body, `g${index}:`);
        });
        return finish({ ...mergeGroupBodies(qualified, trials, incomplete),
          resource_usage: { work_units: trialMeter.spentWork, memory_bytes: trialMeter.spentBytes } }, request?.output_byte_limit);
      } catch (error) {
        if (!(error instanceof SourceSemanticResourceExhausted)) throw error;
        return finish({ ...qualified, outcome: { status: "resource_exhausted" }, consumed_leaves: [],
          resource_usage: { work_units: trialMeter.spentWork, memory_bytes: trialMeter.spentBytes } }, request?.output_byte_limit);
      }
    } });
  return { ...baseline, withdrawal_trace };
}

function executionForPhase(phase: SourceSemanticGroupPhase): SourceSemanticExecutionPlan {
  const branches = Array.from({ length: phase.acceptIndex + 1 }, (_, index) => ({
    purpose: "support" as const, alternative: index === phase.acceptIndex ? phase.alternative : 0,
    ...(index === phase.acceptIndex ? { plan: phase.plan } : {})
  }));
  return { program: phase.program, branches, missingOperands: false };
}

function prefixGroupBody(body: ResultBody, prefix: string): ResultBody {
  const rename = (id: string) => `${prefix}${id}`;
  return {
    ...body,
    binding_results: (body.binding_results ?? []).map((row) => ({ ...row, binding_id: rename(row.binding_id), explanation_ids: row.explanation_ids.map(rename) })),
    derivations: (body.derivations ?? []).map((row) => ({ ...row, derivation_id: rename(row.derivation_id), children: row.children.map(rename) }))
  };
}

/** Library occupancy joins answers to index rows by binding id; a group namespace on only one side drops every proof. */
function prefixGroupIndex(index: InformationIndex | null, prefix: string): InformationIndex | null {
  if (index === null) return null;
  const rename = (id: string) => `${prefix}${id}`;
  return {
    ...index,
    entries: index.entries.map((entry) => ({
      ...entry, output_binding: rename(entry.output_binding), explanation_ids: entry.explanation_ids.map(rename)
    })),
    explanations: (index.explanations ?? []).map((row) => ({
      ...row, derivation_id: rename(row.derivation_id), children: row.children.map(rename)
    }))
  };
}

function mergeGroupBodies(qualified: ResultBody extends never ? never : Pick<SourceSemanticReasoningResult, "conditional_computation_id" | "source_interpretation_id" | "query_semantics_id" | "semantic_correspondence_id" | "source_target" | "query_gaps">,
  bodies: readonly ResultBody[], incomplete = false): ResultBody {
  const first = bodies[0]!;
  const open = incomplete || bodies.some(row => row.outcome.status !== "interpreted");
  return {
    ...qualified, ...first,
    binding_results: bodies.flatMap((row) => row.binding_results ?? []),
    derivations: bodies.flatMap((row) => row.derivations ?? []),
    evidence_leaves: bodies.flatMap((row) => row.evidence_leaves ?? []),
    consumed_leaves: bodies.flatMap((row) => row.consumed_leaves ?? []),
    derived_nodes: [...new Map(bodies.flatMap(row => row.derived_nodes ?? []).map(row => [row.node_id, row])).values()],
    ...(open && first.completeness !== undefined ? { completeness: { ...first.completeness, logical_index: "partial" as const,
      observed_coverage: "open" as const, order_coverage: "partial" as const } } : {}),
    outcome: open ? { status: "resource_exhausted" }
      : { status: "interpreted", gaps: first.outcome.status === "interpreted" ? first.outcome.gaps : [] }
  };
}

function mergeGroupIndexes(indexes: InformationIndex[], incomplete = false): InformationIndex | null {
  const first = indexes[0];
  if (first === undefined) return null;
  return { ...first, entries: indexes.flatMap((row) => row.entries), explanations: indexes.flatMap((row) => row.explanations ?? []),
    ...(incomplete ? { completeness: { ...first.completeness, logical_index: "partial" as const, observed_coverage: "open" as const,
      order_coverage: "partial" as const }, order_status: "open" as const } : {}) };
}


function invalid(reason: string): ResultBody { return { outcome: { status: "invalid", reason }, consumed_leaves: [] }; }
function finish(result: ResultBody, outputLimit = 1_000_000): SourceSemanticReasoningResult {
  const parsed = SourceSemanticReasoningResultSchema.safeParse({ contract: "source-interpretation-reasoning-v5",
    semantic_status: "unreviewed", conclusion_scope: "conditional_on_interpretation", world_claim: "unknown", ...result });
  if (!parsed.success) {
    if (parsed.error.issues.some(issue => issue.code !== "too_big")) throw parsed.error;
    return finish({ outcome: { status: "resource_exhausted" }, consumed_leaves: [],
      conditional_computation_id: result.conditional_computation_id, source_interpretation_id: result.source_interpretation_id,
      query_semantics_id: result.query_semantics_id, semantic_correspondence_id: result.semantic_correspondence_id,
      source_target: result.source_target, query_gaps: result.query_gaps, resource_usage: result.resource_usage }, outputLimit);
  }
  const checked = parsed.data;
  if (Buffer.byteLength(JSON.stringify(checked)) <= outputLimit) return checked;
  const limited = SourceSemanticReasoningResultSchema.parse({ contract: checked.contract,
    semantic_status: checked.semantic_status, conclusion_scope: checked.conclusion_scope, world_claim: checked.world_claim,
    conditional_computation_id: checked.conditional_computation_id, source_interpretation_id: checked.source_interpretation_id, query_semantics_id: checked.query_semantics_id, semantic_correspondence_id: checked.semantic_correspondence_id,
    outcome: { status: "truncated" }, consumed_leaves: [], resource_usage: checked.resource_usage });
  if (Buffer.byteLength(JSON.stringify(limited)) > outputLimit) throw new CoreError("VALIDATION", "output budget cannot retain interpretation qualifiers");
  return limited;
}
