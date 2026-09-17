import type { SourceLocatedInterpretation } from "@do-soul/alaya-protocol";
import type { OfficialApiInterpretationEntryRejection } from "@do-soul/alaya-soul";
import type { FrozenAssertion, FrozenClassification } from "./frozen-population.js";
import type {
  FrozenAssertionBinding,
  FrozenBindingStatus,
  FrozenBoundCurrentSource,
  FrozenOccurrenceBinding,
  FrozenPopulationBindings
} from "./source-binding.js";
import type { EnrichmentPreflight } from "./current-preflight.js";

export type HumanSemanticVerdict = "unreviewed";
export type SemanticQualityCell = "unreviewed" | "hold" | "failed";
export type PublicConsumptionState = "not_exercised" | "not_verified" | "exercised";
export type PreparationCellState =
  | "not_exercised"
  | "missing"
  | "valid-empty"
  | "partial"
  | "rejected"
  | "unknown"
  | "unreviewed";

export interface EnrichmentFixtureOutcome {
  readonly name: string;
  readonly kind: "transport_parse" | "source_fidelity" | "native_formation_publication" | "public_consumption";
  readonly result: "passed" | "failed" | "not_run" | "not_verified";
  readonly detail?: string;
  readonly cell_state?: PreparationCellState;
}

export interface EnrichmentRejectedSibling {
  readonly candidate_ordinal: number;
  readonly reason: string;
}

export interface EnrichmentBoundNativeOutcome {
  readonly annotation_pointer?: FrozenAssertion["annotation_pointer"];
  readonly request_key?: string;
  readonly current_assertion_id?: number;
  readonly occurrence_identity?: string;
  readonly request_ordinal: number | null;
  readonly candidate_ordinal: number | null;
  readonly raw_state: PreparationCellState;
  readonly machine_admission: PreparationCellState;
  readonly located_outcome?: "candidates" | "empty" | "failed";
  readonly diagnostic_reason?: SourceLocatedInterpretation["diagnostics"][number]["reason"];
  readonly admission_reason?: OfficialApiInterpretationEntryRejection["reason"];
  readonly rejected_siblings?: readonly EnrichmentRejectedSibling[];
  readonly unmet_obligations?: readonly string[];
}

export interface EnrichmentSemanticQualityAnnotation {
  readonly annotation_pointer: FrozenAssertion["annotation_pointer"];
  readonly quality_cell: Exclude<SemanticQualityCell, "unreviewed">;
  readonly attributed_to: string;
  readonly detail?: string;
}

export interface EnrichmentPreparationRow {
  readonly annotation_pointer: FrozenAssertion["annotation_pointer"];
  readonly original_ordinal: number;
  readonly population: FrozenAssertion["population"];
  readonly classification: FrozenClassification;
  readonly required_group_id: string | null;
  readonly first_stage_subset: boolean;
  readonly selected: boolean;
  readonly duplicate_of: number | null;
  readonly binding_status: FrozenBindingStatus;
  readonly binding_reason: string;
  readonly current: readonly FrozenBoundCurrentSource[];
  readonly occurrences: readonly FrozenOccurrenceBinding[];
  readonly current_assertion_id: number | null;
  readonly current_semantic_key: string | null;
  readonly current_request_keys: readonly string[] | null;
  readonly request_ordinal: number | null;
  readonly candidate_ordinal: number | null;
  readonly rejected_siblings: readonly EnrichmentRejectedSibling[];
  readonly unmet_obligations: readonly string[];
  readonly native_cells: readonly EnrichmentBoundNativeOutcome[];
  readonly human_verdict: HumanSemanticVerdict;
  readonly quality_cell: SemanticQualityCell;
  readonly quality_attribution: string | null;
  readonly machine_admission: PreparationCellState;
  readonly raw_state: PreparationCellState;
}

