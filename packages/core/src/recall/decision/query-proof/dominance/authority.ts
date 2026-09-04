import { types as nodeTypes } from "node:util";
import { freezeShadow, ShadowContractError } from "../../contract-primitives.js";
import { digestRecallFieldIdentity, type RecallFieldDigest } from
  "../../../field/field-identity.js";
import { comparePsiV2 } from "./compare.js";
import { peelPsiV2Frontiers } from "./frontier.js";
import { isPsiCycleFailure } from "../frontier-peel.js";
import type { CurrentMeasurementAuthoritiesV1 } from "../measurement/admission.js";
import type { PsiV2CandidateV1 } from "./types.js";

export type PsiV2PairOutcomeV1 =
  | "strict_edge"
  | "reverse_edge"
  | "equal"
  | "incomparable"
  | "tradeoff"
  | "uncertain"
  | "unsupported";

export type PsiV2IssuedObservationStatusV1 =
  | "observed"
  | "not_observed"
  | "producer_unavailable"
  | "malformed";

export type PsiV2IssuedProducerOutcomeV1 = Readonly<{
  readonly producer_id: "lex.interval" | "support";
  readonly status: PsiV2IssuedObservationStatusV1;
  readonly reason?: string;
  readonly contract_code?: string;
}>;

export type PsiV2CandidateObjectV1 = Readonly<{
  readonly candidate_key: string;
  readonly object_key: string | null;
  readonly h_eligible: boolean | null;
  readonly h_eligibility_source: string | null;
}>;

export interface PsiV2AuthorityArtifactV1 {
  readonly schema_version: 1;
  readonly query_digest: string;
  readonly request_digest: string | null;
  readonly snapshot_digest: string;
  readonly principal_digest: string | null;
  readonly workspace_id: string | null;
  readonly generation: string | null;
  readonly source_authority_digests: readonly string[];
  readonly candidate_universe: readonly string[];
  readonly candidate_objects: readonly PsiV2CandidateObjectV1[];
  readonly observation_status: PsiV2IssuedObservationStatusV1;
  readonly producer_outcomes: readonly PsiV2IssuedProducerOutcomeV1[];
  readonly pair_outcomes: readonly Readonly<{
    readonly left_candidate_key: string;
    readonly right_candidate_key: string;
    readonly outcome: PsiV2PairOutcomeV1;
  }>[];
  readonly psi_edges: readonly (readonly [string, string])[];
  readonly unresolved_tradeoff_pairs: readonly (readonly [string, string])[];
  readonly peeled_layers: readonly (readonly string[])[];
  readonly cycle_status: "no_cycle" | "cycle";
  readonly first_frontier_size: number | null;
  readonly frontier_depth: number | null;
  readonly structural_digest: RecallFieldDigest;
}

export interface IssuePsiV2AuthorityInput {
  readonly query_digest: string;
  readonly snapshot_digest: string;
  readonly request_digest?: string;
  readonly principal_digest?: string;
  readonly workspace_id?: string;
  readonly generation?: string;
  readonly source_authority_digests?: readonly string[];
  readonly candidates: readonly PsiV2CandidateV1[];
  readonly candidate_objects?: readonly Readonly<{
    readonly candidate_key: string;
    readonly object_key: string;
    readonly h_eligible: boolean;
    readonly h_eligibility_source?: string;
  }>[];
  readonly current_authorities: CurrentMeasurementAuthoritiesV1;
  readonly producer_outcomes?: readonly PsiV2IssuedProducerOutcomeV1[];
  readonly observation_status?: PsiV2IssuedObservationStatusV1;
}

