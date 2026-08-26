import type { LongMemEvalQuestionDiagnostic } from
  "../../schema/diagnostics-types.js";
import {
  deriveTreatmentExposureStatus,
  deriveControlPurity,
  sealTreatmentExposureReceipt,
  type TreatmentExposureReceipt,
  type TreatmentExposureReceiptBody
} from "./contract.js";
import { mapQuestionToDiagnosticStage } from "../diagnostic-100q.js";
import type { QuestionStageRow } from "../types.js";
import { assertProductPhaseAuthority } from "../../phase/phase-authority.js";
import { isAbstentionDiagnostic } from "../../abstention.js";

export function buildTreatmentExposureReceipts(input: {
  readonly control: readonly LongMemEvalQuestionDiagnostic[];
  readonly treatment: readonly LongMemEvalQuestionDiagnostic[];
  readonly controlStages: readonly QuestionStageRow[];
  readonly treatmentStages: readonly QuestionStageRow[];
}): readonly TreatmentExposureReceipt[] {
  const controlById = new Map(input.control.map((row) => [row.question_id, row]));
  const controlStages = new Map(input.controlStages.map((row) => [row.question_id, row]));
  const treatmentStages = new Map(input.treatmentStages.map((row) => [row.question_id, row]));
  for (const treatment of input.treatment) {
    assertConsistentAbstentionPairing(controlById.get(treatment.question_id), treatment);
  }
  return input.treatment
    .filter((treatment) => !isAbstentionDiagnostic(treatment))
    .map((treatment) => buildReceipt({
      control: controlById.get(treatment.question_id),
      treatment,
      controlStage: requireStage(controlStages, treatment.question_id, "control"),
      treatmentStage: requireStage(treatmentStages, treatment.question_id, "treatment")
    }))
    .sort((left, right) => compareCodeUnits(left.question_id, right.question_id));
}

function buildReceipt(input: {
  readonly control: LongMemEvalQuestionDiagnostic | undefined;
  readonly treatment: LongMemEvalQuestionDiagnostic;
  readonly controlStage: QuestionStageRow;
  readonly treatmentStage: QuestionStageRow;
}): TreatmentExposureReceipt {
  const { control, treatment } = input;
  if (control !== undefined) assertProductPhaseAuthority(control);
  const ledger = assertProductPhaseAuthority(treatment);
  const d0ReceiptDigest = treatment.d0_receipt?.receipt_digest ?? null;
  const evidence = treatmentEvidence(treatment, d0ReceiptDigest);
  const body: TreatmentExposureReceiptBody = {
    schema_version: 4,
    kind: "cached_f3_treatment_exposure",
    question_id: treatment.question_id,
    ranking_authority: treatment.ranking_authority ?? null,
    d0_receipt_digest: d0ReceiptDigest,
    product_phase_ledger: ledger,
    ...evidence,
    control_non_exposure: controlWitness(control),
    membership_delta: membershipDelta(control, treatment),
    candidate_pool: {
      control_complete: control === undefined ? null : control.candidate_pool_complete === true,
      treatment_complete: treatment.candidate_pool_complete === true
    },
    query_probe_delta: queryProbeDelta(control, treatment),
    retrieval_channel_delta: retrievalChannelDelta(control, treatment),
    outcome: {
      control: stageOutcome(input.controlStage),
      treatment: stageOutcome(input.treatmentStage)
    },
    exposure_status: "inconclusive"
  };
  return sealTreatmentExposureReceipt({
    ...body,
    exposure_status: deriveTreatmentExposureStatus(body)
  });
}

function treatmentEvidence(
  treatment: LongMemEvalQuestionDiagnostic,
  d0ReceiptDigest: string | null
) {
  const formation = treatment.query_open_semantic_factor_formation;
  const compatibility = treatment.open_semantic_factor_compatibility_trace;
  const composition = treatment.open_semantic_factor_composition;
  const activation = treatment.open_semantic_factor_activation;
  const candidateEntries = treatment.open_semantic_factor_candidate_activations ?? [];
  const activatedCount = activation?.entries.filter((entry) => entry.activation > 0).length ?? 0;
  const observedCandidateAttribution =
    treatment.open_semantic_factor_candidate_activations !== undefined;
  const linksValid = observedCandidateAttribution && (
    receiptLinksValid(formation, compatibility, composition, activation) &&
    candidateAttributionLinksValid(treatment, candidateEntries)
  );
  return {
    evidence_chain: { linked: linksValid },
    formation: { status: formation?.status ?? null },
    compatible_evidence: {
      compatible_count: compatibility?.entries.filter(
        (entry) => entry.receipt.status === "compatible"
      ).length ?? 0
    },
    composition: {
      status: composition?.status ?? null,
      solution_count: composition?.solution_count ?? 0,
      binding_count: composition === null || composition === undefined ? 0 :
        Math.max(composition.bindings.length, composition.observed_binding_count)
    },
    activation: {
      status: activation?.status ?? null,
      activated_evidence_count: activatedCount
    },
    candidate_attribution: candidateAttribution(candidateEntries, d0ReceiptDigest)
  };
}

