import { compareText } from "../../../../../shared/compare-text.js";
import { digestRecallFieldIdentity, type RecallFieldDigest } from
  "../../../../field/field-identity.js";
import {
  assertDigest,
  assertIdentity,
  digestFiniteFixture,
  normalizeFiniteFixture,
  type FiniteDecisionOperator,
  type FiniteOracleFixture,
  type FiniteRefinementKind
} from "./contract.js";

export type TransferAbstractKind =
  | "membership"
  | "numeric_interval"
  | "finite_values"
  | "binding"
  | "temporal_interval"
  | "four_valued_proposition"
  | "correlation"
  | "semantic_feasibility"
  | "identity_tie";

export type FiniteTransferManifestRow = Readonly<{
  readonly coordinate_id: string;
  readonly sensitivity_id: string;
  readonly owner_id: string;
  readonly concrete_kind: FiniteRefinementKind;
  readonly abstract_kind: TransferAbstractKind;
}>;

type AbstractOperatorIdentity = Readonly<{
  readonly operator_id: string;
  readonly evaluate: unknown;
}>;

export type FiniteTransferAuthorityState = Readonly<{
  readonly fixture: FiniteOracleFixture;
  readonly concrete_operator: FiniteDecisionOperator;
  readonly abstract_operator: AbstractOperatorIdentity;
  readonly query_digest: RecallFieldDigest;
  readonly principal_digest: RecallFieldDigest;
  readonly manifest: readonly FiniteTransferManifestRow[];
  readonly fixture_digest: RecallFieldDigest;
  readonly manifest_digest: RecallFieldDigest;
  readonly transfer_digest: RecallFieldDigest;
}>;

declare const finiteTransferAuthorityBrand: unique symbol;
export type FiniteTransferAuthority = Readonly<{
  readonly [finiteTransferAuthorityBrand]: true;
}>;

const states = new WeakMap<object, FiniteTransferAuthorityState>();

export function issueFiniteTransferAuthority(params: Readonly<{
  readonly fixture: FiniteOracleFixture;
  readonly concrete_operator: FiniteDecisionOperator;
  readonly abstract_operator: AbstractOperatorIdentity;
  readonly query_digest: RecallFieldDigest;
  readonly principal_digest: RecallFieldDigest;
  readonly manifest: readonly FiniteTransferManifestRow[];
}>): FiniteTransferAuthority {
  assertExactKeys(params, [
    "fixture", "concrete_operator", "abstract_operator", "query_digest",
    "principal_digest", "manifest"
  ]);
  const fixture = normalizeFiniteFixture(params.fixture);
  assertOperator(params.concrete_operator, "concrete");
  assertOperator(params.abstract_operator, "abstract");
  assertDigest(params.query_digest, "finite transfer query");
  assertDigest(params.principal_digest, "finite transfer principal");
  const manifest = normalizeManifest(params.manifest, fixture);
  const fixtureDigest = digestFiniteFixture(fixture);
  const manifestDigest = digestRecallFieldIdentity(manifest);
  const transferDigest = digestRecallFieldIdentity({
    operator_id: "finite_abstract_transfer_authority_v1",
    query_digest: params.query_digest,
    principal_digest: params.principal_digest,
    snapshot_digest: fixture.snapshot_digest,
    fixture_digest: fixtureDigest,
    concrete_operator_id: params.concrete_operator.operator_id,
    abstract_operator_id: params.abstract_operator.operator_id,
    manifest_digest: manifestDigest
  });
  const authority = Object.freeze({}) as FiniteTransferAuthority;
  states.set(authority, Object.freeze({
    fixture: params.fixture,
    concrete_operator: params.concrete_operator,
    abstract_operator: params.abstract_operator,
    query_digest: params.query_digest,
    principal_digest: params.principal_digest,
    manifest,
    fixture_digest: fixtureDigest,
    manifest_digest: manifestDigest,
    transfer_digest: transferDigest
  }));
  return authority;
}

export function readFiniteTransferAuthority(
  authority: FiniteTransferAuthority
): FiniteTransferAuthorityState {
  const state = states.get(authority);
  if (state === undefined) throw new Error("finite transfer authority is invalid");
  return state;
}

export function verifyFiniteTransferParticipants(params: Readonly<{
  readonly authority: FiniteTransferAuthority;
  readonly fixture?: FiniteOracleFixture;
  readonly concrete_operator?: FiniteDecisionOperator;
  readonly abstract_operator?: AbstractOperatorIdentity;
}>): FiniteTransferAuthorityState {
  const state = readFiniteTransferAuthority(params.authority);
  if ((params.fixture !== undefined && params.fixture !== state.fixture) ||
      (params.concrete_operator !== undefined &&
        params.concrete_operator !== state.concrete_operator) ||
      (params.abstract_operator !== undefined &&
        params.abstract_operator !== state.abstract_operator)) {
    throw new Error("finite transfer participant identity mismatch");
  }
  return state;
}

