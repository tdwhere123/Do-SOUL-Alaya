import type { RecallCandidate, RecallOriginPlane } from "@do-soul/alaya-protocol";
import { clamp01 } from "../../shared/clamp.js";

export type CandidateSemanticActivationSource =
  | "evidence_semantic"
  | "open_semantic_solution"
  | "effective_factor"
  | "object_embedding";

export type CandidateSemanticActivationScope =
  | "workspace_memory"
  | "evidence_capsule"
  | "global"
  | "ineligible";

export type CandidateActivationState =
  | "observed"
  | "absent"
  | "ineligible"
  | "invalid";

export type CandidateActivationOperatorId = "candidate_semantic_max_v1";

export type CandidateActivationObservation = Readonly<{
  readonly channel: string;
  readonly state: CandidateActivationState;
  readonly score: number | null;
}>;

export type CandidateActivationWinner = Readonly<{
  readonly channel: string;
  readonly score: number;
}>;

export type CandidateActivationReceipt = Readonly<{
  readonly schema_version: 1;
  readonly operator_id: CandidateActivationOperatorId;
  readonly state: CandidateActivationState;
  readonly score: number | null;
  readonly winner: CandidateActivationWinner | null;
  readonly observations: readonly CandidateActivationObservation[];
  readonly missing_channel_policy: "no_op";
}>;

export type CandidateSemanticActivation = CandidateActivationReceipt;

export type CandidateSemanticActivationInput = Readonly<{
  readonly scope: CandidateSemanticActivationScope;
  readonly evidenceSemantic?: number;
  readonly openSemanticSolution?: number;
  readonly effectiveEmbedding?: number;
  readonly objectEmbedding?: number;
}>;

export type CandidateSemanticActivationScopeInput = Readonly<{
  readonly originPlane: RecallOriginPlane | undefined;
  readonly objectKind: RecallCandidate["object_kind"] | undefined;
  readonly workspaceMemoryEligible: boolean;
}>;

const OPERATOR_ID = "candidate_semantic_max_v1" as const;
const MISSING_CHANNEL_POLICY = "no_op" as const;

export function resolveCandidateSemanticActivationScope(
  input: CandidateSemanticActivationScopeInput
): CandidateSemanticActivationScope {
  if (input.originPlane === "global") return "global";
  if (input.workspaceMemoryEligible) return "workspace_memory";
  return input.objectKind === "evidence_capsule"
    ? "evidence_capsule"
    : "ineligible";
}

export function resolveCandidateSemanticActivation(
  input: CandidateSemanticActivationInput
): CandidateActivationReceipt {
  const observations: CandidateActivationObservation[] = [
    observeChannel(
      "evidence_semantic",
      input.evidenceSemantic,
      input.scope === "workspace_memory" || input.scope === "evidence_capsule"
    ),
    ...(input.openSemanticSolution === undefined ? [] : [observeChannel(
      "open_semantic_solution",
      input.openSemanticSolution,
      input.scope === "workspace_memory" || input.scope === "evidence_capsule"
    )]),
    observeChannel(
      "effective_factor",
      input.effectiveEmbedding,
      input.scope === "workspace_memory" || input.scope === "global"
    ),
    observeChannel(
      "object_embedding",
      input.objectEmbedding,
      input.scope === "workspace_memory"
    )
  ];
  let winner: CandidateActivationWinner | null = null;
  for (const observation of observations) {
    if (observation.state !== "observed" || observation.score === null) continue;
    if (winner === null || observation.score > winner.score) {
      winner = { channel: observation.channel, score: observation.score };
    }
  }
  const state: CandidateActivationState = input.scope === "ineligible"
    ? "ineligible"
    : winner !== null
      ? "observed"
      : observations.some((observation) => observation.state === "invalid")
        ? "invalid"
        : "absent";
  return freezeReceipt(state, winner, observations);
}

function observeChannel(
  channel: CandidateSemanticActivationSource,
  value: number | undefined,
  eligible: boolean
): CandidateActivationObservation {
  if (!eligible) {
    return { channel, state: "ineligible", score: null };
  }
  if (value === undefined) {
    return { channel, state: "absent", score: null };
  }
  if (!Number.isFinite(value) || value < 0) {
    return { channel, state: "invalid", score: null };
  }
  return { channel, state: "observed", score: clamp01(value) };
}

function freezeReceipt(
  state: CandidateActivationState,
  winner: CandidateActivationWinner | null,
  observations: readonly CandidateActivationObservation[]
): CandidateActivationReceipt {
  return Object.freeze({
    schema_version: 1,
    operator_id: OPERATOR_ID,
    state,
    score: winner?.score ?? null,
    winner: winner === null ? null : Object.freeze(winner),
    observations: Object.freeze(observations),
    missing_channel_policy: MISSING_CHANNEL_POLICY
  });
}
