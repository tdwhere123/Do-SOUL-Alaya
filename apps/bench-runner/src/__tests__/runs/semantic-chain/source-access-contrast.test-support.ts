import { DatabaseSync } from "node:sqlite";
import type { SoulInterpretationResponse, SourceSemanticAccessReceipt } from "@do-soul/alaya-protocol";
import type { AccessFixtureSource } from "../../../../../core-daemon/src/__tests__/runtime/recall/source-semantic-access.test-support.js";

export const ORIGINAL_QUERY = "Did the Beacon deployment finish?";
const INITIAL_TEXT = "Beacon incident notes list Harbor as a possible deployment ledger; this link is unverified.";
const COMPLETED = "Harbor deployment ledger. Service Beacon, deployment D17: completed.";
export const REQUEST_BUDGET = { schema_version: 1 as const, work_units: 200_000, memory_bytes: 8_000_000,
  page_budget: 100_000, finalization_reserve: 10_000, min_envelope: 10 };
export const TASK_ALLOWANCE = { total_work_units: 1_000_000, total_memory_bytes: 40_000_000,
  read_work_units: 1_000, read_memory_bytes: 65_536, max_input_bytes_per_read: 33_554_432,
  max_read_admissions: 64, max_effects: 64 };
export const RESERVATION_SCHEDULE = {
  bootstrap: [1_000, 65_536], common_input_read: [1_000, 65_536], common_setup: [40_000, 2_000_000],
  initial_preparation: [200_000, 8_000_000], initial_delivery: [200_000, 8_000_000],
  optional_hint_read: [1_000, 65_536], second_preparation: [200_000, 8_000_000],
  second_delivery: [200_000, 8_000_000], final_assessment_read: [1_000, 65_536],
  result_persistence: [1_000, 65_536], additional_native_manifest_read: [1_000, 65_536]
};
export const ARMS = [
  { name: "A", access_hint: undefined, author_knowledge: "original task and common initial material" },
  { name: "B", access_hint: "Beacon deployment completion finished status", author_knowledge: "original task only" },
  { name: "C", access_hint: "Harbor", author_knowledge: "original task and common initial material" }
] as const;

export const ACCESS_CASES = [
  { name: "Discriminating completion", candidate: COMPLETED, initial: INITIAL_TEXT, interpreted: true,
    expected: "completed" },
  { name: "False identity foil", candidate: "Harbor deployment ledger. Service Beacon-Archive, deployment D17: completed. Service Beacon is a different service; status unrecorded.",
    initial: INITIAL_TEXT, interpreted: true, expected: "unknown_distinct_service" },
  { name: "Raw already sufficient", candidate: COMPLETED,
    initial: INITIAL_TEXT + " Beacon deployment D17 completed.", interpreted: true, expected: "completed" },
  { name: "Still unresolved", candidate: "Harbor deployment ledger. Service identity absent. Deployment D17 may have completed; reconciliation pending.",
    initial: INITIAL_TEXT, interpreted: true, expected: "unknown_identity_and_modality" },
  { name: "Completion refuted", candidate: "Harbor deployment ledger. Beacon deployment D17 remains incomplete; earlier completion indication was withdrawn.",
    initial: INITIAL_TEXT + " An unverified completion indication for Beacon was reported.", interpreted: true,
    expected: "completion_indication_refuted" },
  { name: "Raw-only access limit", candidate: COMPLETED, initial: INITIAL_TEXT, interpreted: false,
    expected: "completed" }
] as const;
export type AccessCase = typeof ACCESS_CASES[number];
export type Arm = typeof ARMS[number];
export type Preparation = Extract<SoulInterpretationResponse, { operation: "prepare_query" }>;
export type Delivery = Extract<SoulInterpretationResponse, { operation: "recall" }>;
export type ManifestSource = { source_id: string; record_id: string; source_version: string;
  content_digest: string; source_body: string };
export type DiscoveryAssessment = Readonly<{ status: "known"; value: boolean; reason: string }>
  | Readonly<{ status: "unknown"; value: null; reason: string }>;

