import { digestRecallFieldIdentity, type RecallFieldDigest } from
  "../../../field/field-identity.js";
import { compareText } from "../../../../shared/compare-text.js";
import {
  isCapturedWalk,
  readCapturedWalkRuntimeManifest,
  type ShadowCapturedWalk
} from "../../prefix-capture/walk.js";
import {
  captureData,
  captureVerifiedLiveClosureAuthority
} from "../closure/live-authority-binding.js";
import { compileQueryGamma } from "../gamma/compile.js";
import type { QueryGammaCandidateEvidenceV1 } from "../gamma/contract.js";
import type { LiveQueryProofAuthority } from "../live-query-proof-authority.js";
import type { FiniteValue } from "../proof/oracle/contract.js";
import type { QueryProofDecideWorldV1 } from "./decide.js";

export type QueryProofDecidePremisesV1 = Readonly<{
  readonly candidates: QueryProofDecideWorldV1["candidates"];
  readonly psi_edges: QueryProofDecideWorldV1["psi_edges"];
  readonly token_budget: number;
  readonly per_dimension_limits: QueryProofDecideWorldV1["per_dimension_limits"];
  readonly unresolved_tradeoff_pairs:
    QueryProofDecideWorldV1["unresolved_tradeoff_pairs"];
  readonly answer_bindings: QueryProofDecideWorldV1["answer_bindings"];
}>;

export type QueryProofDecideWorldCaptureV1 = Readonly<{
  readonly authority_digest: RecallFieldDigest;
  readonly query_digest: RecallFieldDigest;
  readonly request_digest: RecallFieldDigest;
  readonly snapshot_digest: RecallFieldDigest;
  readonly principal_digest: RecallFieldDigest;
  readonly workspace_id: string;
  readonly candidate_identity_by_digest: Readonly<Record<string, string>>;
  readonly candidate_universe_digest: RecallFieldDigest;
  readonly resource_policy_digest: RecallFieldDigest;
  readonly world_digest: RecallFieldDigest;
  readonly decision_identity_digest: RecallFieldDigest;
}>;

export type QueryProofDecideRuntimeCaptureV1 = Readonly<{
  readonly manifest_digest: RecallFieldDigest;
}>;

export type QueryProofDecideRuntimeManifestV1 = Readonly<{
  readonly walk: ShadowCapturedWalk;
}>;

const capturedDecideWorlds = new WeakMap<object, QueryProofDecideWorldCaptureV1>();
const runtimeCapturedDecideWorlds =
  new WeakMap<object, QueryProofDecideRuntimeCaptureV1>();

export function captureQueryProofDecideWorld(params: Readonly<{
  readonly live_authority: LiveQueryProofAuthority;
  readonly premises: QueryProofDecidePremisesV1;
}>): QueryProofDecideWorldV1 {
  const live = captureVerifiedLiveClosureAuthority(params.live_authority);
  const premises = captureData(params.premises);
  assertSourceBoundEmptyFinitePremises(premises);
  const compileInput = Object.freeze({
    compilation: live.authority.canonical_query_compilation,
    candidates: Object.freeze([] as QueryGammaCandidateEvidenceV1[]),
    resource_policy: Object.freeze({
      schema_version: 1 as const,
      reject_duplicate_object: true as const,
      token_budget: premises.token_budget,
      per_dimension_limits: premises.per_dimension_limits
    })
  });
  const compiled = compileQueryGamma(compileInput);
  if (compiled.compile_status !== "compiled") {
    throw new Error(`Decide_Q premises cannot compile Gamma: ${compiled.unsupported_reason}`);
  }
  assertCandidatePremises(premises.candidates, compileInput.candidates);
  assertAnswerBindingPremises(premises.answer_bindings, compileInput.candidates);
  const world = captureData({
    compiled,
    compile_input: compileInput,
    candidates: premises.candidates,
    psi_edges: premises.psi_edges,
    token_budget: premises.token_budget,
    per_dimension_limits: premises.per_dimension_limits,
    unresolved_tradeoff_pairs: premises.unresolved_tradeoff_pairs,
    answer_bindings: premises.answer_bindings
  }) as QueryProofDecideWorldV1;
  const candidateIdentityByDigest = candidateIdentityMapForWorld(world);
  const candidateUniverseDigest = digestRecallFieldIdentity(candidateIdentityByDigest);
  const resourcePolicyDigest = digestRecallFieldIdentity(compiled.resource_policy);
  const worldDigest = digestDecideWorld(world);
  return issueCapturedWorld(world, Object.freeze({
    authority_digest: live.binding.authority_digest,
    query_digest: live.binding.query_digest,
    request_digest: live.binding.request_digest,
    snapshot_digest: live.binding.snapshot_digest,
    principal_digest: live.binding.principal_digest,
    workspace_id: live.binding.workspace_id,
    candidate_identity_by_digest: candidateIdentityByDigest,
    candidate_universe_digest: candidateUniverseDigest,
    resource_policy_digest: resourcePolicyDigest,
    world_digest: worldDigest,
    decision_identity_digest: digestRecallFieldIdentity(Object.freeze({
      kind: "captured_query_proof_decide_world_v1",
      authority_digest: live.binding.authority_digest,
      query_digest: live.binding.query_digest,
      request_digest: live.binding.request_digest,
      snapshot_digest: live.binding.snapshot_digest,
      principal_digest: live.binding.principal_digest,
      workspace_id: live.binding.workspace_id,
      candidate_universe_digest: candidateUniverseDigest,
      resource_policy_digest: resourcePolicyDigest,
      world_digest: worldDigest,
      gamma_digest: compiled.gamma_digest,
      standings_digest: digestRecallFieldIdentity(compiled.standings),
      semantic_feasibility_digest:
        digestRecallFieldIdentity(compiled.semantic_feasibility)
    }))
  }));
}