export interface EnrichmentPreparationReport {
  readonly transport_parse: {
    readonly attempted_fetches: number | null;
    readonly annotation_interpolation: "absent" | "unknown";
    readonly capability: string;
    readonly wire_contract: string;
    readonly prompt_sha256: string | null;
    readonly parser: string | null;
    readonly model: string | null;
    readonly request_profile: string | null;
    readonly max_output_tokens: number | null;
    readonly source_packing: string | null;
    readonly nonempty_request_count: number | null;
    readonly deterministic_empty_request_count: number | null;
    readonly cached_request_count: number | null;
    readonly unresolved_native_bound: boolean | null;
    readonly semantic_fill: EnrichmentPreflight["semantic_fill"] | null;
    readonly fixture_outcomes: readonly EnrichmentFixtureOutcome[];
  };
  readonly source_fidelity: {
    readonly denominator: number;
    readonly bound: number;
    readonly unbound: number;
    readonly ineligible: number;
    readonly ambiguous: number;
    readonly partial: number;
    readonly dropped_rows: number;
    readonly packing: FrozenPopulationBindings["packing"] | null;
    readonly first_stage_required_groups: number;
    readonly full_required_groups: number;
    readonly required_group_ids: {
      readonly first_stage: readonly string[];
      readonly full: readonly string[];
    };
    readonly human_verdicts: "unreviewed";
    readonly rows: readonly EnrichmentPreparationRow[];
    readonly fixture_outcomes: readonly EnrichmentFixtureOutcome[];
  };
  readonly native_formation_publication: {
    readonly selected_stage: "full" | "first_stage" | "none";
    readonly status: PreparationCellState;
    readonly machine_admission: PreparationCellState;
    readonly human_verdict: HumanSemanticVerdict;
    readonly fixture_outcomes: readonly EnrichmentFixtureOutcome[];
    readonly unmatched_native_outcomes: readonly EnrichmentBoundNativeOutcome[];
    readonly note: string;
  };
  readonly public_consumption: {
    readonly status: PublicConsumptionState;
    readonly fixture_outcomes: readonly EnrichmentFixtureOutcome[];
    readonly note: string;
  };
}

const FIRST_STAGE_GROUP_ORDER = ["aspiration", "capability", "release"] as const;