export function issuePsiV2AuthorityArtifact(
  input: IssuePsiV2AuthorityInput
): PsiV2AuthorityArtifactV1 {
  const captured = captureIssueInput(input);
  const candidates = captured.candidates;
  const candidateKeys = candidates.map((row) => row.candidate_id);
  if (new Set(candidateKeys).size !== candidateKeys.length) {
    throw new ShadowContractError("Psi-v2 candidate universe must be injective");
  }
  const { pairOutcomes, psiEdges, unresolvedTradeoffPairs } =
    evaluatePairOutcomes(candidates, captured.current_authorities);
  const expectedPairs = candidateKeys.length * Math.max(0, candidateKeys.length - 1);
  if (pairOutcomes.length !== expectedPairs) {
    throw new ShadowContractError("Psi-v2 pair domain is incomplete");
  }
  const peeled = peelPsiV2Frontiers(candidates, captured.current_authorities);
  const isCycle = isPsiCycleFailure(peeled);
  const cycleStatus = isCycle ? "cycle" as const : "no_cycle" as const;
  const peeledLayers = isCycle ? [] : peeled.layers.map((layer) => layer.member_keys);
  const firstFrontierSize = isCycle ? null : (peeled.layers[0]?.member_keys.length ?? 0);
  const frontierDepth = isCycle ? null : peeled.layers.length;
  const producerOutcomes = captured.producer_outcomes;
  const observationStatus = captured.observation_status;
  const candidateObjects = captured.candidate_objects;
  const sourceAuthorityDigests = captured.source_authority_digests;
  const body = {
    schema_version: 1 as const,
    query_digest: captured.query_digest,
    request_digest: captured.request_digest,
    snapshot_digest: captured.snapshot_digest,
    principal_digest: captured.principal_digest,
    workspace_id: captured.workspace_id,
    generation: captured.generation,
    source_authority_digests: sourceAuthorityDigests,
    candidate_universe: Object.freeze([...candidateKeys]),
    candidate_objects: candidateObjects,
    observation_status: observationStatus,
    producer_outcomes: producerOutcomes,
    pair_outcomes: Object.freeze(pairOutcomes),
    psi_edges: Object.freeze(psiEdges),
    unresolved_tradeoff_pairs: Object.freeze(unresolvedTradeoffPairs),
    peeled_layers: Object.freeze(peeledLayers.map((layer) => Object.freeze([...layer]))),
    cycle_status: cycleStatus,
    first_frontier_size: firstFrontierSize,
    frontier_depth: frontierDepth
  };
  return freezeShadow({
    ...body,
    structural_digest: digestRecallFieldIdentity(body)
  });
}

function evaluatePairOutcomes(
  candidates: readonly PsiV2CandidateV1[],
  currentAuthorities: CurrentMeasurementAuthoritiesV1
) {
  const pairOutcomes: Array<{
    left_candidate_key: string;
    right_candidate_key: string;
    outcome: PsiV2PairOutcomeV1;
  }> = [];
  const psiEdges: Array<readonly [string, string]> = [];
  const unresolvedTradeoffPairs: Array<readonly [string, string]> = [];
  for (let i = 0; i < candidates.length; i++) {
    for (let j = 0; j < candidates.length; j++) {
      if (i === j) continue;
      const left = candidates[i]!;
      const right = candidates[j]!;
      const verdict = comparePsiV2(left, right, currentAuthorities);
      const outcome = pairOutcomeOf(verdict.kind, left, right);
      if (outcome === "strict_edge") {
        psiEdges.push(Object.freeze([left.candidate_id, right.candidate_id]));
      }
      if (outcome === "tradeoff" && i < j) {
        unresolvedTradeoffPairs.push(
          Object.freeze([left.candidate_id, right.candidate_id])
        );
      }
      pairOutcomes.push({
        left_candidate_key: left.candidate_id,
        right_candidate_key: right.candidate_id,
        outcome
      });
    }
  }
  return { pairOutcomes, psiEdges, unresolvedTradeoffPairs };
}

