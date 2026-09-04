import { digestRecallFieldIdentity, type RecallFieldDigest } from
  "../../../field/field-identity.js";
import { compareText } from "../../../../shared/compare-text.js";
import type { D1CandidateEnvelopeMap } from "../adapters/lexical-bound/legal-envelope.js";
import { freezeShadow } from "../../contract-primitives.js";
import type { VerifiedMeasurementAuthorityV1 } from "../measurement/index.js";
import type { SupportMaterializationV1 } from "../support/index.js";
import type {
  SupportAliasRecordV1,
  SupportCorrelationRecordV1
} from "../support/types.js";
import type { SupportObservabilityGapV1 } from "../support/adapters/types.js";
import { comparePsiV2 } from "./compare.js";
import type {
  PsiV2AuthorityArtifactV1,
  PsiV2PairOutcomeV1
} from "./authority.js";
import {
  psiV2CandidateFromLexicalEnvelope,
  rawMissingFamilyFragment
} from "./from-envelope.js";
import { psiV2CandidatesFromSupport } from "./support-measurement-adapter.js";
import type { PsiV2CandidateV1, PsiV2CoordinateV1 } from "./types.js";

export type PsiV2ShadowObservationStatusV1 =
  | "observed"
  | "not_observed"
  | "producer_unavailable"
  | "malformed";

export type PsiV2ProducerIdV1 = "lex.interval" | "support";

export type PsiV2ProducerOutcomeV1 =
  | Readonly<{
      readonly producer_id: PsiV2ProducerIdV1;
      readonly status: "observed";
    }>
  | Readonly<{
      readonly producer_id: PsiV2ProducerIdV1;
      readonly status: "not_observed";
      readonly reason: "input_absent" | "applicable_receipt_absent";
    }>
  | Readonly<{
      readonly producer_id: PsiV2ProducerIdV1;
      readonly status: "producer_unavailable";
      readonly reason: "authority_unavailable" | "source_unavailable";
    }>
  | Readonly<{
      readonly producer_id: PsiV2ProducerIdV1;
      readonly status: "malformed";
      readonly contract_code:
        | "authority_identity_mismatch"
        | "authority_verification_failed"
        | "authority_query_condition_invalid"
        | "authority_workspace_identity_mismatch"
        | "authority_canonical_query_invalid"
        | "authority_canonical_query_identity_mismatch"
        | "authority_canonical_snapshot_receipt_mismatch"
        | "authority_snapshot_vector_invalid"
        | "authority_snapshot_coherence_invalid"
        | "authority_snapshot_lease_invalid"
        | "authority_lexical_request_pin_invalid"
        | "duplicate_receipt"
        | "foreign_candidate_receipt"
        | "measurement_identity_pin_absent"
        | "observed_payload_absent"
        | "producer_contract_invalid"
        | "diagnostic_contract_failure";
    }>;

export type PsiV2ShadowVisibilityV1 = Readonly<{
  readonly conflict: boolean;
  readonly alias: boolean;
  readonly unknown_correlation: boolean;
  readonly unsupported: boolean;
}>;

export type PsiV2ShadowDiagnosticsV1 = Readonly<{
  readonly schema_version: 1;
  readonly operator_id: "recall_psi_v2_shadow_v1";
  readonly observation_status: PsiV2ShadowObservationStatusV1;
  readonly frontier_width: number | null;
  readonly undominated_share: number | null;
  readonly blocked_share: number | null;
  readonly incomparable_share: number | null;
  readonly tradeoff_share: number | null;
  readonly equal_share: number | null;
  readonly cycle_count: number | null;
  readonly first_frontier_size: number | null;
  readonly frontier_depth: number | null;
  readonly pair_state_counts: Readonly<Record<PsiV2PairOutcomeV1, number>> | null;
  readonly raw_fragment_veto: boolean;
  readonly support_graph_digest: string | null;
  readonly support_outcome_digest: RecallFieldDigest | null;
  readonly producer_outcomes: readonly PsiV2ProducerOutcomeV1[];
  readonly reasons: readonly string[];
  readonly visibility: PsiV2ShadowVisibilityV1 | null;
  readonly digest: RecallFieldDigest;
}>;