export function composeEnrichmentPreparationReport(input: {
  readonly population: { readonly rows: readonly FrozenAssertion[] };
  readonly bindings: FrozenPopulationBindings;
  readonly preflight: EnrichmentPreflight | null;
  readonly fixtureOutcomes?: readonly EnrichmentFixtureOutcome[];
  readonly nativeOutcomes?: readonly EnrichmentBoundNativeOutcome[];
  readonly semanticAnnotations?: readonly EnrichmentSemanticQualityAnnotation[];
  readonly selectedStage?: "full" | "first_stage" | "none";
}): EnrichmentPreparationReport {
  const fixtures = Object.freeze([...(input.fixtureOutcomes ?? [])]);
  const natives = Object.freeze([...(input.nativeOutcomes ?? [])]);
  const qualities = Object.freeze([...(input.semanticAnnotations ?? [])]);
  const byPointer = indexBindings(input.bindings.bindings);
  const selectedStage = input.selectedStage ?? "full";
  const rows = Object.freeze(input.population.rows.map((row) => {
    const binding = byPointer.get(pointerKey(row)) ?? null;
    const selected = selectedStage === "full" || selectedStage === "first_stage" && row.first_stage_subset;
    return composeRow(row, binding, natives, qualities, selected);
  }));
  const matchedCells = new Set(rows.flatMap((row) => row.native_cells));
  const unmatchedNatives = Object.freeze(natives.filter((item) => !matchedCells.has(item)));
  const statuses = countBindingStatuses(input.bindings.bindings);
  const dropped = countDroppedRows(input.population.rows, input.bindings.bindings);
  const fullGroupIds = uniqueRequiredGroupIds(input.population.rows);
  const firstStageGroupIds = uniqueFirstStageGroupIds(input.population.rows);
  const nativeFixtures = fixtures.filter((item) => item.kind === "native_formation_publication");
  const publicFixtures = fixtures.filter((item) => item.kind === "public_consumption");
  const transportFixtures = fixtures.filter((item) => item.kind === "transport_parse");
  const fidelityFixtures = fixtures.filter((item) => item.kind === "source_fidelity");
  return Object.freeze({
    transport_parse: Object.freeze({
      attempted_fetches: input.preflight?.attempted_fetches ?? null,
      annotation_interpolation: input.preflight?.annotation_interpolation ?? "unknown",
      capability: input.preflight?.identities.capability ?? "unknown",
      wire_contract: input.preflight?.identities.wire_contract ?? "unknown",
      prompt_sha256: input.preflight?.identities.prompt_sha256 ?? null,
      parser: input.preflight?.identities.parser ?? null,
      model: input.preflight?.identities.model ?? null,
      request_profile: input.preflight?.identities.request_profile ?? null,
      max_output_tokens: input.preflight?.identities.max_output_tokens ?? null,
      source_packing: input.preflight?.identities.source_packing ?? null,
      nonempty_request_count: input.preflight?.nonempty_request_count ?? null,
      deterministic_empty_request_count: input.preflight?.deterministic_empty_request_count ?? null,
      cached_request_count: input.preflight?.cached_request_count ?? null,
      unresolved_native_bound: input.preflight?.bounds.unresolved_native_bound ?? null,
      semantic_fill: input.preflight?.semantic_fill ?? null,
      fixture_outcomes: transportFixtures
    }),
    source_fidelity: Object.freeze({
      denominator: input.population.rows.length,
      bound: statuses.bound,
      unbound: statuses.unbound,
      ineligible: statuses.ineligible,
      ambiguous: statuses.ambiguous,
      partial: statuses.partial,
      dropped_rows: dropped,
      packing: input.bindings.packing,
      first_stage_required_groups: firstStageGroupIds.length,
      full_required_groups: fullGroupIds.length,
      required_group_ids: Object.freeze({
        first_stage: firstStageGroupIds,
        full: fullGroupIds
      }),
      human_verdicts: "unreviewed",
      rows,
      fixture_outcomes: fidelityFixtures
    }),
    native_formation_publication: Object.freeze({
      selected_stage: selectedStage,
      status: publicationDomainState(rows.filter((row) => row.selected).map((row) => row.raw_state)),
      machine_admission: publicationDomainState(rows.filter((row) => row.selected).map((row) => row.machine_admission)),
      human_verdict: "unreviewed",
      fixture_outcomes: nativeFixtures,
      unmatched_native_outcomes: unmatchedNatives,
      note: "Fixture outcomes are mechanism evidence only and do not upgrade human semantic verdicts."
    }),
    public_consumption: Object.freeze({
      status: publicConsumptionStatus(publicFixtures),
      fixture_outcomes: publicFixtures,
      note: "Public consumption is not_exercised unless a real existing consumer check ran; the unmerged public-consumption scorer is not imported."
    })
  });
}

