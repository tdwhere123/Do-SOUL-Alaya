import {
  canonicalJson, interpretationNodeIdentity, assertSourceInterpretationQueryProfile, assertSourceInterpretationPacketProfile, SourceInterpretationReasoningRequestSchema,
  SourceInterpretationReasoningResultSchema, type PublishedSourceInterpretationPacket,
  type SourceInterpretationReasoningRequest, type SourceInterpretationReasoningResult
} from "@do-soul/alaya-protocol";
import { CoreError } from "../../shared/errors.js";
import { fieldContractSha256 } from "../../shared/field-hash.js";
import { compileConditionalFieldQuery } from "../conditional-field/query/compile-query.js";
import { defaultView } from "../conditional-field/query/query-admission.js";
import { admitProposedProgram } from "../conditional-field/query/query-proposal-admission.js";
import { observeField } from "./conditional-field-observe.js";
import { projectAcceptingIndex } from "../conditional-field/index/project-accepting-index.js";
import { compileSourceInterpretationPremises, InterpretationPreparationLimit, sourceInterpretationReaders } from "./source-interpretation-premises.js";

/** Uses the same typed query, observation, composition, max/min and accepting-index owners as Recall. */
export function reasonSourceInterpretation(input: Readonly<{
  sourceValidity?: Readonly<{ valid_from: string | null; valid_to: string | null }>;
  request: SourceInterpretationReasoningRequest; bound: PublishedSourceInterpretationPacket;
  native?: Readonly<{ work: number; bytes: number }>;
  workspaceId: string; scope: string; authorizedScopes: readonly string[] | null; asOf: string;
}>): SourceInterpretationReasoningResult {
  const request = SourceInterpretationReasoningRequestSchema.parse(input.request);
  const { bound } = input;
  if (bound.source_target.workspace_id !== input.workspaceId || request.packet_id !== bound.packet_id ||
      request.profile_id !== bound.packet.profile_id || bound.hypothesis_id !== bound.packet_id) {
    throw new CoreError("VALIDATION", "query does not bind the published interpretation packet");
  }
  if (input.authorizedScopes !== null && !input.authorizedScopes.includes(input.scope)) {
    throw new CoreError("VALIDATION", "interpretation source is outside authorized scopes");
  }
  assertSourceInterpretationPacketProfile(bound.packet, bound.profile, fieldContractSha256);
  assertSourceInterpretationQueryProfile(request.program, bound.profile);
  const packetBytes = Buffer.byteLength(JSON.stringify(bound));
  const interpretation = { packet_id: bound.packet_id, hypothesis_id: bound.hypothesis_id,
    semantic_status: "unreviewed" as const, conclusion_scope: "conditional_on_interpretation" as const,
    world_claim: "unknown" as const, source_target: bound.source_target };
  const finish = (result: SourceInterpretationReasoningResult): SourceInterpretationReasoningResult => {
    const checked = SourceInterpretationReasoningResultSchema.parse(result);
    if (Buffer.byteLength(JSON.stringify(checked)) <= request.output_byte_limit) return checked;
    const limited = { ...checked, status: "output_limited" as const, index: null, interpretation_packet: null, premises: [] };
    if (Buffer.byteLength(JSON.stringify(limited)) > request.output_byte_limit) {
      throw new CoreError("VALIDATION", "output budget cannot retain mandatory interpretation qualifier");
    }
    return limited;
  };
  const incomplete = (premises = 0, preparation_work = 0, engine_work = 0): SourceInterpretationReasoningResult => finish({ contract: request.contract,
    status: "incomplete", computation_status: "incomplete", interpretation, index: null, interpretation_packet: null, premises: [], work: { packet_bytes: packetBytes, premise_count: premises, engine_work, projection_work: 0, preparation_work, native_work: input.native?.work ?? 0, native_bytes: input.native?.bytes ?? 0 } });
  if (packetBytes > request.budget.memory_bytes || request.budget.work_units < bound.packet.mentions.length + 1) return incomplete();
  let population;
  try { population = compileSourceInterpretationPremises(bound, input.scope, request.budget, input.sourceValidity); }
  catch (error) { if (error instanceof InterpretationPreparationLimit) return incomplete(0, error.work); throw error; }
  const preparation = population.work;
  const retainedBytes = population.bytes;
  const seeds = request.seed_nodes.map((id) => {
    const coordinate = population.coordinates.get(id);
    if (coordinate === undefined) throw new CoreError("VALIDATION", "query seed is not a node in its hypothesis");
    return interpretationNodeIdentity(coordinate);
  });
  const snapshot = `sha256:${fieldContractSha256(canonicalJson({ packet: bound.packet_id, source: bound.source_target,
    scopes: input.authorizedScopes, as_of: input.asOf }))}`;
  const budget = { ...request.budget, work_units: request.budget.work_units - preparation,
    memory_bytes: request.budget.memory_bytes - retainedBytes };
  const query = compileConditionalFieldQuery({ source: "typed", snapshot_id: snapshot, budget,
    query_id: `sha256:${fieldContractSha256(canonicalJson(request))}`, program: admitProposedProgram(request.program),
    interpretation_clock: input.asOf, hypotheses: [{ schema_version: 1, hypothesis_id: bound.hypothesis_id, bindings: [] }],
    view: { ...defaultView(), result_kind_view: "mixed", protocol_version: 1,
      supported_result_kinds: ["source_evidence", "memory_entry"] }, authorized_scopes: input.authorizedScopes });
  const state = observeField(query, { workspace_id: input.workspaceId, query_text: request.original_query,
    as_of: input.asOf, budget, readers: sourceInterpretationReaders(population, seeds), authorized_scopes: input.authorizedScopes });
  if (state.binding.kind !== "bound") return incomplete(population.rows.length, preparation,
    budget.work_units - state.remaining_exploration - state.remaining_reserve);
  const beforeProjection = state.remaining_exploration + state.remaining_reserve;
  let afterProjection = beforeProjection;
  const index = projectAcceptingIndex({ snapshot: state.binding.snapshot, view: query.view,
    query_id: query.query_id, snapshot_id: snapshot, result_version: "source-interpretation-reasoning-v1",
    budget: { ...budget, work_units: state.remaining_exploration, memory_bytes: state.remaining_memory_bytes },
    binding_contexts: state.binding_contexts,
    observer: { outcome: { schema_version: 1, status: state.closure.observation }, open_regions: state.residuals },
    interpretation_status: query.status, resume_cursors: state.resume_cursors,
    selected_interpretation: bound,
    remaining_reserve: beforeProjection,
    on_remaining_reserve: (remaining) => { afterProjection = remaining; },
    resource_work: state.memory_exhausted || state.remaining_work.length > 0 ? "open" : "complete",
    transition_derivations: state.transition_derivations,
    grounding_progress: state.grounding_progress, grounding_transitions: [...state.transitions],
    grounding_seeds: [...state.seeds], grounding_derivations: [...state.derivations],
    derivations: [...state.derivations], projection_facets: [...state.facets],
    remaining_memory_bytes: state.remaining_memory_bytes });
  if (index.entries.some((entry) => entry.interpretation_node?.packet_id !== bound.packet_id || entry.hypothesis_id !== bound.hypothesis_id)) {
    throw new CoreError("OBLIGATION_VIOLATION", "conditional result escaped its admitted hypothesis");
  }
  const consumed = new Set((index.explanations ?? []).flatMap((row) => row.observation_ids));
  const premises = [...consumed].flatMap((id) => {
    const origin = population.origins.get(id);
    return origin === undefined ? [] : [origin];
  });
  const computationComplete = state.binding.solver_complete && state.closure.observation === "exhausted" &&
    !state.memory_exhausted && state.remaining_work.length === 0 &&
    Object.entries(index.completeness).every(([key, value]) => ["schema_version", "certificate_id", "interpretation_coverage"].includes(key) ||
      value === "complete" || (key === "observed_coverage" && value === "exhausted_empty"));
  const result = SourceInterpretationReasoningResultSchema.parse({ contract: request.contract,
    computation_status: computationComplete ? "complete" : "incomplete",
    status: state.binding.solver_complete && state.closure.observation === "exhausted" &&
      Object.entries(index.completeness).every(([key, value]) => key === "schema_version" || key === "certificate_id" || value === "complete")
      ? "complete" : "incomplete", interpretation, index, interpretation_packet: bound, premises,
    work: { packet_bytes: packetBytes, premise_count: population.rows.length,
      preparation_work: preparation, native_work: input.native?.work ?? 0, native_bytes: input.native?.bytes ?? 0,
      projection_work: beforeProjection - afterProjection, engine_work: budget.work_units - beforeProjection } });
  // The qualifier is mandatory. No truncation path can emit its conclusion alone.
  return finish(result);
}