export type PsiV2ShadowInputV1 = Readonly<{
  readonly query_id?: string;
  readonly snapshot_digest?: string;
  readonly candidate_keys: readonly string[];
  readonly lexical_interval_by_key?: Readonly<Record<string, D1CandidateEnvelopeMap>>;
  readonly lexical_measurement_authority?: VerifiedMeasurementAuthorityV1;
  readonly support?: SupportMaterializationV1;
  readonly support_measurement_authority?: VerifiedMeasurementAuthorityV1;
  readonly producer_outcomes?: readonly PsiV2ProducerOutcomeV1[];
  readonly aliases?: readonly SupportAliasRecordV1[];
  readonly correlations?: readonly SupportCorrelationRecordV1[];
  readonly conflicts?: readonly Readonly<{ readonly kind: string }>[];
  readonly unsupported?: readonly SupportObservabilityGapV1[];
  readonly issued_artifact?: PsiV2AuthorityArtifactV1;
}>;

export function buildPsiV2ShadowDiagnostics(
  input: PsiV2ShadowInputV1
): PsiV2ShadowDiagnosticsV1 {
  const producerOutcomes = producerOutcomesOf(input);
  if (!producersRan(input, producerOutcomes)) {
    return finish(unobservedBody(input, producerOutcomes));
  }
  const status = observationStatus(input, producerOutcomes);
  const candidates = candidatesFrom(input, producerOutcomes);
  if (status !== "observed") {
    return finish(inactiveBody(input, producerOutcomes, status));
  }
  const artifact = input.issued_artifact;
  const projected = artifact === undefined
    ? unavailablePsiSummaries()
    : projectIssuedArtifact(artifact);
  return finish({
    schema_version: 1 as const,
    operator_id: "recall_psi_v2_shadow_v1" as const,
    observation_status: status,
    ...projected,
    raw_fragment_veto: rawFragmentVeto(input, candidates),
    support_graph_digest: input.support?.graph.digest ?? null,
    support_outcome_digest: supportOutcomeDigest(input.support),
    producer_outcomes: producerOutcomes,
    reasons: reasonsOf(input.support, producerOutcomes, candidates),
    visibility: visibilityOf(input)
  });
}

function producersRan(
  input: PsiV2ShadowInputV1,
  outcomes: readonly PsiV2ProducerOutcomeV1[]
): boolean {
  return outcomes.some((outcome) => outcome.status !== "not_observed") ||
    input.lexical_interval_by_key !== undefined ||
    input.support !== undefined ||
    input.aliases !== undefined ||
    input.correlations !== undefined ||
    input.conflicts !== undefined ||
    input.unsupported !== undefined;
}

function unobservedBody(
  input: PsiV2ShadowInputV1,
  producerOutcomes: readonly PsiV2ProducerOutcomeV1[]
) {
  return inactiveBody(input, producerOutcomes, "not_observed");
}

function inactiveBody(
  input: PsiV2ShadowInputV1,
  producerOutcomes: readonly PsiV2ProducerOutcomeV1[],
  observationStatus: PsiV2ShadowObservationStatusV1
) {
  return {
    schema_version: 1 as const,
    operator_id: "recall_psi_v2_shadow_v1" as const,
    observation_status: observationStatus,
    frontier_width: null,
    undominated_share: null,
    blocked_share: null,
    incomparable_share: null,
    tradeoff_share: null,
    equal_share: null,
    cycle_count: null,
    first_frontier_size: null,
    frontier_depth: null,
    pair_state_counts: null,
    raw_fragment_veto: false,
    support_graph_digest: input.support?.graph.digest ?? null,
    support_outcome_digest: null,
    producer_outcomes: producerOutcomes,
    reasons: producerReasons(producerOutcomes),
    visibility: null
  };
}

function unavailablePsiSummaries() {
  return {
    frontier_width: null,
    undominated_share: null,
    blocked_share: null,
    incomparable_share: null,
    tradeoff_share: null,
    equal_share: null,
    cycle_count: null,
    first_frontier_size: null,
    frontier_depth: null,
    pair_state_counts: null
  };
}

