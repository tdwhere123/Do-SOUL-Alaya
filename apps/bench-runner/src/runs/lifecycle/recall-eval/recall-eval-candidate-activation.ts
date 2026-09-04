import type { FineAssessmentDiagnosticCapture } from
  "@do-soul/alaya-core";
import type { BenchRecallOptions } from "../../../harness/daemon.js";
import type { RecallEvalQuestionResult } from "./recall-eval-contract.js";

type ShadowTrace = FineAssessmentDiagnosticCapture["result"]["shadowTrace"];
type CapturedShadowTrace = Extract<NonNullable<ShadowTrace>, { kind: "captured" }>;

export function createCandidateActivationCapture(enabled: boolean): Readonly<{
  observer: BenchRecallOptions["diagnosticObserver"];
  attach(result: RecallEvalQuestionResult): RecallEvalQuestionResult;
}> {
  let entries: readonly (readonly [string, unknown])[] | undefined;
  let shadowTrace: ShadowTrace | undefined;

  const observer = enabled ? (capture: FineAssessmentDiagnosticCapture) => {
    try {
      entries = capture.supplementaryData
        .openSemanticFactorCandidateActivationsByCandidateKey === undefined
        ? []
        : [...capture.supplementaryData
          .openSemanticFactorCandidateActivationsByCandidateKey.entries()];
      shadowTrace = capture.result.shadowTrace;
    } catch {
      entries = undefined;
      shadowTrace = undefined;
    }
    return undefined;
  } : undefined;

  return {
    observer,
    attach: (result) => {
      if (!enabled) return result;
      return {
        ...result,
        diagnostics: {
          ...result.diagnostics,
          ...(entries === undefined ? {} : {
            open_semantic_factor_candidate_activations: [...entries]
              .sort(([left], [right]) => compareCodeUnits(left, right))
              .map(([candidate_key, receipt]) => ({ candidate_key, receipt }))
          }),
          target_decision_trace: projectShadowTrace(shadowTrace)
        }
      } as RecallEvalQuestionResult;
    }
  };
}

function projectShadowTrace(trace: ShadowTrace | undefined): Record<string, unknown> {
  if (trace === undefined) {
    return explicitMissing("unavailable", "shadow_trace_missing");
  }
  if (trace.kind === "fail_closed") {
    return explicitMissing("failed", trace.reason);
  }
  return {
    ...projectPreview(trace.query_proof_preview, trace.prefix_proposal),
    ...projectPsiV2(trace.psi_v2_shadow),
    ...projectDeliveryPack(trace.delivery_pack),
    ...projectSidecarDigests(trace),
    ...projectCandidateDispositions(trace)
  };
}

function explicitMissing(
  status: "unavailable" | "failed",
  reason: string
): Record<string, unknown> {
  return {
    status,
    fail_reason: reason,
    psi_v2_status: "unavailable",
    psi_v2_pair_states_status: "unavailable",
    cycle_status: "unavailable",
    uncertainty_status: "unavailable",
    gamma_compile_status: "unavailable",
    candidate_dispositions_status: "unavailable"
  };
}

function projectPreview(
  preview: CapturedShadowTrace["query_proof_preview"],
  prefixProposal: CapturedShadowTrace["prefix_proposal"] | undefined
): Record<string, unknown> {
  const prefix = Array.isArray(prefixProposal)
    ? { current_delivered_prefix: prefixProposal }
    : {};
  if (preview === undefined) {
    return {
      status: "unavailable",
      fail_reason: "preview_not_captured",
      gamma_compile_status: "unavailable",
      ...prefix
    };
  }
  if (preview.status !== "captured") {
    return {
      status: "failed",
      fail_reason: preview.reason ?? "preview_not_captured",
      gamma_compile_status: "failed",
      ...(preview.contract_digest === undefined ? {} : { gamma_digest: preview.contract_digest }),
      ...prefix
    };
  }
  return { ...projectCapturedPreview(preview), ...prefix };
}

function projectCapturedPreview(
  preview: NonNullable<CapturedShadowTrace["query_proof_preview"]>
): Record<string, unknown> {
  const record = asRecord(preview) ?? {};
  const disposition = optionalString(record, "compile_disposition")
    ?? optionalString(record, "gamma_compile_disposition");
  const digest = optionalString(record, "gamma_digest") ?? preview.contract_digest;
  return {
    status: "captured",
    gamma_compile_status: "captured",
    ...(disposition === undefined ? {} : { gamma_compile_disposition: disposition }),
    ...(digest === undefined ? {} : { gamma_digest: digest }),
    ...(preview.prefix === undefined ? {} : { target_prefix: preview.prefix }),
    ...(preview.S_infty === undefined ? {} : { target_s_infty: preview.S_infty }),
    ...projectFeasibility(preview.semantic_feasibility),
    ...projectStandings(record.standings),
    ...projectPickReasons(preview.pick_reasons),
    ...projectResource(preview.resource_policy)
  };
}

