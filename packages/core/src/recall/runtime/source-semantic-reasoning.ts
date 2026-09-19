import {
  canonicalJson, interpretationNodeIdentity, SourceSemanticResourceLedger, SourceSemanticResourceExhausted,
  SourceSemanticInterpretationSchema, SourceSemanticPublishedInterpretationSchema, SOURCE_SEMANTIC_K_VERSION,
  SourceSemanticReasoningRequestSchema, SourceSemanticReasoningResultSchema,
  type SourceEvidenceTarget, type SourceSemanticReasoningRequest, type SourceSemanticReasoningResult
} from "@do-soul/alaya-protocol";
import { CoreError } from "../../shared/errors.js";
import { fieldContractSha256 } from "../../shared/field-hash.js";
import { compileConditionalFieldQuery } from "../conditional-field/query/compile-query.js";
import { defaultView } from "../conditional-field/query/query-admission.js";
import { admitSourceSemanticAlignment } from "../conditional-field/query/source-semantic-alignment-admission.js";
import { compileSourceSemanticExecution } from "../conditional-field/query/compile-source-semantic-finite.js";
import { observeField } from "./conditional-field-observe.js";
import { projectAcceptingIndex } from "../conditional-field/index/project-accepting-index.js";
import { compileSourceSemanticPremises, sourceSemanticReaders } from "./source-semantic-premises.js";
import { deliverSourceSemanticProof } from "./source-semantic-delivery.js";

const BUDGET = { schema_version: 1 as const, work_units: 200000, memory_bytes: 20000000,
  page_budget: 100000, finalization_reserve: 10000, min_envelope: 10 };
export type ReasonSourceSemanticInterpretationInput = Readonly<{
  request?: SourceSemanticReasoningRequest; h: unknown; q?: unknown; a?: unknown; original_query?: string;
  workspaceId: string; scope: string; authorizedScopes: readonly string[] | null; asOf: string;
  sourceValidity?: Readonly<{ valid_from: string | null; valid_to: string | null }>;
  source_target?: SourceEvidenceTarget;
}>;
type ResultBody = Omit<SourceSemanticReasoningResult, "contract" | "semantic_status" | "conclusion_scope" | "world_claim">;

/** One budget and one fixed C; missing semantic preparation never calls a provider. */
export function reasonSourceSemanticInterpretation(input: ReasonSourceSemanticInterpretationInput): SourceSemanticReasoningResult {
  const request = input.request === undefined ? undefined : SourceSemanticReasoningRequestSchema.parse(input.request);
  const budget = request?.budget ?? BUDGET, meter = new SourceSemanticResourceLedger(budget);
  const original = request?.original_query ?? input.original_query;
  let result: ResultBody;
  try {
    if (original === undefined || input.q === undefined || input.a === undefined) {
      const missing = input.q === undefined ? input.a === undefined ? "q_and_a" : "q" : "a";
      result = { outcome: { status: "preparation_required", missing }, consumed_leaves: [] };
    } else {
      meter.retain(input.h, "H admission"); meter.retain(input.q, "Q admission"); meter.retain(input.a, "A admission");
      result = reasonPrepared(input, original, request, meter);
    }
  } catch (error) {
    if (!(error instanceof SourceSemanticResourceExhausted)) throw error;
    result = { outcome: { status: "resource_exhausted" }, consumed_leaves: [] };
  }
  return finish({ ...result, resource_usage: { work_units: meter.spentWork, memory_bytes: meter.spentBytes } }, request?.output_byte_limit);
}