function composeRow(
  row: FrozenAssertion,
  binding: FrozenAssertionBinding | null,
  natives: readonly EnrichmentBoundNativeOutcome[],
  qualities: readonly EnrichmentSemanticQualityAnnotation[],
  selected: boolean
): EnrichmentPreparationRow {
  const current = binding?.current ?? [];
  const unique = current.length === 1 ? current[0]! : null;
  const nativeCells = Object.freeze(
    selected ? materializeMissingExpectedRequestCells(
      row,
      current,
      natives.filter((item) => nativeOutcomeMatches(item, row, binding))
    ) : []
  );
  const quality = qualities.find((item) => (
    pointerFieldsKey(item.annotation_pointer) === pointerFieldsKey(row.annotation_pointer)
  )) ?? null;
  return Object.freeze({
    annotation_pointer: row.annotation_pointer,
    original_ordinal: row.original_ordinal,
    population: row.population,
    classification: row.classification,
    required_group_id: row.required_group_id,
    first_stage_subset: row.first_stage_subset,
    selected,
    duplicate_of: row.duplicate_of,
    binding_status: binding?.status ?? "unbound",
    binding_reason: binding?.reason ?? "source map row has no binding result",
    current,
    occurrences: binding?.occurrences ?? [],
    current_assertion_id: unique?.assertion_id ?? null,
    current_semantic_key: unique?.semanticKey ?? null,
    current_request_keys: unique?.request_keys ?? null,
    request_ordinal: uniqueNumber(nativeCells.map((item) => item.request_ordinal)),
    candidate_ordinal: uniqueNumber(nativeCells.map((item) => item.candidate_ordinal)),
    rejected_siblings: Object.freeze(nativeCells.flatMap((item) => item.rejected_siblings ?? [])),
    unmet_obligations: Object.freeze(nativeCells.flatMap((item) => item.unmet_obligations ?? [])),
    native_cells: nativeCells,
    human_verdict: "unreviewed",
    quality_cell: quality?.quality_cell ?? "unreviewed",
    quality_attribution: quality?.attributed_to ?? null,
    machine_admission: !selected ? "not_exercised" : nativeCells.length === 0
      ? "missing"
      : domainCellState(nativeCells.map((item) => item.machine_admission)),
    raw_state: !selected ? "not_exercised" : nativeCells.length === 0
      ? "missing"
      : domainCellState(nativeCells.map((item) => item.raw_state))
  });
}

function nativeOutcomeMatches(
  outcome: EnrichmentBoundNativeOutcome,
  row: FrozenAssertion,
  binding: FrozenAssertionBinding | null
): boolean {
  if (outcome.annotation_pointer !== undefined) {
    if (pointerFieldsKey(outcome.annotation_pointer) !== pointerFieldsKey(row.annotation_pointer)) {
      return false;
    }
    return suppliedIdentitiesAgreeWithBinding(outcome, binding);
  }
  if (binding === null) return false;
  if (outcome.request_key === undefined || outcome.current_assertion_id === undefined) {
    return false;
  }
  return binding.current.some((item) => currentIdentityAgrees(item, outcome));
}

function suppliedIdentitiesAgreeWithBinding(
  outcome: EnrichmentBoundNativeOutcome,
  binding: FrozenAssertionBinding | null
): boolean {
  // Pointer-only authored evidence may attribute by pointer. Supplied request
  // or assertion identities must still agree with one current binding source.
  if (outcome.request_key === undefined && outcome.current_assertion_id === undefined &&
      outcome.occurrence_identity === undefined) {
    return true;
  }
  if (binding === null) return false;
  return binding.current.some((item) => currentIdentityAgrees(item, outcome));
}

function currentIdentityAgrees(
  item: FrozenBoundCurrentSource,
  outcome: EnrichmentBoundNativeOutcome
): boolean {
  if (outcome.occurrence_identity !== undefined && item.occurrenceIdentity !== outcome.occurrence_identity) {
    return false;
  }
  if (outcome.current_assertion_id !== undefined && item.assertion_id !== outcome.current_assertion_id) {
    return false;
  }
  if (outcome.request_key === undefined) return true;
  return item.request_keys !== null && item.request_keys.includes(outcome.request_key);
}

function materializeMissingExpectedRequestCells(
  row: FrozenAssertion,
  current: readonly FrozenBoundCurrentSource[],
  attributed: readonly EnrichmentBoundNativeOutcome[]
): readonly EnrichmentBoundNativeOutcome[] {
  const expected = current.flatMap((source) => (source.request_keys ?? []).map((key) => ({ source, key })));
  const missing = expected.flatMap(({ source, key }) => {
    // An outcome without occurrence attribution covers a request/assertion only
    // when that pair has exactly one expected occurrence in this frozen row.
    const peers = expected.filter((cell) => cell.key === key && cell.source.assertion_id === source.assertion_id);
    const accounted = attributed.some((item) => item.request_key === key &&
      item.current_assertion_id === source.assertion_id &&
      (item.occurrence_identity === source.occurrenceIdentity ||
        item.occurrence_identity === undefined && peers.length === 1));
    if (accounted) return [];
    return [Object.freeze({
      annotation_pointer: row.annotation_pointer,
      request_key: key,
      current_assertion_id: source.assertion_id,
      ...(source.occurrenceIdentity === null ? {} : { occurrence_identity: source.occurrenceIdentity }),
      request_ordinal: null,
      candidate_ordinal: null,
      raw_state: "missing" as const,
      machine_admission: "missing" as const
    })];
  });
  return missing.length === 0 ? attributed : [...attributed, ...missing];
}