export function executionBinding(revision: string | undefined) {
  if (revision === undefined) return { implementation_revision: null, execution_kind: "unbound_test" } as const;
  if (!/^[a-f0-9]{40}$/u.test(revision)) throw new Error("ALAYA_ACCESS_IMPLEMENTATION_REVISION must be an exact 40-hex revision");
  return { implementation_revision: revision, execution_kind: "bound_experiment" } as const;
}

export function caseSources(fixture: AccessCase): readonly AccessFixtureSource[] {
  return [{ id: "initial", text: fixture.initial, verbatim: true },
    ...Array.from({ length: 32 }, (_, offset) => ({ id: `filler-${offset + 1}`,
      text: `Granite courtyard maintenance entry ${offset + 1}.`, verbatim: true })),
    { id: "candidate", text: fixture.candidate, verbatim: true,
      ...(fixture.interpreted ? { reading: fixture.candidate } : {}) }];
}

/** The evaluator joins native identities only after admission; none enter access requests. */
export function readNativeManifest(filename: string): ManifestSource[] {
  const db = new DatabaseSync(filename, { readOnly: true });
  try {
    return db.prepare("SELECT source_id, record_id, source_version, content_digest, source_body FROM source_records ORDER BY rowid")
      .all() as ManifestSource[];
  } finally { db.close(); }
}

export function readAllowanceLedger(filename: string) {
  const db = new DatabaseSync(filename, { readOnly: true });
  try {
    const totals = db.prepare("SELECT work_reserved, memory_reserved, read_count, effect_count FROM cycle").get() as
      { work_reserved: number; memory_reserved: number; read_count: number; effect_count: number };
    return { ...totals,
      actions: db.prepare("SELECT name, work_units, memory_bytes FROM effects ORDER BY rowid").all(),
      reads: db.prepare("SELECT ordinal, label, input_bytes FROM read_observations ORDER BY ordinal").all(),
      actual_native_observations: db.prepare("SELECT name, work_json FROM native_observations ORDER BY rowid").all()
        .map(row => ({ name: row.name, work: JSON.parse(String(row.work_json)) })) };
  } finally { db.close(); }
}

function observedSources(...receipts: readonly (SourceSemanticAccessReceipt | undefined)[]) {
  const seen = new Map<string, SourceSemanticAccessReceipt["source_candidates"][number]>();
  for (const receipt of receipts) for (const row of receipt?.source_candidates ?? []) {
    if (row.read_bytes > 0 && !seen.has(row.record_id)) seen.set(row.record_id, row);
  }
  return [...seen.values()];
}

/** Receipt projections may overlap; their separate omitted counts are never added or maximized. */
export function observationIdentitySummary(preparation?: SourceSemanticAccessReceipt, delivery?: SourceSemanticAccessReceipt) {
  const explicitRecords = new Set([...(preparation?.source_candidates ?? []), ...(delivery?.source_candidates ?? [])]
    .map(row => row.record_id));
  const samePool = preparation !== undefined && delivery !== undefined && preparation.pool_id === delivery.pool_id
    && preparation.observed_source_count === delivery.observed_source_count && explicitRecords.size <= preparation.observed_source_count;
  return {
    receipt_omissions: { preparation: preparation?.trace.omitted_source_count ?? null,
      delivery: delivery?.trace.omitted_source_count ?? null },
    receipt_observed_source_counts: { preparation: preparation?.observed_source_count ?? null,
      delivery: delivery?.observed_source_count ?? null },
    explicit_record_ids: [...explicitRecords],
    explicit_read_source_rows: observedSources(preparation, delivery),
    unrepresented_observed_source_identities: samePool ? preparation.observed_source_count - explicitRecords.size : null,
    identity_coverage_status: samePool ? "same_pool_receipts" : preparation === undefined || delivery === undefined
      ? "missing_access_receipt" : "inconsistent_access_receipts"
  };
}