function projectIssuedArtifact(artifact: PsiV2AuthorityArtifactV1) {
  const pairShares = pairSharesFromArtifact(artifact);
  const universe = artifact.candidate_universe.length;
  return {
    frontier_width: artifact.frontier_depth,
    undominated_share: artifact.first_frontier_size === null || universe === 0
      ? null
      : share(artifact.first_frontier_size, universe),
    blocked_share: pairShares.blocked,
    incomparable_share: pairShares.incomparable,
    tradeoff_share: pairShares.tradeoff,
    equal_share: pairShares.equal,
    cycle_count: artifact.cycle_status === "cycle" ? 1 : 0,
    first_frontier_size: artifact.first_frontier_size,
    frontier_depth: artifact.frontier_depth,
    pair_state_counts: pairCountsFromArtifact(artifact)
  };
}

function pairSharesFromArtifact(artifact: PsiV2AuthorityArtifactV1): {
  blocked: number;
  incomparable: number;
  tradeoff: number;
  equal: number;
} {
  let blocked = 0;
  let incomparable = 0;
  let tradeoff = 0;
  let equal = 0;
  let pairs = 0;
  for (const row of artifact.pair_outcomes) {
    if (row.left_candidate_key >= row.right_candidate_key) continue;
    pairs += 1;
    const kind = row.outcome;
    if (kind === "uncertain" || kind === "unsupported") blocked += 1;
    if (kind === "incomparable") incomparable += 1;
    if (kind === "tradeoff") tradeoff += 1;
    if (kind === "equal") equal += 1;
  }
  return {
    blocked: share(blocked, pairs),
    incomparable: share(incomparable, pairs),
    tradeoff: share(tradeoff, pairs),
    equal: share(equal, pairs)
  };
}

function pairCountsFromArtifact(
  artifact: PsiV2AuthorityArtifactV1
): Readonly<Record<PsiV2PairOutcomeV1, number>> {
  const counts: Record<PsiV2PairOutcomeV1, number> = {
    strict_edge: 0,
    reverse_edge: 0,
    equal: 0,
    incomparable: 0,
    tradeoff: 0,
    uncertain: 0,
    unsupported: 0
  };
  for (const row of artifact.pair_outcomes) counts[row.outcome] += 1;
  return freezeShadow(counts);
}

function candidatesFrom(
  input: PsiV2ShadowInputV1,
  outcomes: readonly PsiV2ProducerOutcomeV1[]
): readonly PsiV2CandidateV1[] {
  const lexicalMaps = input.lexical_interval_by_key;
  const queryId = input.query_id;
  const snapshotDigest = input.snapshot_digest;
  const lexical = !producerObserved(outcomes, "lex.interval") ||
      lexicalMaps === undefined || queryId === undefined || snapshotDigest === undefined
    ? []
    : input.candidate_keys.map((key) => psiV2CandidateFromLexicalEnvelope(
        key,
        lexicalMaps[key],
        input.lexical_measurement_authority ?? queryId,
        snapshotDigest
      ));
  const support = !producerObserved(outcomes, "support") || input.support === undefined
    ? []
    : psiV2CandidatesFromSupport({
        candidate_keys: input.candidate_keys,
        support: input.support,
        ...(input.support_measurement_authority === undefined
          ? {}
          : { measurement_authority: input.support_measurement_authority })
      });
  return mergeCandidates(input.candidate_keys, lexical, support);
}

function mergeCandidates(
  keys: readonly string[],
  ...fields: readonly (readonly PsiV2CandidateV1[])[]
): readonly PsiV2CandidateV1[] {
  const byCandidate = new Map(keys.map((key) => [key, new Map<string, PsiV2CoordinateV1>()]));
  for (const field of fields) {
    for (const candidate of field) {
      const coordinates = byCandidate.get(candidate.candidate_id);
      if (coordinates === undefined) continue;
      for (const coordinate of candidate.coordinates) {
        coordinates.set(coordinate.proposition_id, coordinate);
      }
    }
  }
  return Object.freeze([...byCandidate].map(([candidateId, coordinates]) => freezeShadow({
    candidate_id: candidateId,
    coordinates: Object.freeze([...coordinates.values()].sort((left, right) =>
      compareText(left.proposition_id, right.proposition_id)))
  })));
}