function assertSourceBoundEmptyFinitePremises(
  premises: QueryProofDecidePremisesV1
): void {
  if (premises.candidates.length !== 0 || premises.answer_bindings.length !== 0 ||
      premises.psi_edges.length !== 0 || premises.unresolved_tradeoff_pairs.length !== 0) {
    throw new Error(
      "verified Decide_Q capture requires source-bound Gamma evidence for a non-empty world"
    );
  }
}

export function decideWorldCapture(
  world: QueryProofDecideWorldV1
): QueryProofDecideWorldCaptureV1 | null {
  return capturedDecideWorlds.get(world) ?? null;
}

export function captureQueryProofDecideRuntime(
  world: QueryProofDecideWorldV1,
  runtime: QueryProofDecideRuntimeManifestV1
): QueryProofDecideWorldV1 {
  if (decideWorldCapture(world) === null) {
    throw new Error("runtime capture cannot bind an unverified Decide_Q world");
  }
  if (!isCapturedWalk(runtime.walk)) {
    throw new Error("Decide_Q runtime capture requires the issued live walk");
  }
  const manifestDigest = verifyRuntimeManifest(world, runtime);
  const current = runtimeCapturedDecideWorlds.get(world);
  if (current !== undefined && current.manifest_digest !== manifestDigest) {
    throw new Error("Decide_Q world is already bound to another runtime capture");
  }
  runtimeCapturedDecideWorlds.set(world, Object.freeze({
    manifest_digest: manifestDigest
  }));
  return world;
}

export function decideWorldRuntimeCapture(
  world: QueryProofDecideWorldV1
): QueryProofDecideRuntimeCaptureV1 | null {
  return runtimeCapturedDecideWorlds.get(world) ?? null;
}

export function queryProofDecideBaseState(world: QueryProofDecideWorldV1): FiniteValue {
  const capture = decideWorldCapture(world);
  if (capture === null) {
    throw new Error("Decide_Q base state requires a live-authority captured world");
  }
  const runtime = decideWorldRuntimeCapture(world);
  if (runtime === null) {
    throw new Error("Decide_Q base state requires an exact runtime capture");
  }
  return Object.freeze({
    authority_digest: capture.authority_digest,
    query_digest: capture.query_digest,
    request_digest: capture.request_digest,
    snapshot_digest: capture.snapshot_digest,
    principal_digest: capture.principal_digest,
    workspace_id: capture.workspace_id,
    candidate_universe_digest: capture.candidate_universe_digest,
    resource_policy_digest: capture.resource_policy_digest,
    world_digest: capture.world_digest,
    decision_identity_digest: capture.decision_identity_digest,
    runtime_capture_digest: runtime.manifest_digest
  });
}