function indexBindings(
  bindings: readonly FrozenAssertionBinding[]
): Map<string, FrozenAssertionBinding> {
  const index = new Map<string, FrozenAssertionBinding>();
  for (const binding of bindings) {
    index.set(pointerKey(binding.row), binding);
  }
  return index;
}

function pointerKey(row: FrozenAssertion): string {
  return `${row.population}\u0000${pointerFieldsKey(row.annotation_pointer)}`;
}

function pointerFieldsKey(pointer: FrozenAssertion["annotation_pointer"]): string {
  return [
    pointer.file,
    pointer.request_key,
    String(pointer.canonical_index),
    String(pointer.assertion_id)
  ].join("\u0000");
}

function countDroppedRows(
  rows: readonly FrozenAssertion[],
  bindings: readonly FrozenAssertionBinding[]
): number {
  const boundPointers = new Set(bindings.map((item) => pointerKey(item.row)));
  return rows.filter((row) => !boundPointers.has(pointerKey(row))).length;
}

function countBindingStatuses(bindings: readonly FrozenAssertionBinding[]): Record<FrozenBindingStatus, number> {
  const counts: Record<FrozenBindingStatus, number> = {
    bound: 0, unbound: 0, ineligible: 0, ambiguous: 0, partial: 0
  };
  for (const binding of bindings) counts[binding.status] += 1;
  return counts;
}

function uniqueRequiredGroupIds(
  rows: readonly FrozenAssertion[],
  predicate: (row: FrozenAssertion) => boolean = () => true
): readonly string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (row.classification !== "required" || row.required_group_id === null || !predicate(row)) {
      continue;
    }
    if (seen.has(row.required_group_id)) continue;
    seen.add(row.required_group_id);
    ids.push(row.required_group_id);
  }
  return Object.freeze(ids);
}

function uniqueFirstStageGroupIds(rows: readonly FrozenAssertion[]): readonly string[] {
  const present = uniqueRequiredGroupIds(rows, (row) => row.first_stage_subset);
  const known = FIRST_STAGE_GROUP_ORDER.filter((id) => present.includes(id));
  const rest = present.filter((id) => !(FIRST_STAGE_GROUP_ORDER as readonly string[]).includes(id));
  return Object.freeze([...known, ...rest]);
}

function uniqueNumber(values: readonly (number | null)[]): number | null {
  const present = values.filter((item): item is number => item !== null);
  if (present.length === 0) return null;
  const first = present[0]!;
  return present.every((item) => item === first) ? first : null;
}

function domainCellState(states: readonly PreparationCellState[]): PreparationCellState {
  if (states.length === 0) return "missing";
  const unique = new Set(states);
  if (unique.size === 1) return states[0]!;
  if (unique.has("rejected")) return "rejected";
  if (unique.has("partial")) return "partial";
  if (unique.has("unknown")) return "unknown";
  if (unique.has("missing")) return "partial";
  return "partial";
}

function publicationDomainState(
  rowStates: readonly PreparationCellState[]
): PreparationCellState {
  return rowStates.length === 0 ? "not_exercised" : domainCellState(rowStates);
}

function publicConsumptionStatus(
  fixtures: readonly EnrichmentFixtureOutcome[]
): PublicConsumptionState {
  if (fixtures.some((item) => item.result === "failed" || item.result === "not_verified")) {
    return "not_verified";
  }
  if (fixtures.some((item) => item.result === "passed")) return "exercised";
  return "not_exercised";
}