type ObservationSummary = ReturnType<typeof observationIdentitySummary>;
type ObservedRound = Readonly<{ terminal: boolean; identities: ObservationSummary }>;
export function candidateDiscovery(initial: ObservedRound, second?: ObservedRound): DiscoveryAssessment {
  if (initial.terminal) return { status: "unknown", value: null, reason: "terminal_initial_no_result" };
  if (second?.terminal) return { status: "unknown", value: null, reason: "terminal_second_no_result" };
  for (const [label, round] of [["initial", initial], ["second", second]] as const) {
    if (round !== undefined && round.identities.unrepresented_observed_source_identities === null) {
      return { status: "unknown", value: null, reason: `${label}_${round.identities.identity_coverage_status}` };
    }
  }
  if (initial.identities.explicit_read_source_rows.some(row => row.source_id === "candidate")) {
    return { status: "known", value: false, reason: "candidate_already_observed_initially" };
  }
  if (second === undefined) return { status: "known", value: false, reason: "second_observation_not_executed" };
  if (second.identities.explicit_read_source_rows.some(row => row.source_id === "candidate")) {
    return initial.identities.unrepresented_observed_source_identities === 0
      ? { status: "known", value: true, reason: "candidate_first_observed_in_second_round" }
      : { status: "unknown", value: null, reason: "initial_observed_identities_omitted" };
  }
  return second.identities.unrepresented_observed_source_identities === 0
    ? { status: "known", value: false, reason: "candidate_not_observed_in_second_round" }
    : { status: "unknown", value: null, reason: "second_observed_identities_omitted" };
}

export function compareCandidateDiscovery(arms: readonly Readonly<{ arm: Arm["name"];
  candidate_newly_observed: DiscoveryAssessment; candidate_explicitly_observed_initially: boolean }>[]): DiscoveryAssessment {
  for (const arm of ["A", "B", "C"] as const) {
    const matches = arms.filter(row => row.arm === arm);
    if (matches.length !== 1) return { status: "unknown", value: null,
      reason: matches.length === 0 ? `missing_arm_${arm}` : `duplicate_arm_${arm}` };
    if (matches[0]!.candidate_newly_observed.status === "unknown") return { status: "unknown", value: null,
      reason: `${arm}_${matches[0]!.candidate_newly_observed.reason}` };
  }
  const c = arms.find(row => row.arm === "C")!;
  if (!c.candidate_newly_observed.value) return { status: "known", value: false, reason: "C_has_no_new_candidate_discovery" };
  const baseline = arms.find(row => row.arm !== "C"
    && (row.candidate_explicitly_observed_initially || row.candidate_newly_observed.value));
  return baseline === undefined ? { status: "known", value: true, reason: "C_discovers_candidate_both_baselines_do_not" }
    : { status: "known", value: false, reason: `${baseline.arm}_also_observed_candidate` };
}

export function publicSources(delivery: Delivery | undefined, manifest: readonly ManifestSource[]) {
  return (delivery?.results ?? []).map(({ target, ...result }, offset) => ({ rank: offset + 1,
    source_id: target.kind === "source_evidence"
      ? manifest.find(source => source.record_id === target.root_id)?.source_id ?? null : null,
    target, object_kind: result.object_kind, text: result.content_preview,
    source_disclosure: result.source_disclosure, selection_reason: result.selection_reason,
    qualifiers: (delivery?.slot_qualifiers ?? []).filter(qualifier => qualifier.index === offset) }));
}

/** Exact authored text checks test delivered evidence availability, never a reader's answer. */
export function evidenceChecklist(fixture: AccessCase, texts: readonly string[]) {
  const candidateComplete = texts.some(text => text.includes(fixture.candidate));
  const rawAlreadySufficient = texts.some(text => text.includes("Beacon deployment D17 completed."));
  const sufficient = candidateComplete || rawAlreadySufficient;
  return { candidate_complete: candidateComplete, qualifiers_retained: candidateComplete ? true : "unknown",
    raw_initial_completion_present: rawAlreadySufficient,
    evidence_status: sufficient ? fixture.expected : "unknown_not_delivered",
    task_answer_resolved: sufficient && fixture.expected !== "unknown_distinct_service"
      && fixture.expected !== "unknown_identity_and_modality",
    refuted_task_local_belief: candidateComplete && fixture.expected === "completion_indication_refuted"
      ? "The unverified completion indication can no longer support Beacon completion." : null,
    persistent_revision: "not_exercised", consumer_answer_accuracy: "not_exercised" };
}