export function freezeDecideWorld(
  world: QueryProofDecideWorldV1
): QueryProofDecideWorldV1 {
  if (capturedDecideWorlds.has(world)) return world;
  return captureData(world);
}

export function digestDecideWorld(world: QueryProofDecideWorldV1): RecallFieldDigest {
  const frozen = captureData(world);
  return digestRecallFieldIdentity({
    kind: "query_proof_decide_world_v1",
    gamma_digest: frozen.compiled.gamma_digest,
    compilation_digest: frozen.compiled.compilation_digest,
    query_digest: frozen.compiled.query_digest,
    candidates: frozen.candidates.map((row) => Object.freeze({
      candidate_key: row.candidate_key,
      object_key: row.object_key,
      token_cost: row.token_cost,
      dimension: row.dimension,
      h_eligible: row.h_eligible,
      static_frontier_index: row.static_frontier_index
    })),
    psi_edges: frozen.psi_edges,
    token_budget: frozen.token_budget,
    per_dimension_limits: frozen.per_dimension_limits,
    unresolved_tradeoff_pairs: frozen.unresolved_tradeoff_pairs,
    answer_bindings: frozen.answer_bindings,
    standings_digest: digestRecallFieldIdentity(frozen.compiled.standings),
    feasibility_digest: digestRecallFieldIdentity(frozen.compiled.semantic_feasibility),
    compile_input_digest: digestRecallFieldIdentity(frozen.compile_input)
  });
}

export function issueDerivedQueryProofDecideWorld(
  world: QueryProofDecideWorldV1,
  source: QueryProofDecideWorldV1,
  base: QueryProofDecideWorldCaptureV1
): QueryProofDecideWorldV1 {
  const worldDigest = digestDecideWorld(world);
  const issued = issueCapturedWorld(world, Object.freeze({
    ...base,
    world_digest: worldDigest,
    resource_policy_digest: digestRecallFieldIdentity(world.compiled.resource_policy),
    decision_identity_digest: digestRecallFieldIdentity({
      kind: "captured_query_proof_decide_world_refinement_v1",
      base_decision_identity_digest: base.decision_identity_digest,
      world_digest: worldDigest,
      gamma_digest: world.compiled.gamma_digest,
      standings_digest: digestRecallFieldIdentity(world.compiled.standings),
      semantic_feasibility_digest: digestRecallFieldIdentity(
        world.compiled.semantic_feasibility
      )
    })
  }));
  const runtime = decideWorldRuntimeCapture(source);
  if (runtime !== null) runtimeCapturedDecideWorlds.set(issued, runtime);
  return issued;
}

export function candidateIdentityMapForWorld(
  world: QueryProofDecideWorldV1
): Readonly<Record<string, string>> {
  const entries = world.candidates.map((candidate) => [
    digestRecallFieldIdentity({
      candidate_key: candidate.candidate_key,
      object_key: candidate.object_key
    }),
    candidate.candidate_key
  ] as const);
  if (new Set(entries.map(([digest]) => digest)).size !== entries.length ||
      new Set(entries.map(([, key]) => key)).size !== entries.length) {
    throw new Error("Decide_Q candidate identity digest is not injective");
  }
  return Object.freeze(Object.fromEntries(entries));
}

function issueCapturedWorld(
  world: QueryProofDecideWorldV1,
  capture: QueryProofDecideWorldCaptureV1
): QueryProofDecideWorldV1 {
  capturedDecideWorlds.set(world, capture);
  return world;
}

function assertCandidatePremises(
  walk: QueryProofDecideWorldV1["candidates"],
  evidence: readonly QueryGammaCandidateEvidenceV1[]
): void {
  const evidenceByKey = new Map(evidence.map((row) => [row.candidate_key, row]));
  if (evidenceByKey.size !== evidence.length || walk.length !== evidence.length) {
    throw new Error("Decide_Q candidate premises are not injective");
  }
  for (const candidate of walk) {
    const row = evidenceByKey.get(candidate.candidate_key);
    if (row === undefined || row.object_key !== candidate.object_key ||
        row.token_cost !== candidate.token_cost || row.dimension !== candidate.dimension) {
      throw new Error("Decide_Q walk candidate is outside Gamma evidence authority");
    }
  }
}