export function validateFiniteTransferAbstractCoverage(params: Readonly<{
  readonly state: FiniteTransferAuthorityState;
  readonly coordinates: readonly Readonly<{
    readonly coordinate_id: string;
    readonly sensitivity_id: string;
    readonly owner_id: string;
    readonly kind: TransferAbstractKind;
  }>[];
  readonly closure_sensitivities: readonly Readonly<{
    readonly sensitivity_id: string;
    readonly effect: string;
  }>[];
}>): string | null {
  if (params.coordinates.length !== params.state.manifest.length) {
    return "abstract coordinates do not exactly cover transfer manifest";
  }
  for (let index = 0; index < params.coordinates.length; index += 1) {
    const coordinate = params.coordinates[index]!;
    const row = params.state.manifest[index]!;
    if (coordinate.coordinate_id !== row.coordinate_id ||
        coordinate.sensitivity_id !== row.sensitivity_id ||
        coordinate.owner_id !== row.owner_id || coordinate.kind !== row.abstract_kind) {
      return "abstract coordinate transfer mapping mismatch";
    }
  }
  const rows = new Map(params.state.manifest.map((row) => [row.sensitivity_id, row]));
  for (const sensitivity of params.closure_sensitivities) {
    const row = rows.get(sensitivity.sensitivity_id);
    if (row === undefined || !sensitivityKindMatches(
      sensitivity.effect, row.abstract_kind)) {
      return "channel CQ sensitivity is omitted from transfer manifest";
    }
  }
  return null;
}

function normalizeManifest(
  values: readonly FiniteTransferManifestRow[],
  fixture: FiniteOracleFixture
): readonly FiniteTransferManifestRow[] {
  const output = values.map((value) => {
    assertExactKeys(value, [
      "coordinate_id", "sensitivity_id", "owner_id", "concrete_kind", "abstract_kind"
    ]);
    assertIdentity(value.coordinate_id, "finite transfer coordinate");
    assertIdentity(value.sensitivity_id, "finite transfer sensitivity");
    assertIdentity(value.owner_id, "finite transfer owner");
    if (!ABSTRACT_KINDS.has(value.abstract_kind) ||
        !compatibleKinds(value.concrete_kind, value.abstract_kind)) {
      throw new Error("finite transfer coordinate kind mapping is invalid");
    }
    return Object.freeze({ ...value });
  }).sort((left, right) => compareText(left.coordinate_id, right.coordinate_id));
  const fixtureRows = fixture.coordinates;
  if (output.length !== fixtureRows.length || output.some((row, index) =>
    row.coordinate_id !== fixtureRows[index]?.coordinate_id ||
    row.concrete_kind !== fixtureRows[index]?.kind) ||
    new Set(output.map(({ sensitivity_id }) => sensitivity_id)).size !== output.length) {
    throw new Error("finite transfer manifest must exactly cover fixture coordinates");
  }
  return Object.freeze(output);
}

function compatibleKinds(concrete: FiniteRefinementKind, abstract: TransferAbstractKind) {
  switch (concrete) {
    case "candidate_membership": return abstract === "membership";
    case "witness_refinement":
      return abstract === "numeric_interval" || abstract === "finite_values" ||
        abstract === "temporal_interval";
    case "semantic_feasibility": return abstract === "semantic_feasibility";
    case "answer_binding": return abstract === "binding";
    case "proposition_conflict": return abstract === "four_valued_proposition";
    case "correlation_state": return abstract === "correlation";
    case "identity_tie": return abstract === "identity_tie";
  }
}

function sensitivityKindMatches(effect: string, kind: TransferAbstractKind): boolean {
  switch (effect) {
    case "proposition_bound":
    case "extremum_interval":
    case "answer_position": return kind === "numeric_interval";
    case "feasibility_change": return kind === "semantic_feasibility";
    case "answer_binding": return kind === "binding";
    case "correlation_group": return kind === "correlation";
    case "tie_winner_membership": return kind === "identity_tie";
    default: return false;
  }
}

function assertOperator(operator: Readonly<{ readonly operator_id: string }>, kind: string): void {
  assertExactKeys(operator, ["operator_id", kind === "concrete" ? "decide" : "evaluate"]);
  assertIdentity(operator.operator_id, `finite transfer ${kind} operator`);
  if (!/^[a-z0-9][a-z0-9._:-]*$/u.test(operator.operator_id) ||
      operator.operator_id.includes("decide_q") ||
      operator.operator_id.includes("sealchecker_v1")) {
    throw new Error(`finite transfer ${kind} operator id is reserved or noncanonical`);
  }
}

function assertExactKeys(value: object, allowed: readonly string[]): void {
  const keys = Object.keys(value).sort(compareText);
  const expected = [...allowed].sort(compareText);
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new Error("finite transfer value has unknown or missing fields");
  }
}

const ABSTRACT_KINDS: ReadonlySet<string> = new Set([
  "membership", "numeric_interval", "finite_values", "binding",
  "temporal_interval", "four_valued_proposition", "correlation",
  "semantic_feasibility", "identity_tie"
]);
