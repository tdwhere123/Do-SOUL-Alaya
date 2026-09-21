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
import { admitSourceSemanticAlignment } from "../conditional-field/query/source-semantic-alignment-admission.js";
import { compileSourceSemanticExecution } from "../conditional-field/query/compile-source-semantic-finite.js";
import { observeField } from "./conditional-field-observe.js";
import { compileSourceSemanticPremises, sourceSemanticReaders } from "./source-semantic-premises.js";
import { traceSourceSemanticWithdrawals, type SourceSemanticWithdrawalTrace } from "./source-semantic-withdrawal.js";
import { projectSourceSemanticState, type SourceSemanticResultBody as ResultBody } from "./source-semantic-projection.js";

const BUDGET = { schema_version: 1 as const, work_units: 200000, memory_bytes: 20000000,
  page_budget: 100000, finalization_reserve: 10000, min_envelope: 10 };
export type ReasonSourceSemanticInterpretationInput = Readonly<{
  request?: SourceSemanticReasoningRequest; h: unknown; q?: unknown; a?: unknown; original_query?: string;
  workspaceId: string; scope: string; authorizedScopes: readonly string[] | null; asOf: string;
  sourceValidity?: Readonly<{ valid_from: string | null; valid_to: string | null }>;
  source_target?: SourceEvidenceTarget;
  /** Offline causal diagnostics only; never enabled by normal recall. */
  withdrawal_trial_limit?: number;
}>;
type Prepared = Readonly<{ body: ResultBody; index: InformationIndex | null; withdrawal_trace?: SourceSemanticWithdrawalTrace }>;
export type SourceSemanticInterpretationExecution = Readonly<{
  result: SourceSemanticReasoningResult; index: InformationIndex | null;
  withdrawal_trace?: SourceSemanticWithdrawalTrace;
}>;

/** One budget and one fixed C; missing semantic preparation never calls a provider. */
export function reasonSourceSemanticInterpretation(input: ReasonSourceSemanticInterpretationInput): SourceSemanticReasoningResult {
  return executeSourceSemanticInterpretation(input).result;
}

/** Same one-H/one-A owner as reason, plus the accepting index that library delivery must reuse. */
export function executeSourceSemanticInterpretation(input: ReasonSourceSemanticInterpretationInput): SourceSemanticInterpretationExecution {
  const request = input.request === undefined ? undefined : SourceSemanticReasoningRequestSchema.parse(input.request);
  const budget = request?.budget ?? BUDGET, meter = new SourceSemanticResourceLedger(budget);
  const original = request?.original_query ?? input.original_query;
  let body: ResultBody;
  let index: InformationIndex | null = null;
  let withdrawalTrace: SourceSemanticWithdrawalTrace | undefined;
  if (input.withdrawal_trial_limit !== undefined && (!Number.isInteger(input.withdrawal_trial_limit)
    || input.withdrawal_trial_limit < 1 || input.withdrawal_trial_limit > 64)) throw new CoreError("VALIDATION", "withdrawal trial limit must be 1..64");
  try {
    if (original === undefined || input.q === undefined || input.a === undefined) {
      const missing = input.q === undefined ? input.a === undefined ? "q_and_a" : "q" : "a";
      body = { outcome: { status: "preparation_required", missing }, consumed_leaves: [] };
    } else {
      meter.retain(input.h, "H admission"); meter.retain(input.q, "Q admission"); meter.retain(input.a, "A admission");
      const prepared = reasonPrepared(input, original, request, meter);
      body = prepared.body; index = prepared.index;
      withdrawalTrace = prepared.withdrawal_trace;
    }
  } catch (error) {
    if (!(error instanceof SourceSemanticResourceExhausted)) throw error;
    body = { outcome: { status: "resource_exhausted" }, consumed_leaves: [] }; index = null;
  }
  const result = finish({ ...body, resource_usage: { work_units: meter.spentWork, memory_bytes: meter.spentBytes } }, request?.output_byte_limit);
  return { result, index: result.outcome.status === "truncated" ? null : index,
    ...(withdrawalTrace === undefined ? {} : { withdrawal_trace: withdrawalTrace }) };
}

function reasonPrepared(input: ReasonSourceSemanticInterpretationInput, original: string,
  request: SourceSemanticReasoningRequest | undefined, meter: SourceSemanticResourceLedger): Prepared {
  const published = SourceSemanticPublishedInterpretationSchema.safeParse(input.h);
  const parsed = published.success ? { success: true as const, data: published.data.interpretation }
    : SourceSemanticInterpretationSchema.safeParse(input.h);
  if (!parsed.success) return { body: invalid("malformed_interpretation"), index: null };
  if (parsed.data.k_version !== SOURCE_SEMANTIC_K_VERSION) return { body: invalid("unsupported_structural_contract"), index: null };
  const admission = admitSourceSemanticAlignment({ alignment: input.a, h: parsed.data, q: input.q, original_query: original });
  if (admission.kind !== "admitted") return { body: invalid(admission.kind === "unsupported" ? "unsupported_producer" : "malformed_alignment"), index: null };
  if (request !== undefined && (request.h_id !== admission.interpretation_id || request.q_id !== admission.query_id || request.a_id !== admission.alignment_id)) {
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
  if (state.binding.kind !== "bound") return { body: { ...qualified, outcome: { status: "resource_exhausted" }, consumed_leaves: [] }, index: null };
  const prefixWork = meter.spentWork, prefixBytes = meter.spentBytes;
  const projection = { remaining, query, snapshot, admission, population, execution, sourceTarget, qualified };
  const baseline = projectSourceSemanticState({ ...projection, state, meter });
  if (input.withdrawal_trial_limit === undefined) return baseline;
  const withdrawal_trace = traceSourceSemanticWithdrawals({ state, origins: population.origins,
    prefix_resource_usage: { work_units: prefixWork, memory_bytes: prefixBytes },
    baseline: finish(baseline.body), limit: input.withdrawal_trial_limit, project: (withdrawn) => {
      const trialMeter = new SourceSemanticResourceLedger(request?.budget ?? BUDGET);
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