function candidateAttribution(
  entries: NonNullable<LongMemEvalQuestionDiagnostic[
    "open_semantic_factor_candidate_activations"
  ]>,
  d0ReceiptDigest: string | null
) {
  return {
    d0_receipt_digest: d0ReceiptDigest,
    entries,
    candidate_keys: entries.map((entry) => entry.candidate_key),
    activated_evidence_ids: [...new Set(entries.flatMap(
      (entry) => entry.receipt.evidence_ids
    ))].sort(compareCodeUnits)
  };
}

function candidateAttributionLinksValid(
  treatment: LongMemEvalQuestionDiagnostic,
  entries: NonNullable<LongMemEvalQuestionDiagnostic[
    "open_semantic_factor_candidate_activations"
  ]>
): boolean {
  const candidateKeys = new Set(treatment.candidates.map((row) => row.candidate_key));
  const positive = new Map(treatment.open_semantic_factor_activation?.entries
    .filter((row) => row.activation > 0)
    .map((row) => [row.evidence_id, row] as const) ?? []);
  return entries.every((entry) => {
    const observations = entry.receipt.evidence_ids.map((id) => positive.get(id));
    if (!candidateKeys.has(entry.candidate_key) || observations.some((row) => row === undefined)) {
      return false;
    }
    const proven = observations as readonly NonNullable<typeof observations[number]>[];
    return entry.receipt.score === Math.max(...proven.map((row) => row.activation)) &&
      entry.receipt.solution_count === Math.max(...proven.map((row) => row.solution_count)) &&
      entry.receipt.proposition_match_count ===
        Math.max(...proven.map((row) => row.proposition_match_count));
  });
}

function controlWitness(control: LongMemEvalQuestionDiagnostic | undefined) {
  const activation = control?.open_semantic_factor_activation;
  const entries = control?.open_semantic_factor_candidate_activations;
  const witness = {
    observed: control !== undefined && entries !== undefined,
    formation_status: control?.query_open_semantic_factor_formation?.status ?? null,
    compatible_count: control?.open_semantic_factor_compatibility_trace?.entries.filter(
      (entry) => entry.receipt.status === "compatible"
    ).length ?? 0,
    composition_status: control?.open_semantic_factor_composition?.status ?? null,
    activation_status: activation?.status ?? null,
    activated_evidence_count: activation?.entries.filter(
      (entry) => entry.activation > 0
    ).length ?? 0,
    candidate_attribution_count: entries?.length ?? 0,
    pure: false
  };
  return { ...witness, pure: deriveControlPurity(witness) };
}

function stageOutcome(row: QuestionStageRow) {
  return { stage: mapQuestionToDiagnosticStage(row), hit_at_5: row.hit_at_5 };
}

function requireStage(
  rows: ReadonlyMap<string, QuestionStageRow>,
  questionId: string,
  arm: string
): QuestionStageRow {
  const row = rows.get(questionId);
  if (row === undefined) throw new Error(`missing ${arm} stage row for ${questionId}`);
  return row;
}

function assertConsistentAbstentionPairing(
  control: LongMemEvalQuestionDiagnostic | undefined,
  treatment: LongMemEvalQuestionDiagnostic
) {
  if (control === undefined) return;
  if (isAbstentionDiagnostic(control) === isAbstentionDiagnostic(treatment)) return;
  throw new Error(`inconsistent abstention pairing for ${treatment.question_id}`);
}

function membershipDelta(
  control: LongMemEvalQuestionDiagnostic | undefined,
  treatment: LongMemEvalQuestionDiagnostic
) {
  // Truncated pools still have a delivered Top-5; completeness is a separate coverage claim.
  const { observed, changed, added, removed } = stringSetDiff(
    control !== undefined,
    topFiveCandidateKeys(control),
    topFiveCandidateKeys(treatment)
  );
  return {
    observed,
    changed,
    added_candidate_keys: added,
    removed_candidate_keys: removed
  };
}