function projectFeasibility(rows: unknown): Record<string, unknown> {
  if (!Array.isArray(rows)) return {};
  const feasibility: Record<string, string> = {};
  const projected: Record<string, unknown>[] = [];
  for (const row of rows) {
    const record = asRecord(row);
    if (record === undefined || typeof record.candidate_key !== "string") continue;
    const semantic = optionalString(record, "semantic");
    projected.push({
      candidate_key: record.candidate_key,
      ...(semantic === undefined ? {} : { semantic })
    });
    if (semantic !== undefined) feasibility[record.candidate_key] = semantic;
  }
  return {
    semantic_feasibility: projected,
    ...(Object.keys(feasibility).length === 0 ? {} : { gamma_feasibility: feasibility })
  };
}

function projectStandings(value: unknown): Record<string, unknown> {
  if (!Array.isArray(value)) return {};
  const rows: Record<string, unknown>[] = [];
  for (const item of value) {
    const record = asRecord(item);
    if (record === undefined || typeof record.candidate_key !== "string") continue;
    rows.push({
      candidate_key: record.candidate_key,
      ...(optionalString(record, "atom_id") === undefined
        ? {}
        : { atom_id: record.atom_id }),
      ...(optionalString(record, "coverage") === undefined
        ? {}
        : { coverage: record.coverage }),
      ...(optionalString(record, "independence") === undefined
        ? {}
        : { independence: record.independence })
    });
  }
  return { gamma_standings: rows };
}

function projectPickReasons(value: unknown): Record<string, unknown> {
  if (!Array.isArray(value)) return {};
  const rows: Record<string, unknown>[] = [];
  for (const item of value) {
    const record = asRecord(item);
    if (record === undefined || typeof record.candidate_key !== "string") continue;
    const position = record.position;
    rows.push({
      candidate_key: record.candidate_key,
      ...(typeof position === "number" && Number.isInteger(position) && position >= 0
        ? { position }
        : {}),
      ...(optionalString(record, "reason_id") === undefined
        ? {}
        : { reason_id: record.reason_id })
    });
  }
  return { pick_reasons: rows };
}

function projectResource(policy: unknown): Record<string, unknown> {
  const record = asRecord(policy);
  if (record === undefined) return {};
  const tokenBudget = record.token_budget;
  const limits = record.per_dimension_limits;
  const disposition = {
    ...(typeof record.reject_duplicate_object === "boolean"
      ? { reject_duplicate_object: record.reject_duplicate_object }
      : {}),
    ...(tokenBudget === null || typeof tokenBudget === "number"
      ? { token_budget: tokenBudget }
      : {}),
    ...(limits === null || asRecord(limits) !== undefined
      ? { per_dimension_limits: limits }
      : {})
  };
  return Object.keys(disposition).length === 0 ? {} : { resource_disposition: disposition };
}

function projectPsiV2(
  psi: CapturedShadowTrace["psi_v2_shadow"] | undefined
): Record<string, unknown> {
  if (psi === undefined) {
    return {
      psi_v2_status: "unavailable",
      psi_v2_pair_states_status: "unavailable",
      cycle_status: "unavailable",
      uncertainty_status: "unavailable"
    };
  }
  const observation = optionalString(asRecord(psi), "observation_status");
  const cycleCount = psi.cycle_count;
  return {
    psi_v2_status: observation === "observed" ? "captured" : "unavailable",
    ...(observation === undefined ? {} : { psi_v2_observation_status: observation }),
    ...projectProducerOutcomes(psi.producer_outcomes),
    ...projectPairStates(asRecord(psi) ?? {}),
    cycle_status: typeof cycleCount === "number"
      ? (cycleCount > 0 ? "cycle" : "no_cycle")
      : "unavailable",
    uncertainty_status: uncertaintyStatus(psi.visibility),
    ...(typeof psi.first_frontier_size === "number"
      ? { first_frontier_size: psi.first_frontier_size }
      : {}),
    ...(typeof psi.frontier_depth === "number"
      ? { frontier_depth: psi.frontier_depth }
      : {})
  };
}

function projectPairStates(
  record: Readonly<Record<string, unknown>>
): Record<string, unknown> {
  const raw = record.pair_state_counts ?? record.pair_states ?? record.psi_v2_pair_states;
  if (raw === undefined) return { psi_v2_pair_states_status: "unavailable" };
  const bag = asRecord(raw);
  if (bag === undefined) return { psi_v2_pair_states_status: "failed" };
  const counts: Record<string, number> = {};
  for (const [key, value] of Object.entries(bag)) {
    if (typeof value === "number" && Number.isFinite(value)) counts[key] = value;
  }
  return {
    psi_v2_pair_states_status: "captured",
    psi_v2_pair_states: counts
  };
}