function observationStatus(
  input: PsiV2ShadowInputV1,
  producerOutcomes: readonly PsiV2ProducerOutcomeV1[]
): PsiV2ShadowObservationStatusV1 {
  const outcomes = input.support?.outcomes ?? [];
  if (outcomes.some((row) => row.status === "malformed") ||
      producerOutcomes.some((row) => row.status === "malformed")) return "malformed";
  if (outcomes.some((row) => row.status === "producer_unavailable") ||
      producerOutcomes.some((row) => row.status === "producer_unavailable")) {
    return "producer_unavailable";
  }
  if (outcomes.some((row) => row.status === "observed") ||
      producerObserved(producerOutcomes, "lex.interval") ||
      (input.support?.proposition_observations.length ?? 0) > 0) return "observed";
  return outcomes.some((row) => row.status === "not_observed")
    ? "not_observed"
    : producerOutcomes.some((row) => row.status === "not_observed")
      ? "not_observed"
      : "observed";
}

function supportOutcomeDigest(
  support: SupportMaterializationV1 | undefined
): RecallFieldDigest | null {
  if (support === undefined) return null;
  const outcomes = support.outcomes.map((row) => digestRecallFieldIdentity(row)).sort();
  return digestRecallFieldIdentity({ outcomes });
}

function reasonsOf(
  support: SupportMaterializationV1 | undefined,
  producerOutcomes: readonly PsiV2ProducerOutcomeV1[],
  candidates: readonly PsiV2CandidateV1[]
): readonly string[] {
  const reasons = new Set<string>(producerReasons(producerOutcomes));
  for (const outcome of support?.outcomes ?? []) {
    if (outcome.status === "observed") continue;
    const detail = outcome.status === "malformed" ? outcome.contract_code : outcome.reason;
    reasons.add(`support producer ${outcome.status}: ${detail}`);
  }
  for (const candidate of candidates) {
    for (const coordinate of candidate.coordinates) {
      const collapse = coordinate.collapse;
      if (collapse.status === "unresolved" || collapse.status === "blocked") {
        reasons.add(collapse.reason);
      } else if (collapse.status === "conflict") {
        reasons.add("measurement collapse conflict");
      }
    }
  }
  return Object.freeze([...reasons].sort());
}

function producerReasons(
  outcomes: readonly PsiV2ProducerOutcomeV1[]
): readonly string[] {
  return Object.freeze(outcomes.flatMap((outcome) => {
    if (outcome.status === "observed") return [];
    const detail = outcome.status === "malformed"
      ? outcome.contract_code
      : outcome.reason;
    return [`${outcome.producer_id} producer ${outcome.status}: ${detail}`];
  }).sort());
}

function producerObserved(
  outcomes: readonly PsiV2ProducerOutcomeV1[],
  producerId: PsiV2ProducerIdV1
): boolean {
  return outcomes.some((outcome) =>
    outcome.producer_id === producerId && outcome.status === "observed");
}

function producerOutcomesOf(
  input: PsiV2ShadowInputV1
): readonly PsiV2ProducerOutcomeV1[] {
  const suppliedRows = input.producer_outcomes ?? [];
  const supplied = new Map(suppliedRows.map((row) => [row.producer_id, row]));
  return Object.freeze((["lex.interval", "support"] as const).map((producerId) => {
    if (suppliedRows.filter((row) => row.producer_id === producerId).length > 1) {
      return malformedProducer(producerId, "producer_contract_invalid");
    }
    const outcome = supplied.get(producerId) ?? inferredProducerOutcome(input, producerId);
    const payloadPresent = producerId === "lex.interval"
      ? input.lexical_interval_by_key !== undefined
      : input.support !== undefined;
    if (outcome.status === "observed" && !payloadPresent) {
      return malformedProducer(producerId, "observed_payload_absent");
    }
    if (outcome.status === "observed" &&
        (input.query_id === undefined || input.snapshot_digest === undefined)) {
      return malformedProducer(producerId, "measurement_identity_pin_absent");
    }
    return outcome;
  }));
}