function reasonPrepared(input: ReasonSourceSemanticInterpretationInput, original: string,
  request: SourceSemanticReasoningRequest | undefined, meter: SourceSemanticResourceLedger): ResultBody {
  const published = SourceSemanticPublishedInterpretationSchema.safeParse(input.h);
  const parsed = published.success ? { success: true as const, data: published.data.interpretation }
    : SourceSemanticInterpretationSchema.safeParse(input.h);
  if (!parsed.success) return invalid("malformed_interpretation");
  if (parsed.data.k_version !== SOURCE_SEMANTIC_K_VERSION) return invalid("unsupported_structural_contract");
  const admission = admitSourceSemanticAlignment({ alignment: input.a, h: parsed.data, q: input.q, original_query: original });
  if (admission.kind !== "admitted") return invalid(admission.kind === "unsupported" ? "unsupported_producer" : "malformed_alignment");
  if (request !== undefined && (request.h_id !== admission.interpretation_id || request.q_id !== admission.query_id || request.a_id !== admission.alignment_id)) {
    return invalid("identity_mismatch");
  }
  if (input.authorizedScopes !== null && !input.authorizedScopes.includes(input.scope)) return invalid("unauthorized_scope");
  const sourceTarget = input.source_target ?? (published.success ? published.data.source_target : undefined) ?? {
    kind: "source_evidence" as const, workspace_id: input.workspaceId, root_kind: "source_record" as const,
    root_id: parsed.data.source.source_id, source_version: parsed.data.source.source_version,
    content_digest: parsed.data.source.content_digest, evidence_object_id: null
  };
  if (sourceTarget.workspace_id !== input.workspaceId || sourceTarget.source_version !== parsed.data.source.source_version
    || sourceTarget.content_digest !== parsed.data.source.content_digest) return invalid("source_binding_mismatch");
  const qualified = { c_id: admission.context_id, h_id: admission.interpretation_id, q_id: admission.query_id, a_id: admission.alignment_id,
    source_target: sourceTarget, query_gaps: admission.query.gaps };
  const population = compileSourceSemanticPremises({ interpretation: admission.interpretation, alignment: admission.alignment,
    context_id: admission.context_id, interpretation_id: admission.interpretation_id, scope: input.scope,
    source_target: sourceTarget, meter, sourceValidity: input.sourceValidity, query: admission.query });
  const execution = compileSourceSemanticExecution({ h: admission.interpretation, q: admission.query,
    a: admission.alignment, population, meter });
  const program = execution.program;
  const seeds = [...admission.interpretation.entry_roots].sort().map((id) => interpretationNodeIdentity(population.coordinates.get(id)!));
  const snapshot = `sha256:${fieldContractSha256(canonicalJson({ c: admission.context_id, scopes: input.authorizedScopes, as_of: input.asOf }))}`;
  const remaining = { ...(request?.budget ?? BUDGET), ...meter.remaining() };
  if (remaining.work_units < remaining.finalization_reserve + remaining.min_envelope) throw new SourceSemanticResourceExhausted("engine envelope");
  const query = compileConditionalFieldQuery({ source: "typed", snapshot_id: snapshot, budget: remaining,
    query_id: `sha256:${fieldContractSha256(canonicalJson({ c: admission.context_id, query: original }))}`,
    program, interpretation_clock: input.asOf, hypotheses: [{ schema_version: 1, hypothesis_id: admission.context_id, bindings: [] }],
    view: { ...defaultView(), result_kind_view: "mixed", protocol_version: 1, supported_result_kinds: ["source_evidence", "memory_entry"] },
    authorized_scopes: input.authorizedScopes });
  const state = observeField(query, { workspace_id: input.workspaceId, query_text: original, as_of: input.asOf,
    budget: remaining, readers: sourceSemanticReaders(population, seeds), authorized_scopes: input.authorizedScopes });
  const beforeProjection = Math.max(0, state.remaining_exploration + state.remaining_reserve);
  meter.charge(Math.max(0, remaining.work_units - beforeProjection), Math.max(0, remaining.memory_bytes - state.remaining_memory_bytes), "engine");
  if (state.binding.kind !== "bound") return { ...qualified, outcome: { status: "resource_exhausted" }, consumed_leaves: [] };
  let afterProjection = beforeProjection;
  const index = projectAcceptingIndex({ snapshot: state.binding.snapshot, view: query.view, query_id: query.query_id,
    snapshot_id: snapshot, result_version: "source-interpretation-reasoning-v3",
    budget: { ...remaining, work_units: state.remaining_exploration, memory_bytes: state.remaining_memory_bytes },
    binding_contexts: state.binding_contexts,
    selected_semantics: { h: admission.interpretation, context: admission.context, source_target: sourceTarget,
      compiled_nodes: population.coordinates },
    observer: { outcome: { schema_version: 1, status: state.closure.observation }, open_regions: state.residuals },
    interpretation_status: query.status, resume_cursors: state.resume_cursors,
    remaining_reserve: beforeProjection, on_remaining_reserve: (value) => { afterProjection = value; },
    resource_work: state.memory_exhausted || state.remaining_work.length > 0 ? "open" : "complete",
    transition_derivations: state.transition_derivations, grounding_progress: state.grounding_progress,
    grounding_transitions: [...state.transitions], grounding_seeds: [...state.seeds], grounding_derivations: [...state.derivations],
    derivations: [...state.derivations], projection_facets: [...state.facets], remaining_memory_bytes: state.remaining_memory_bytes });
  meter.charge(Math.max(0, beforeProjection - afterProjection), 0, "index projection");
  if (index.entries.some((entry) => entry.interpretation_node?.packet_id !== admission.interpretation_id || entry.hypothesis_id !== admission.context_id)) {
    throw new CoreError("OBLIGATION_VIOLATION", "conditional result escaped its evaluation context");
  }
  const { proofComplete, ...proof } = deliverSourceSemanticProof({ index, query: admission.query, population,
    bindings: state.binding_contexts, meter, execution });
  const complete = proofComplete && state.binding.solver_complete && state.closure.observation === "exhausted"
    && !state.memory_exhausted && state.remaining_work.length === 0 && index.continuation === null
    && Object.entries(index.completeness).every(([key, value]) => ["schema_version", "certificate_id", "interpretation_coverage"].includes(key)
      || value === "complete" || key === "observed_coverage" && value === "exhausted_empty");
  return { ...qualified, ...proof, completeness: index.completeness,
    outcome: complete ? { status: "interpreted", gaps: admission.interpretation.gaps } : { status: "resource_exhausted" } };
}

function invalid(reason: string): ResultBody { return { outcome: { status: "invalid", reason }, consumed_leaves: [] }; }
function finish(result: ResultBody, outputLimit = 1_000_000): SourceSemanticReasoningResult {
  const checked = SourceSemanticReasoningResultSchema.parse({ contract: "source-interpretation-reasoning-v3",
    semantic_status: "unreviewed", conclusion_scope: "conditional_on_interpretation", world_claim: "unknown", ...result });
  if (Buffer.byteLength(JSON.stringify(checked)) <= outputLimit) return checked;
  const limited = SourceSemanticReasoningResultSchema.parse({ contract: checked.contract,
    semantic_status: checked.semantic_status, conclusion_scope: checked.conclusion_scope, world_claim: checked.world_claim,
    c_id: checked.c_id, h_id: checked.h_id, q_id: checked.q_id, a_id: checked.a_id,
    outcome: { status: "truncated" }, consumed_leaves: [], resource_usage: checked.resource_usage });
  if (Buffer.byteLength(JSON.stringify(limited)) > outputLimit) throw new CoreError("VALIDATION", "output budget cannot retain interpretation qualifiers");
  return limited;
}