function projectProducerOutcomes(value: unknown): Record<string, unknown> {
  if (!Array.isArray(value)) return {};
  const rows: Record<string, unknown>[] = [];
  for (const item of value) {
    const record = asRecord(item);
    if (record === undefined) continue;
    const producerId = optionalString(record, "producer_id");
    const status = optionalString(record, "status");
    if (producerId === undefined || status === undefined) continue;
    rows.push({
      producer_id: producerId,
      status,
      ...(optionalString(record, "reason") === undefined ? {} : { reason: record.reason }),
      ...(optionalString(record, "contract_code") === undefined
        ? {}
        : { contract_code: record.contract_code })
    });
  }
  return { psi_v2_producer_outcomes: rows };
}

function uncertaintyStatus(visibility: unknown): string {
  const record = asRecord(visibility);
  if (record === undefined) return "unavailable";
  return record.unknown_correlation === true ? "uncertain" : "no_uncertainty";
}

function projectDeliveryPack(
  pack: CapturedShadowTrace["delivery_pack"] | undefined
): Record<string, unknown> {
  if (pack === undefined) return {};
  return {
    ...(pack.pack_digest === undefined ? {} : { delivery_pack_digest: pack.pack_digest }),
    ...(pack.mode === undefined ? {} : { delivery_pack_mode: pack.mode }),
    ...(pack.allowed_claims === undefined ? {} : { allowed_claims: pack.allowed_claims })
  };
}

function projectSidecarDigests(trace: object): Record<string, unknown> {
  const bags = [
    asRecord(trace),
    asRecord(asRecord(trace)?.psi_v2_shadow),
    asRecord(asRecord(trace)?.query_proof_preview),
    asRecord(asRecord(trace)?.delivery_pack),
    asRecord(asRecord(trace)?.field_membership)
  ];
  const universe = firstString(bags, "candidate_universe_digest");
  const membership = firstString(bags, "field_membership_digest");
  return {
    ...(universe === undefined ? {} : { candidate_universe_digest: universe }),
    ...(membership === undefined ? {} : { field_membership_digest: membership })
  };
}

function projectCandidateDispositions(trace: object): Record<string, unknown> {
  const record = asRecord(trace);
  const preview = asRecord(record?.query_proof_preview);
  const raw = preview?.candidate_dispositions ?? record?.candidate_dispositions;
  if (raw === undefined) return { candidate_dispositions_status: "unavailable" };
  if (!Array.isArray(raw)) return { candidate_dispositions_status: "failed" };
  const rows: Record<string, unknown>[] = [];
  for (const item of raw) {
    const row = projectDispositionRow(item);
    if (row !== undefined) rows.push(row);
  }
  if (raw.length > 0 && rows.length === 0) {
    return { candidate_dispositions_status: "failed" };
  }
  return {
    candidate_dispositions_status: "captured",
    candidate_dispositions: rows
  };
}

function projectDispositionRow(value: unknown): Record<string, unknown> | undefined {
  const record = asRecord(value);
  if (record === undefined || typeof record.candidate_key !== "string") return undefined;
  const rank = record.prefix_rank;
  return {
    candidate_key: record.candidate_key,
    ...(optionalString(record, "disposition") === undefined
      ? {}
      : { disposition: record.disposition }),
    ...(optionalString(record, "field_status") === undefined
      ? {}
      : { field_status: record.field_status }),
    ...(optionalString(record, "psi_status") === undefined ? {} : { psi_status: record.psi_status }),
    ...(optionalString(record, "gamma_status") === undefined
      ? {}
      : { gamma_status: record.gamma_status }),
    ...(typeof record.prefix_sk_selected === "boolean"
      ? { prefix_sk_selected: record.prefix_sk_selected }
      : {}),
    ...(rank === null || (typeof rank === "number" && Number.isInteger(rank) && rank >= 0)
      ? { prefix_rank: rank }
      : {})
  };
}

function firstString(
  bags: readonly (Readonly<Record<string, unknown>> | undefined)[],
  key: string
): string | undefined {
  for (const bag of bags) {
    const value = bag?.[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Readonly<Record<string, unknown>>;
}

function optionalString(
  record: Readonly<Record<string, unknown>> | undefined,
  key: string
): string | undefined {
  const value = record?.[key];
  return typeof value === "string" ? value : undefined;
}

function compareCodeUnits(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

export function combineSelectionBoundaryObservers(
  first: BenchRecallOptions["selectionBoundaryObserver"],
  second: BenchRecallOptions["selectionBoundaryObserver"]
): BenchRecallOptions["selectionBoundaryObserver"] {
  if (first === undefined) return second;
  if (second === undefined) return first;
  return (capture) => {
    first(capture);
    second(capture);
    return undefined;
  };
}
