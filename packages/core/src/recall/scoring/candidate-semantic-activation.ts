import type { RecallCandidate, RecallOriginPlane } from "@do-soul/alaya-protocol";
import { clamp01 } from "../../shared/clamp.js";

export type CandidateSemanticActivationSource =
  | "evidence_semantic"
  | "effective_factor"
  | "object_embedding";

export type CandidateSemanticActivationScope =
  | "workspace_memory"
  | "evidence_capsule"
  | "global"
  | "ineligible";

export type CandidateSemanticActivation = Readonly<{
  readonly score: number | null;
  readonly source: CandidateSemanticActivationSource | null;
}>;

type SemanticActivationInput = Readonly<{
  readonly scope: CandidateSemanticActivationScope;
  readonly evidenceSemantic?: number;
  readonly effectiveEmbedding?: number;
  readonly objectEmbedding?: number;
}>;

type SemanticActivationScopeInput = Readonly<{
  readonly originPlane: RecallOriginPlane | undefined;
  readonly objectKind: RecallCandidate["object_kind"] | undefined;
  readonly workspaceMemoryEligible: boolean;
}>;

const INACTIVE_ACTIVATION: CandidateSemanticActivation = Object.freeze({
  score: null,
  source: null
});

export function resolveCandidateSemanticActivationScope(
  input: SemanticActivationScopeInput
): CandidateSemanticActivationScope {
  if (input.originPlane === "global") return "global";
  if (input.workspaceMemoryEligible) return "workspace_memory";
  return input.objectKind === "evidence_capsule"
    ? "evidence_capsule"
    : "ineligible";
}

export function resolveCandidateSemanticActivation(
  input: SemanticActivationInput
): CandidateSemanticActivation {
  let score: number | null = null;
  let source: CandidateSemanticActivationSource | null = null;
  if (input.scope === "workspace_memory" || input.scope === "evidence_capsule") {
    score = normalizeObservedScore(input.evidenceSemantic);
    if (score !== null) source = "evidence_semantic";
  }
  if (input.scope === "workspace_memory" || input.scope === "global") {
    const effective = normalizeObservedScore(input.effectiveEmbedding);
    if (effective !== null && (score === null || effective > score)) {
      score = effective;
      source = "effective_factor";
    }
  }
  if (input.scope === "workspace_memory") {
    const object = normalizeObservedScore(input.objectEmbedding);
    if (object !== null && (score === null || object > score)) {
      score = object;
      source = "object_embedding";
    }
  }
  return score === null || source === null
    ? INACTIVE_ACTIVATION
    : Object.freeze({ score, source });
}

function normalizeObservedScore(value: number | undefined): number | null {
  return value === undefined || !Number.isFinite(value) || value < 0
    ? null
    : clamp01(value);
}
