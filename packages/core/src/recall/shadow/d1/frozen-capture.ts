import { freezeLexicalBoundProof, type LexicalBoundProof } from
  "../../runtime/diagnostics/lexical-bound-proof.js";
import {
  parseSetUtilityInput,
  type ShadowSetUtilityInput
} from "../capture.js";
import {
  assertAllowedKeys,
  freezeShadow,
  isShadowRecord,
  requireShadowRecord,
  ShadowContractError
} from "../envelope.js";
import {
  parsePointwiseObservation,
  SHADOW_LINEAGE_IDS,
  type ShadowLineageId
} from "../observations.js";
import type {
  ShadowPsiCandidateView,
  ShadowPsiHGate,
  ShadowPsiLineages,
  ShadowPsiObservationField
} from "../psi.js";
import { psiOutcome } from "../psi.js";
import { d1PsiOutcome } from "./interval-psi.js";
import {
  replayD1CaptureWalk,
  type D1ReplayResult
} from "./replay.js";

export const D1_NONBINDING_TOKEN_BUDGET = 1_000_000_000;

const H_GATES: ReadonlySet<string> = new Set(["none", "event", "temporal", "hidden"]);

export type D1FrozenCaptureInput = Readonly<{
  readonly observations_by_candidate_key: unknown;
  readonly set_utilities: unknown;
  readonly lexical_bound_proofs: unknown;
  readonly gold_keys?: readonly string[];
}>;

export type D1FrozenCandidatePair = Readonly<{
  readonly left_candidate_key: string;
  readonly right_candidate_key: string;
}>;

export type D1FrozenCandidatePairBlocking = Readonly<{
  readonly production_blocked: boolean;
  readonly d1_blocked: boolean;
}>;

export type D1FrozenCandidatePairInput = Readonly<{
  readonly observations_by_candidate_key: unknown;
  readonly lexical_bound_proofs: unknown;
  readonly candidate_pairs: readonly D1FrozenCandidatePair[];
}>;

export function replayD1FrozenCapture(input: D1FrozenCaptureInput): D1ReplayResult {
  const observations = parseObservationField(input.observations_by_candidate_key);
  const utilities = parseUtilityMap(input.set_utilities);
  return replayD1CaptureWalk({
    observations,
    applicableChannels: applicableChannelsOf(observations),
    proofs: parseBoundProofs(input.lexical_bound_proofs),
    utilities,
    gold_keys: input.gold_keys,
    token_budget: D1_NONBINDING_TOKEN_BUDGET,
    per_dimension_limits: null
  });
}

export function compareD1FrozenCandidatePairs(
  input: D1FrozenCandidatePairInput
): readonly D1FrozenCandidatePairBlocking[] {
  const observations = parseObservationField(input.observations_by_candidate_key);
  const channels = applicableChannelsOf(observations);
  const proofs = parseBoundProofs(input.lexical_bound_proofs);
  return Object.freeze(input.candidate_pairs.map((pair) => {
    const production = psiOutcome(
      pair.left_candidate_key,
      pair.right_candidate_key,
      observations,
      channels
    );
    const d1 = d1PsiOutcome(
      pair.left_candidate_key,
      pair.right_candidate_key,
      observations,
      channels,
      proofs
    );
    if (production.kind === "not_a_dominance_compare" ||
        d1.kind === "not_a_dominance_compare") {
      throw new ShadowContractError("candidate pair is outside H");
    }
    return Object.freeze({
      production_blocked: production.kind === "blocked",
      d1_blocked: d1.kind === "blocked"
    });
  }));
}

export function applicableChannelsOf(
  observations: ShadowPsiObservationField
): readonly ShadowLineageId[] {
  const present = new Set<ShadowLineageId>();
  for (const view of Object.values(observations)) {
    for (const lineage of SHADOW_LINEAGE_IDS) {
      if (view?.lineages[lineage] !== undefined) present.add(lineage);
    }
  }
  return SHADOW_LINEAGE_IDS.filter((lineage) => present.has(lineage));
}

function parseObservationField(input: unknown): ShadowPsiObservationField {
  const record = requireShadowRecord(input, "observations_by_candidate_key");
  const field: Record<string, ShadowPsiCandidateView> = {};
  for (const [key, view] of Object.entries(record)) {
    if (key.length === 0) {
      throw new ShadowContractError("candidate key must be nonempty");
    }
    field[key] = parseCandidateView(view);
  }
  return freezeShadow(field);
}

function parseCandidateView(input: unknown): ShadowPsiCandidateView {
  const record = requireShadowRecord(input, "observation view");
  assertAllowedKeys(record, ["h_gate", "lineages"]);
  if (typeof record.h_gate !== "string" || !H_GATES.has(record.h_gate)) {
    throw new ShadowContractError("invalid h_gate");
  }
  return freezeShadow({
    h_gate: record.h_gate as ShadowPsiHGate,
    lineages: parseLineages(record.lineages)
  });
}

function parseLineages(input: unknown): ShadowPsiLineages {
  const record = requireShadowRecord(input, "lineages");
  const lineages: Record<string, ShadowPsiLineages[ShadowLineageId]> = {};
  for (const [name, value] of Object.entries(record)) {
    if (value === undefined) continue;
    if (!(SHADOW_LINEAGE_IDS as readonly string[]).includes(name)) {
      throw new ShadowContractError("unknown observation lineage");
    }
    lineages[name] = parsePointwiseObservation(value);
  }
  return freezeShadow(lineages) as ShadowPsiLineages;
}

function parseUtilityMap(
  input: unknown
): Readonly<Record<string, ShadowSetUtilityInput>> {
  const utilities: Record<string, ShadowSetUtilityInput> = {};
  for (const row of utilityRows(input)) {
    const parsed = parseSetUtilityInput(row);
    if (utilities[parsed.candidate_key] !== undefined) {
      throw new ShadowContractError("duplicate set-utility candidate_key");
    }
    utilities[parsed.candidate_key] = parsed;
  }
  return freezeShadow(utilities);
}

function utilityRows(input: unknown): readonly unknown[] {
  if (Array.isArray(input)) return input;
  if (isShadowRecord(input)) return Object.values(input);
  throw new ShadowContractError("set-utilities must be an array or object");
}

function parseBoundProofs(input: unknown): readonly LexicalBoundProof[] {
  if (!Array.isArray(input) || input.length === 0) {
    throw new ShadowContractError("lexical bound proofs are required");
  }
  return Object.freeze(input.map((row) => {
    const proof = freezeLexicalBoundProof(row);
    if (proof === undefined) {
      throw new ShadowContractError("lexical bound proof is invalid");
    }
    return proof;
  }));
}