function pairOutcomeOf(
  kind: ReturnType<typeof comparePsiV2>["kind"],
  left: PsiV2CandidateV1,
  right: PsiV2CandidateV1
): PsiV2PairOutcomeV1 {
  switch (kind) {
    case "dominates":
      return "strict_edge";
    case "dominated_by":
      return "reverse_edge";
    case "equal":
      return "equal";
    case "incomparable":
      return "incomparable";
    case "tradeoff":
      return "tradeoff";
    case "blocked":
      return blockedPairOutcome(left, right);
    default:
      return "unsupported";
  }
}

function blockedPairOutcome(
  left: PsiV2CandidateV1,
  right: PsiV2CandidateV1
): "uncertain" | "unsupported" {
  const statuses = [...left.coordinates, ...right.coordinates].map(
    (row) => row.collapse.status
  );
  if (statuses.some((status) => status === "unresolved" || status === "conflict")) {
    return "uncertain";
  }
  return "unsupported";
}

type CapturedIssueInput = Readonly<{
  readonly query_digest: string;
  readonly snapshot_digest: string;
  readonly request_digest: string | null;
  readonly principal_digest: string | null;
  readonly workspace_id: string | null;
  readonly generation: string | null;
  readonly source_authority_digests: readonly string[];
  readonly candidates: readonly PsiV2CandidateV1[];
  readonly candidate_objects: readonly PsiV2CandidateObjectV1[];
  readonly current_authorities: CurrentMeasurementAuthoritiesV1;
  readonly producer_outcomes: readonly PsiV2IssuedProducerOutcomeV1[];
  readonly observation_status: PsiV2IssuedObservationStatusV1;
}>;

function captureIssueInput(input: IssuePsiV2AuthorityInput): CapturedIssueInput {
  assertPlainSnapshot(input);
  const queryDigest = capturedString(input.query_digest, "query_digest");
  const snapshotDigest = capturedString(input.snapshot_digest, "snapshot_digest");
  const requestDigest = optionalString(input.request_digest);
  const principalDigest = optionalString(input.principal_digest);
  const workspaceId = optionalString(input.workspace_id);
  const generation = optionalString(input.generation);
  const authorities = snapshotAuthorityList(input.current_authorities);
  const candidates = snapshotCandidates(input.candidates);
  const objects = snapshotCandidateObjects(input.candidate_objects, candidates);
  const sourceDigests = snapshotSourceDigests(input.source_authority_digests, authorities);
  const producerOutcomes = snapshotProducerOutcomes(input.producer_outcomes);
  const observationStatus = input.observation_status ??
    (candidates.some((row) => row.coordinates.length > 0) ? "observed" : "not_observed");
  return Object.freeze({
    query_digest: queryDigest,
    snapshot_digest: snapshotDigest,
    request_digest: requestDigest,
    principal_digest: principalDigest,
    workspace_id: workspaceId,
    generation,
    source_authority_digests: sourceDigests,
    candidates,
    candidate_objects: objects,
    current_authorities: authorities,
    producer_outcomes: producerOutcomes,
    observation_status: observationStatus
  });
}

function snapshotCandidates(
  value: readonly PsiV2CandidateV1[]
): readonly PsiV2CandidateV1[] {
  return Object.freeze(snapshotArray(value, "candidates").map((row) => {
    assertPlainSnapshot(row);
    return Object.freeze({
      candidate_id: capturedString(row.candidate_id, "candidate_id"),
      coordinates: snapshotArray(row.coordinates, "coordinates")
    });
  }));
}

function snapshotAuthorityList(
  value: CurrentMeasurementAuthoritiesV1
): CurrentMeasurementAuthoritiesV1 {
  if (!Array.isArray(value) || nodeTypes.isProxy(value)) {
    throw new ShadowContractError("Psi-v2 authorities must be a dense array");
  }
  return Object.freeze([...value]);
}