function assertAnswerBindingPremises(
  bindings: QueryProofDecideWorldV1["answer_bindings"],
  evidence: readonly QueryGammaCandidateEvidenceV1[]
): void {
  const ids = new Set<string>();
  for (const binding of bindings) {
    const identity = `${binding.candidate_key}\0${binding.binding_id}`;
    if (ids.has(identity)) {
      throw new Error("Decide_Q answer binding identity is not injective");
    }
    ids.add(identity);
    if (binding.value !== binding.semantic_identity) {
      throw new Error("Decide_Q answer binding value is not its semantic identity");
    }
    const owner = evidence.find((row) => row.candidate_key === binding.candidate_key);
    const matches = owner?.bindings.filter((row) =>
      row.variable === binding.variable &&
      row.semantic_identity === binding.semantic_identity) ?? [];
    if (matches.length !== 1) {
      throw new Error("Decide_Q answer binding is outside Gamma evidence authority");
    }
  }
}

function verifyRuntimeManifest(
  world: QueryProofDecideWorldV1,
  runtime: QueryProofDecideRuntimeManifestV1
): RecallFieldDigest {
  const issued = readCapturedWalkRuntimeManifest(runtime.walk);
  if (issued === null) throw new Error("Decide_Q runtime capture requires the issued live walk");
  const worldCandidates = candidateManifest(world.candidates);
  const runtimeCandidates = candidateManifest(issued.candidates);
  const evidenceKeys = [...world.compile_input.candidates.map((row) => row.candidate_key)]
    .sort(compareText);
  const runtimeKeys = [...issued.candidates.map((row) => row.candidate_key)]
    .sort(compareText);
  if (digestRecallFieldIdentity(worldCandidates) !== digestRecallFieldIdentity(runtimeCandidates) ||
      digestRecallFieldIdentity(evidenceKeys) !== digestRecallFieldIdentity(runtimeKeys) ||
      world.token_budget !== issued.token_budget ||
      digestRecallFieldIdentity(world.per_dimension_limits) !==
        digestRecallFieldIdentity(issued.per_dimension_limits) ||
      digestRecallFieldIdentity(normalizedPairs(world.psi_edges, true)) !==
        digestRecallFieldIdentity(normalizedPairs(issued.psi_edges, true)) ||
      digestRecallFieldIdentity(normalizedPairs(world.unresolved_tradeoff_pairs, false)) !==
        digestRecallFieldIdentity(normalizedPairs(issued.unresolved_tradeoff_pairs, false))) {
    throw new Error("Decide_Q world does not match the exact live runtime capture");
  }
  return digestRecallFieldIdentity({
    kind: "query_proof_runtime_capture_v1",
    candidates: runtimeCandidates,
    psi_edges: normalizedPairs(issued.psi_edges, true),
    token_budget: issued.token_budget,
    per_dimension_limits: issued.per_dimension_limits,
    unresolved_tradeoff_pairs: normalizedPairs(issued.unresolved_tradeoff_pairs, false),
    live_walk_digest: digestRecallFieldIdentity(runtime.walk)
  });
}

function candidateManifest(
  candidates: readonly Omit<QueryProofDecideWorldV1["candidates"][number], "utility">[]
): readonly object[] {
  return Object.freeze(candidates.map((row) => Object.freeze({
    candidate_key: row.candidate_key,
    object_key: row.object_key,
    token_cost: row.token_cost,
    dimension: row.dimension,
    h_eligible: row.h_eligible,
    static_frontier_index: row.static_frontier_index
  })).sort((left, right) => compareText(left.candidate_key, right.candidate_key)));
}

function normalizedPairs(
  pairs: readonly (readonly [string, string])[],
  directed: boolean
): readonly (readonly [string, string])[] {
  return Object.freeze(pairs.map(([left, right]) => {
    if (directed || compareText(left, right) <= 0) return Object.freeze([left, right] as const);
    return Object.freeze([right, left] as const);
  }).sort((left, right) => compareText(`${left[0]}\0${left[1]}`, `${right[0]}\0${right[1]}`)));
}