function queryProbeDelta(
  control: LongMemEvalQuestionDiagnostic | undefined,
  treatment: LongMemEvalQuestionDiagnostic
) {
  const controlTerms = expandedTerms(control);
  const treatmentTerms = expandedTerms(treatment);
  const { observed, changed, added, removed } = stringSetDiff(
    controlTerms !== null && treatmentTerms !== null,
    controlTerms ?? [],
    treatmentTerms ?? []
  );
  return {
    observed,
    changed,
    added_expanded_terms: added,
    removed_expanded_terms: removed
  };
}

function retrievalChannelDelta(
  control: LongMemEvalQuestionDiagnostic | undefined,
  treatment: LongMemEvalQuestionDiagnostic
) {
  const controlChannels = channelMap(control);
  const treatmentChannels = channelMap(treatment);
  const observed = controlChannels !== null && treatmentChannels !== null;
  if (!observed) return { observed: false, changed: false, changed_channels: [] };
  const changed_channels = [...new Set([...controlChannels.keys(), ...treatmentChannels.keys()])]
    .sort(compareCodeUnits)
    .flatMap((channel_id) => {
      const left = controlChannels.get(channel_id);
      const right = treatmentChannels.get(channel_id);
      const row = {
        channel_id,
        control_status: left?.status ?? null,
        treatment_status: right?.status ?? null,
        control_depth: left?.depth ?? null,
        treatment_depth: right?.depth ?? null
      };
      return row.control_status === row.treatment_status &&
        row.control_depth === row.treatment_depth ? [] : [row];
    });
  return { observed: true, changed: changed_channels.length > 0, changed_channels };
}

function stringSetDiff(
  observed: boolean,
  controlValues: readonly string[],
  treatmentValues: readonly string[]
) {
  const controlSet = new Set(controlValues);
  const treatmentSet = new Set(treatmentValues);
  const added = observed
    ? [...treatmentSet].filter((value) => !controlSet.has(value)).sort(compareCodeUnits)
    : [];
  const removed = observed
    ? [...controlSet].filter((value) => !treatmentSet.has(value)).sort(compareCodeUnits)
    : [];
  return {
    observed,
    changed: observed && (added.length > 0 || removed.length > 0),
    added,
    removed
  };
}

function expandedTerms(
  diagnostic: LongMemEvalQuestionDiagnostic | undefined
): readonly string[] | null {
  const terms = diagnostic?.query_probes?.expanded_terms;
  return Array.isArray(terms) ? terms : null;
}

function channelMap(diagnostic: LongMemEvalQuestionDiagnostic | undefined) {
  if (diagnostic?.retrieval_field_captures == null) return null;
  const mapped = new Map<string, {
    readonly status: "complete" | "truncated" | "unavailable" | "ineligible";
    readonly depth: number;
  }>();
  for (const capture of diagnostic.retrieval_field_captures) {
    const channelId = capture.channel.channel_id;
    if (mapped.has(channelId)) {
      throw new Error(`duplicate retrieval channel_id: ${channelId}`);
    }
    mapped.set(channelId, {
      status: capture.channel.status,
      depth: capture.channel.depth
    });
  }
  return mapped;
}

function compareCodeUnits(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function topFiveCandidateKeys(
  diagnostic: LongMemEvalQuestionDiagnostic | undefined
): readonly string[] {
  return diagnostic?.candidates
    .filter((candidate) => candidate.final_rank !== null && candidate.final_rank <= 5)
    .map((candidate) => candidate.candidate_key) ?? [];
}

function receiptLinksValid(
  formation: LongMemEvalQuestionDiagnostic["query_open_semantic_factor_formation"],
  compatibility: LongMemEvalQuestionDiagnostic["open_semantic_factor_compatibility_trace"],
  composition: LongMemEvalQuestionDiagnostic["open_semantic_factor_composition"],
  activation: LongMemEvalQuestionDiagnostic["open_semantic_factor_activation"]
): boolean {
  if (formation === null || formation === undefined) return false;
  if (compatibility === null || compatibility === undefined ||
      compatibility.query_capture_digest !== formation.capture_digest) return false;
  if (composition === null || composition === undefined ||
      composition.query_capture_digest !== formation.capture_digest ||
      composition.compatibility_trace_digest !== compatibility.trace_digest) return false;
  return activation !== null && activation !== undefined &&
    activation.composition_receipt_digest === composition.receipt_digest;
}