function snapshotSourceDigests(
  supplied: readonly string[] | undefined,
  authorities: CurrentMeasurementAuthoritiesV1
): readonly string[] {
  if (supplied === undefined) {
    return Object.freeze(authorities.map((row) => row.authority_digest));
  }
  return Object.freeze(snapshotArray(supplied, "source_authority_digests").map(
    (row) => capturedString(row, "source_authority_digest")
  ));
}

function snapshotCandidateObjects(
  supplied: IssuePsiV2AuthorityInput["candidate_objects"],
  candidates: readonly PsiV2CandidateV1[]
): readonly PsiV2CandidateObjectV1[] {
  const byKey = new Map(
    (supplied === undefined ? [] : snapshotArray(supplied, "candidate_objects"))
      .map((row) => {
        assertPlainSnapshot(row);
        return [capturedString(row.candidate_key, "candidate_key"), Object.freeze({
          candidate_key: capturedString(row.candidate_key, "candidate_key"),
          object_key: capturedString(row.object_key, "object_key"),
          h_eligible: capturedBoolean(row.h_eligible, "h_eligible"),
          h_eligibility_source: optionalString(row.h_eligibility_source)
        })] as const;
      })
  );
  return Object.freeze(candidates.map((candidate) => {
    const row = byKey.get(candidate.candidate_id);
    return row ?? freezeShadow({
      candidate_key: candidate.candidate_id,
      object_key: null,
      h_eligible: null,
      h_eligibility_source: null
    });
  }));
}

function snapshotProducerOutcomes(
  supplied: readonly PsiV2IssuedProducerOutcomeV1[] | undefined
): readonly PsiV2IssuedProducerOutcomeV1[] {
  const rows = supplied === undefined
    ? [
        freezeShadow({
          producer_id: "lex.interval" as const,
          status: "not_observed" as const,
          reason: "input_absent"
        }),
        freezeShadow({
          producer_id: "support" as const,
          status: "not_observed" as const,
          reason: "input_absent"
        })
      ]
    : snapshotArray(supplied, "producer_outcomes").map((row) => {
        assertPlainSnapshot(row);
        return freezeShadow({
          producer_id: row.producer_id,
          status: row.status,
          ...(row.reason === undefined ? {} : { reason: capturedString(row.reason, "reason") }),
          ...(row.contract_code === undefined
            ? {}
            : { contract_code: capturedString(row.contract_code, "contract_code") })
        });
      });
  return Object.freeze(rows);
}

function snapshotArray<T>(value: readonly T[], label: string): readonly T[] {
  if (!Array.isArray(value) || nodeTypes.isProxy(value)) {
    throw new ShadowContractError(`Psi-v2 ${label} must be a dense array`);
  }
  const keys = Object.keys(value);
  if (keys.length !== value.length || keys.some((key, index) => key !== String(index))) {
    throw new ShadowContractError(`Psi-v2 ${label} must be dense without extra fields`);
  }
  for (let index = 0; index < value.length; index += 1) {
    ownDataValue(value, index, label);
  }
  return Object.freeze([...value]);
}

function assertPlainSnapshot(value: object): void {
  if (nodeTypes.isProxy(value)) {
    throw new ShadowContractError("Psi-v2 authority input cannot use proxies");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new ShadowContractError("Psi-v2 authority input must be a plain record");
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new ShadowContractError("Psi-v2 authority input must not contain symbol fields");
  }
  for (const key of Object.keys(value)) {
    ownDataValue(value, key, "input");
  }
}

function ownDataValue(value: object, key: PropertyKey, label: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined || descriptor.get !== undefined || descriptor.set !== undefined) {
    throw new ShadowContractError(`Psi-v2 ${label} cannot use getters`);
  }
  return descriptor.value;
}

function capturedString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ShadowContractError(`Psi-v2 ${label} must be a nonempty string`);
  }
  return value;
}

function optionalString(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return capturedString(value, "optional identity");
}

function capturedBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new ShadowContractError(`Psi-v2 ${label} must be a boolean`);
  }
  return value;
}
