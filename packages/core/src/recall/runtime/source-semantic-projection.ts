import { SourceSemanticResourceExhausted, type SourceSemanticResourceLedger, type SourceSemanticReasoningResult,
  type SourceEvidenceTarget, type RequestBudget } from "@do-soul/alaya-protocol";
import { CoreError } from "../../shared/errors.js";
import type { FieldEngineState } from "../conditional-field/engine/field-engine.js";
import { projectAcceptingIndex } from "../conditional-field/index/project-accepting-index.js";
import type { compileConditionalFieldQuery } from "../conditional-field/query/compile-query.js";
import type { admitSourceSemanticCorrespondence } from "../conditional-field/query/source-semantic-correspondence-admission.js";
import type { SourceSemanticExecutionPlan } from "../conditional-field/query/compile-source-semantic-finite.js";
import type { SourceSemanticPremisePopulation } from "./source-semantic-premises.js";
import { deliverSourceSemanticProof } from "./source-semantic-delivery.js";

export type SourceSemanticResultBody = Omit<SourceSemanticReasoningResult, "contract" | "semantic_status" | "conclusion_scope" | "world_claim">;

/** Normal execution and same-state withdrawal share precisely this required projection/delivery phase. */
export function projectSourceSemanticState(input: Readonly<{
  state: FieldEngineState; meter: SourceSemanticResourceLedger; remaining: RequestBudget;
  query: ReturnType<typeof compileConditionalFieldQuery>; snapshot: string;
  admission: Extract<ReturnType<typeof admitSourceSemanticCorrespondence>, { kind: "admitted" }>;
  population: SourceSemanticPremisePopulation; execution: SourceSemanticExecutionPlan;
  sourceTarget: SourceEvidenceTarget;
  qualified: Pick<SourceSemanticReasoningResult, "conditional_computation_id" | "source_interpretation_id" | "query_semantics_id" | "semantic_correspondence_id" | "source_target" | "query_gaps">;
}>) {
  const { state, meter, remaining, query, snapshot, admission, population, execution, sourceTarget, qualified } = input;
  if (state.binding.kind !== "bound") return {
    body: { ...qualified, outcome: { status: "resource_exhausted" }, consumed_leaves: [] } as SourceSemanticResultBody, index: null
  };
  // Observations and earlier groups have already spent the shared ledger. A state's
  // observation-time allowance is only an upper bound, never a fresh grant.
  const available = meter.remaining();
  const beforeProjection = Math.min(Math.max(0, state.remaining_exploration + state.remaining_reserve), available.work_units);
  const projectionBudget = { ...remaining, work_units: Math.min(state.remaining_exploration, available.work_units),
    memory_bytes: Math.min(state.remaining_memory_bytes, available.memory_bytes) };
  if (projectionBudget.work_units < remaining.finalization_reserve + remaining.min_envelope
    || projectionBudget.memory_bytes < remaining.min_envelope) {
    throw new SourceSemanticResourceExhausted("index projection allowance");
  }
  let afterProjection = beforeProjection;
  const index = { ...projectAcceptingIndex({ snapshot: state.binding.snapshot, view: query.view, query_id: query.query_id,
    snapshot_id: snapshot, result_version: "source-interpretation-reasoning-v5",
    budget: projectionBudget,
    binding_contexts: state.binding_contexts,
    selected_semantics: { source_interpretation: admission.interpretation, context: admission.context, source_target: sourceTarget,
      compiled_nodes: population.coordinates },
    observer: { outcome: { schema_version: 1, status: state.closure.observation }, open_regions: state.residuals },
    interpretation_status: query.status, resume_cursors: state.resume_cursors,
    remaining_reserve: beforeProjection, on_remaining_reserve: (value) => { afterProjection = value; },
    resource_work: state.memory_exhausted || state.remaining_work.length > 0 ? "open" : "complete",
    transition_derivations: state.transition_derivations, grounding_progress: state.grounding_progress,
    grounding_transitions: [...state.transitions], grounding_seeds: [...state.seeds], grounding_derivations: [...state.derivations],
    derivations: [...state.derivations], projection_facets: [...state.facets], remaining_memory_bytes: projectionBudget.memory_bytes }),
    as_of: query.interpretation_clock };
  meter.charge(Math.max(0, beforeProjection - afterProjection), 0, "index projection");
  if (index.entries.some((entry) => entry.interpretation_node?.packet_id !== admission.interpretation_id || entry.hypothesis_id !== admission.context_id)) {
    throw new CoreError("OBLIGATION_VIOLATION", "conditional result escaped its evaluation context");
  }
  const { proofComplete, acceptedBranchIndices, ...proof } = deliverSourceSemanticProof({ index, query: admission.query, population,
    bindings: state.binding_contexts, meter, execution });
  const complete = proofComplete && state.binding.solver_complete && state.closure.observation === "exhausted"
    && !state.memory_exhausted && state.remaining_work.length === 0 && index.continuation === null
    && Object.entries(index.completeness).every(([key, value]) => ["schema_version", "certificate_id", "interpretation_coverage"].includes(key)
      || value === "complete" || key === "observed_coverage" && value === "exhausted_empty");
  const body: SourceSemanticResultBody = { ...qualified, ...proof, completeness: index.completeness,
    outcome: complete ? { status: "interpreted", gaps: admission.interpretation.gaps } : { status: "resource_exhausted" } };
  return { body, index, acceptedBranchIndices };
}
