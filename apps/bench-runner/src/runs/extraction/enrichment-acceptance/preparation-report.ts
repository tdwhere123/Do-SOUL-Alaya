import type { FrozenAssertion, FrozenClassification } from "./frozen-population.js";
import type {
  FrozenAssertionBinding,
  FrozenBindingStatus,
  FrozenPopulationBindings
} from "./source-binding.js";
import type { EnrichmentPreflight } from "./current-preflight.js";

export type HumanSemanticVerdict = "unreviewed";
export type PublicConsumptionState = "not_exercised" | "not_verified" | "exercised";
export type PreparationCellState =
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

export interface EnrichmentPreparationRow {
  readonly annotation_pointer: FrozenAssertion["annotation_pointer"];
  readonly original_ordinal: number;
  readonly population: FrozenAssertion["population"];
  readonly classification: FrozenClassification;
  readonly required_group_id: string | null;
  readonly first_stage_subset: boolean;
  readonly duplicate_of: number | null;
  readonly binding_status: FrozenBindingStatus;
  readonly binding_reason: string;
  readonly current_assertion_id: number | null;
  readonly current_semantic_key: string | null;
  readonly current_request_keys: readonly string[] | null;
  readonly human_verdict: HumanSemanticVerdict;
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
    readonly dropped_rows: number;
    readonly packing: FrozenPopulationBindings["packing"] | null;
    readonly first_stage_required_groups: 3;
    readonly full_required_groups: 15;
    readonly required_group_ids: {
      readonly first_stage: readonly string[];
      readonly full: readonly string[];
    };
    readonly human_verdicts: "unreviewed";
    readonly rows: readonly EnrichmentPreparationRow[];
    readonly fixture_outcomes: readonly EnrichmentFixtureOutcome[];
  };
  readonly native_formation_publication: {
    readonly status: PreparationCellState;
    readonly machine_admission: PreparationCellState;
    readonly human_verdict: HumanSemanticVerdict;
    readonly fixture_outcomes: readonly EnrichmentFixtureOutcome[];
    readonly note: string;
  };
  readonly public_consumption: {
    readonly status: PublicConsumptionState;
    readonly fixture_outcomes: readonly EnrichmentFixtureOutcome[];
    readonly note: string;
  };
}

const FIRST_STAGE_REQUIRED_GROUPS = 3;
const FULL_REQUIRED_GROUPS = 15;
const FIRST_STAGE_GROUP_ORDER = ["aspiration", "capability", "release"] as const;

export function composeEnrichmentPreparationReport(input: {
  readonly population: { readonly rows: readonly FrozenAssertion[] };
  readonly bindings: FrozenPopulationBindings;
  readonly preflight: EnrichmentPreflight | null;
  readonly fixtureOutcomes?: readonly EnrichmentFixtureOutcome[];
}): EnrichmentPreparationReport {
  const fixtures = Object.freeze([...(input.fixtureOutcomes ?? [])]);
  const byPointer = indexBindings(input.bindings.bindings);
  const rows = Object.freeze(input.population.rows.map((row) => {
    const binding = byPointer.get(pointerKey(row)) ?? null;
    return composeRow(row, binding);
  }));
  const statuses = countBindingStatuses(input.bindings.bindings);
  const dropped = Math.max(0, input.population.rows.length - input.bindings.bindings.length);
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
      dropped_rows: dropped,
      packing: input.bindings.packing,
      first_stage_required_groups: FIRST_STAGE_REQUIRED_GROUPS,
      full_required_groups: FULL_REQUIRED_GROUPS,
      required_group_ids: Object.freeze({
        first_stage: firstStageGroupIds,
        full: fullGroupIds
      }),
      human_verdicts: "unreviewed",
      rows,
      fixture_outcomes: fidelityFixtures
    }),
    native_formation_publication: Object.freeze({
      status: nativePublicationStatus(nativeFixtures),
      machine_admission: machineAdmission(nativeFixtures),
      human_verdict: "unreviewed",
      fixture_outcomes: nativeFixtures,
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
  binding: FrozenAssertionBinding | null
): EnrichmentPreparationRow {
  return Object.freeze({
    annotation_pointer: row.annotation_pointer,
    original_ordinal: row.original_ordinal,
    population: row.population,
    classification: row.classification,
    required_group_id: row.required_group_id,
    first_stage_subset: row.first_stage_subset,
    duplicate_of: row.duplicate_of,
    binding_status: binding?.status ?? "unbound",
    binding_reason: binding?.reason ?? "source map row has no binding result",
    current_assertion_id: binding?.current?.assertion_id ?? null,
    current_semantic_key: binding?.current?.semanticKey ?? null,
    current_request_keys: binding?.current?.request_keys ?? null,
    human_verdict: "unreviewed",
    machine_admission: "missing",
    raw_state: "missing"
  });
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
  const pointer = row.annotation_pointer;
  return [
    row.population,
    pointer.file,
    pointer.request_key,
    String(pointer.canonical_index),
    String(pointer.assertion_id)
  ].join("\u0000");
}

function countBindingStatuses(bindings: readonly FrozenAssertionBinding[]): Record<FrozenBindingStatus, number> {
  const counts: Record<FrozenBindingStatus, number> = {
    bound: 0, unbound: 0, ineligible: 0, ambiguous: 0
  };
  for (const binding of bindings) counts[binding.status] += 1;
  return counts;
}

function uniqueRequiredGroupIds(
  rows: readonly FrozenAssertion[]
): readonly string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (row.classification !== "required" || row.required_group_id === null) continue;
    if (seen.has(row.required_group_id)) continue;
    seen.add(row.required_group_id);
    ids.push(row.required_group_id);
  }
  return Object.freeze(ids);
}

function uniqueFirstStageGroupIds(rows: readonly FrozenAssertion[]): readonly string[] {
  const present = new Set(
    rows.filter((row) => row.first_stage_subset && row.required_group_id !== null)
      .map((row) => row.required_group_id as string)
  );
  return Object.freeze(FIRST_STAGE_GROUP_ORDER.filter((id) => present.has(id)));
}

function nativePublicationStatus(
  fixtures: readonly EnrichmentFixtureOutcome[]
): PreparationCellState {
  if (fixtures.length === 0) return "missing";
  if (fixtures.some((item) => item.result === "failed")) return "rejected";
  if (fixtures.some((item) => item.result === "not_run" || item.result === "not_verified")) {
    return "unknown";
  }
  if (fixtures.some((item) => item.cell_state === "partial")) return "partial";
  if (fixtures.some((item) => item.cell_state === "valid-empty")) return "valid-empty";
  return "unreviewed";
}

function machineAdmission(
  fixtures: readonly EnrichmentFixtureOutcome[]
): PreparationCellState {
  if (fixtures.length === 0) return "missing";
  if (fixtures.some((item) => item.result === "failed")) return "rejected";
  if (fixtures.every((item) => item.result === "passed")) {
    return fixtures.some((item) => item.cell_state === "valid-empty") ? "valid-empty" : "unreviewed";
  }
  if (fixtures.some((item) => item.cell_state === "partial")) return "partial";
  return "unknown";
}

function publicConsumptionStatus(
  fixtures: readonly EnrichmentFixtureOutcome[]
): PublicConsumptionState {
  if (fixtures.some((item) => item.result === "passed")) return "exercised";
  if (fixtures.some((item) => item.result === "not_verified" || item.result === "failed")) {
    return "not_verified";
  }
  return "not_exercised";
}