function inferredProducerOutcome(
  input: PsiV2ShadowInputV1,
  producerId: PsiV2ProducerIdV1
): PsiV2ProducerOutcomeV1 {
  const observed = producerId === "lex.interval"
    ? input.lexical_interval_by_key !== undefined
    : input.support !== undefined;
  return observed
    ? freezeShadow({ producer_id: producerId, status: "observed" as const })
    : freezeShadow({
        producer_id: producerId,
        status: "not_observed" as const,
        reason: "input_absent" as const
      });
}

function malformedProducer(
  producerId: PsiV2ProducerIdV1,
  contractCode: Extract<PsiV2ProducerOutcomeV1, { status: "malformed" }>["contract_code"]
): PsiV2ProducerOutcomeV1 {
  return freezeShadow({
    producer_id: producerId,
    status: "malformed" as const,
    contract_code: contractCode
  });
}

export function malformedPsiV2ShadowDiagnostics(): PsiV2ShadowDiagnosticsV1 {
  const producerOutcomes = Object.freeze((["lex.interval", "support"] as const).map(
    (producerId) => malformedProducer(producerId, "diagnostic_contract_failure")
  ));
  return finish({
    ...unobservedBody({ candidate_keys: [] }, producerOutcomes),
    observation_status: "malformed"
  });
}

function visibilityOf(input: PsiV2ShadowInputV1): PsiV2ShadowVisibilityV1 {
  const aliases = input.aliases ?? input.support?.graph.aliases ?? [];
  const correlations = input.correlations ?? input.support?.graph.correlations ?? [];
  const gaps = input.unsupported ?? input.support?.gaps ?? [];
  const polarities = input.support?.polarities ?? [];
  return freezeShadow({
    conflict: (input.conflicts?.length ?? 0) > 0 ||
      aliases.some((row) => row.state === "conflict") ||
      polarities.some((row) => row.epistemic.kind === "conflict" || row.payload?.polarity === "both"),
    alias: aliases.length > 0,
    unknown_correlation: correlations.some((row) => row.state === "possibly_correlated"),
    unsupported: gaps.length > 0
  });
}

function rawFragmentVeto(
  input: PsiV2ShadowInputV1,
  candidates: readonly PsiV2CandidateV1[]
): boolean {
  const maps = input.lexical_interval_by_key;
  if (maps === undefined) return false;
  const byId = new Map(candidates.map((row) => [row.candidate_id, row]));
  const keys = input.candidate_keys;
  const currentAuthorities = measurementAuthorities(input);
  for (let i = 0; i < keys.length; i += 1) {
    for (let j = i + 1; j < keys.length; j += 1) {
      if (pairRawFragmentVeto(
        keys[i]!, keys[j]!, maps, byId, currentAuthorities
      )) return true;
    }
  }
  return false;
}

function pairRawFragmentVeto(
  leftKey: string,
  rightKey: string,
  maps: Readonly<Record<string, D1CandidateEnvelopeMap>>,
  byId: ReadonlyMap<string, PsiV2CandidateV1>,
  currentAuthorities: readonly VerifiedMeasurementAuthorityV1[]
): boolean {
  const leftMap = maps[leftKey];
  const rightMap = maps[rightKey];
  const left = byId.get(leftKey);
  const right = byId.get(rightKey);
  if (leftMap === undefined || rightMap === undefined || left === undefined || right === undefined) {
    return false;
  }
  if (!rawMissingFamilyFragment(leftMap, rightMap)) return false;
  return comparePsiV2(left, right, currentAuthorities).kind === "blocked";
}

function measurementAuthorities(
  input: PsiV2ShadowInputV1
): readonly VerifiedMeasurementAuthorityV1[] {
  return Object.freeze([
    input.lexical_measurement_authority,
    input.support_measurement_authority
  ].filter((authority): authority is VerifiedMeasurementAuthorityV1 => authority !== undefined));
}

function share(count: number, total: number): number {
  return total === 0 ? 0 : count / total;
}

function finish(
  body: Omit<PsiV2ShadowDiagnosticsV1, "digest">
): PsiV2ShadowDiagnosticsV1 {
  const frozen = freezeShadow(body);
  return freezeShadow({
    ...frozen,
    digest: digestRecallFieldIdentity(frozen)
  });
}
