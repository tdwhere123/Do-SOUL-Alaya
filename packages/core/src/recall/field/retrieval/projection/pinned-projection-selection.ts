import {
  classifyFieldValidTime,
  normalizeMemoryObjectKeySurface,
  type AttributedActivationReceipt,
  type FieldContractSha256,
  type FieldStopCertificateReceipt,
  type QueryConditionReceipt
} from "@do-soul/alaya-protocol";

import { tokenizeWithSpans } from "../../../../memory/object-keys/normalize/tokenize.js";
import {
  computeAttributedKeyActivationV1,
  type AttributedKeyActivationReceiptV1
} from "../../../flood/attributed-key-activation.js";
import { runAttributedActivation } from "../../../flood/activation/attributed-activation.js";
import type {
  ActivationEdge,
  ActivationNode
} from "../../../flood/activation/activation-graph.js";
import {
  createSelectedSliceKeyV2,
  type SelectedSliceKeyV2
} from "../../../flood/slice-key-contract.js";
import { openProjectionBundlesProgressively } from "./progressive-opening.js";
import type { ProjectionGenerationArtifacts } from "./generation-artifacts.js";
import type { SourceProjectionSliceKey } from "./source-projection.js";

const PROPOSED_ROUTING_RELIABILITY_CEILING = 0.5;

export type PinnedProjectionCandidateSelection = Readonly<{
  readonly candidate_keys: readonly string[];
  readonly candidate_activation: Readonly<Record<string, number>>;
  readonly candidate_receipts: Readonly<
    Record<string, readonly Readonly<AttributedKeyActivationReceiptV1>[]>
  >;
  readonly activation: AttributedActivationReceipt;
  readonly stop: FieldStopCertificateReceipt;
}>;

type QueryFactorKey = Readonly<{
  readonly factor: string;
  readonly node_id: string;
  readonly key: SelectedSliceKeyV2;
}>;

type CandidateMatch = Readonly<{
  readonly candidate_key: string;
  readonly keys: readonly SourceProjectionSliceKey[];
  readonly receipts: readonly Readonly<AttributedKeyActivationReceiptV1>[];
}>;

export function selectPinnedProjectionCandidates(input: Readonly<{
  readonly condition: QueryConditionReceipt;
  readonly artifacts: ProjectionGenerationArtifacts;
  readonly sha256: FieldContractSha256;
}>): PinnedProjectionCandidateSelection {
  assertPinnedArtifacts(input.condition, input.artifacts);
  const queryKeys = createQueryFactorKeys(input.condition);
  const matches = matchCandidates(
    queryKeys,
    input.artifacts.slice_keys,
    input.condition.condition.effective_as_of
  );
  const trace = runAttributedActivation(input.condition, {
    sha256: input.sha256,
    graph: activationGraph(input.condition, queryKeys, matches)
  });
  const candidateIds = new Set(matches.map((match) => match.candidate_key));
  const candidateKeys = trace.receipt.opened_candidate_keys.filter((key) =>
    candidateIds.has(key)
  );
  const scores = scoreActivatedCandidates(trace, queryKeys.length, candidateIds);
  const opened = certifyBundleFrontier(input, candidateKeys, trace.budget.remaining);
  return Object.freeze({
    candidate_keys: Object.freeze(candidateKeys),
    candidate_activation: freezeRecord(scores),
    candidate_receipts: freezeReceipts(matches, candidateKeys),
    activation: trace.receipt,
    stop: opened.stop
  });
}

function createQueryFactorKeys(
  condition: QueryConditionReceipt
): readonly QueryFactorKey[] {
  const byKey = new Map<string, QueryFactorKey>();
  for (const factor of condition.condition.query_task_factors) {
    for (const value of factorTerms(factor)) {
      const key = createSelectedSliceKeyV2({
        workspace_id: condition.condition.workspace_id,
        owner_id: null,
        dimension: "semantic",
        value,
        authority: "derived_query",
        reliability: 1,
        independence_group: condition.identity,
        provenance: { kind: "query_probe", source_ref: condition.identity },
        source_version: condition.query_operator_id,
        freshness: {
          state: "fresh",
          as_of_ms: Date.parse(condition.condition.effective_as_of)
        }
      });
      byKey.set(key.key_id, Object.freeze({
        factor,
        node_id: `query-factor:${key.key_id}`,
        key
      }));
    }
  }
  return Object.freeze([...byKey.values()].sort((left, right) =>
    compareText(left.key.key_id, right.key.key_id)
  ));
}

function factorTerms(factor: string): readonly string[] {
  const normalized = normalizeMemoryObjectKeySurface(factor);
  const values = [
    ...(normalized.length === 0 ? [] : [normalized]),
    ...tokenizeWithSpans(factor).map((token) => token.token)
  ];
  return Object.freeze([...new Set(values)]);
}

function matchCandidates(
  queryKeys: readonly QueryFactorKey[],
  candidateKeys: readonly SelectedSliceKeyV2[],
  effectiveAsOf: string
): readonly CandidateMatch[] {
  const candidates = groupEligibleCandidateKeys(candidateKeys, effectiveAsOf);
  return Object.freeze([...candidates.entries()].flatMap(([candidateKey, keys]) => {
    const activation = computeAttributedKeyActivationV1(
      queryKeys.map((query) => query.key),
      keys.map(routingKey)
    );
    return activation.receipts.length === 0 ? [] : [Object.freeze({
      candidate_key: candidateKey,
      keys,
      receipts: activation.receipts
    })];
  }).sort((left, right) => compareText(left.candidate_key, right.candidate_key)));
}

function groupEligibleCandidateKeys(
  keys: readonly SelectedSliceKeyV2[],
  effectiveAsOf: string
): ReadonlyMap<string, readonly SourceProjectionSliceKey[]> {
  const grouped = new Map<string, SourceProjectionSliceKey[]>();
  for (const key of keys) {
    if (!isUsableSourceProjectionKey(key, effectiveAsOf)) continue;
    const values = grouped.get(key.owner_id) ?? [];
    values.push(key);
    grouped.set(key.owner_id, values);
  }
  return new Map([...grouped.entries()].filter(([, values]) =>
    values.some((key) => key.authority === "grounded" && key.reliability !== null)
  ));
}

function isUsableSourceProjectionKey(
  key: SelectedSliceKeyV2,
  effectiveAsOf: string
): key is SourceProjectionSliceKey & { readonly owner_id: string } {
  if (key.owner_id === null || key.freshness.state !== "fresh" ||
      !hasSourceProjectionState(key)) return false;
  const state = key.source_state;
  const evidence = evidenceStateAt(state, effectiveAsOf);
  const governance = governanceAt(state, effectiveAsOf);
  return evidence.lifecycle === "active" &&
    evidence.governance === "ordinary_evidence" &&
    !governance.sealed && !governance.erased && !governance.revoked &&
    classifyFieldValidTime(state, effectiveAsOf) !== "inactive";
}

function evidenceStateAt(
  state: SourceProjectionSliceKey["source_state"],
  effectiveAsOf: string
): Readonly<{ lifecycle: "active" | "inactive"; governance: "ordinary_evidence" | "restricted" }> {
  let lifecycle = state.lifecycle_state;
  let governance = state.governance_state;
  for (const transition of state.evidence_transitions ?? []) {
    if (transition.effective_as_of > effectiveAsOf) continue;
    if (transition.kind === "lifecycle") {
      lifecycle = transition.to_state === "active" ? "active" : "inactive";
    } else {
      governance = transition.to_state === "verified" ? "ordinary_evidence" : "restricted";
    }
  }
  return Object.freeze({ lifecycle, governance });
}

function routingKey(key: SourceProjectionSliceKey): SelectedSliceKeyV2 {
  if (key.authority !== "proposed_routing_only" || key.reliability !== null) return key;
  return Object.freeze({ ...key, reliability: PROPOSED_ROUTING_RELIABILITY_CEILING });
}

function activationGraph(
  condition: QueryConditionReceipt,
  queryKeys: readonly QueryFactorKey[],
  matches: readonly CandidateMatch[]
) {
  const queryById = new Map(queryKeys.map((query) => [query.key.key_id, query]));
  const nodes = [
    ...queryKeys.map((query) => queryNode(condition, query)),
    ...matches.map((match) => candidateNode(condition, match))
  ];
  const edges = matches.flatMap((match) => match.receipts.map((receipt) =>
    activationEdge(condition, queryById, match, receipt)
  ));
  const channels = [...new Set(edges.map((edge) => edge.channel))];
  return Object.freeze({
    nodes: Object.freeze(nodes),
    edges: Object.freeze(edges),
    rho_by_channel: Object.freeze(Object.fromEntries(
      channels.map((channel) => [channel, 0.95])
    ))
  });
}

function queryNode(
  condition: QueryConditionReceipt,
  query: QueryFactorKey
): ActivationNode {
  return Object.freeze({
    ...baseNode(condition, query.node_id),
    valid_from: condition.condition.effective_as_of,
    task_factor_id: query.factor
  });
}

function candidateNode(
  condition: QueryConditionReceipt,
  match: CandidateMatch
): ActivationNode {
  const key = nodeStateKey(match);
  const state = key.source_state;
  const governance = governanceAt(state, condition.condition.effective_as_of);
  return Object.freeze({
    candidate_key: match.candidate_key,
    workspace_id: key.workspace_id,
    principal: condition.condition.principal,
    scope: state.scope,
    generation_id: condition.generation_id,
    valid_from: state.valid_from,
    valid_to: state.valid_to,
    adopted_bridge: null,
    sealed: governance.sealed,
    erased: governance.erased,
    revoked: governance.revoked,
    authorized_anchor: false,
    task_factor_id: null
  });
}

function nodeStateKey(match: CandidateMatch): SourceProjectionSliceKey {
  const receiptIds = new Set(match.receipts.map((receipt) => receipt.candidate_key_id));
  const matched = match.keys.filter((key) => receiptIds.has(key.key_id));
  const key = matched.find((candidate) => candidate.authority === "grounded") ?? matched[0];
  if (key === undefined) throw new Error("candidate activation has no source state");
  return key;
}

function baseNode(condition: QueryConditionReceipt, candidateKey: string) {
  return {
    candidate_key: candidateKey,
    workspace_id: condition.condition.workspace_id,
    principal: condition.condition.principal,
    scope: condition.condition.workspace_id,
    generation_id: condition.generation_id,
    valid_to: null,
    adopted_bridge: null,
    sealed: false,
    erased: false,
    revoked: false,
    authorized_anchor: false
  } as const;
}

function hasSourceProjectionState(
  key: SelectedSliceKeyV2
): key is SourceProjectionSliceKey {
  const value = key as SelectedSliceKeyV2 & { readonly source_state?: unknown };
  if (typeof value.source_state !== "object" || value.source_state === null) return false;
  const state = value.source_state as Partial<SourceProjectionSliceKey["source_state"]>;
  return typeof state.scope === "string" && state.scope.length > 0 &&
    (state.event_time === null || typeof state.event_time === "string") &&
    (state.valid_from === null || typeof state.valid_from === "string") &&
    (state.valid_to === null || typeof state.valid_to === "string") &&
    (state.lifecycle_state === "active" || state.lifecycle_state === "inactive") &&
    (state.governance_state === "ordinary_evidence" ||
      state.governance_state === "restricted") &&
    typeof state.sealed === "boolean" && typeof state.erased === "boolean" &&
    typeof state.revoked === "boolean" && Array.isArray(state.governance_effects) &&
    (state.evidence_transitions === undefined || Array.isArray(state.evidence_transitions));
}

function governanceAt(
  state: SourceProjectionSliceKey["source_state"],
  effectiveAsOf: string
): Readonly<{ sealed: boolean; erased: boolean; revoked: boolean }> {
  let sealed = state.sealed;
  let erased = state.erased;
  let revoked = state.revoked;
  for (const effect of state.governance_effects) {
    if (effect.effective_as_of > effectiveAsOf) continue;
    if (effect.action === "erase") erased = true;
    if (effect.action === "seal") sealed = true;
    if (effect.action === "revoke") revoked = true;
    if (effect.action === "activate" && !erased) {
      sealed = false;
      revoked = false;
    }
  }
  return Object.freeze({ sealed, erased, revoked });
}

function activationEdge(
  condition: QueryConditionReceipt,
  queryById: ReadonlyMap<string, QueryFactorKey>,
  match: CandidateMatch,
  receipt: Readonly<AttributedKeyActivationReceiptV1>
): ActivationEdge {
  const query = queryById.get(receipt.query_key_id);
  const candidate = match.keys.find((key) => key.key_id === receipt.candidate_key_id);
  if (query === undefined || candidate === undefined) {
    throw new Error("activation receipt references an unavailable projection key");
  }
  return Object.freeze({
    from: query.node_id,
    to: match.candidate_key,
    channel: `factor:${receipt.dimension}`,
    lambda: Math.min(0.95, receipt.support * 0.95),
    hop_cost: 0,
    source: candidate.provenance.source_ref,
    generation_id: condition.generation_id
  });
}

function scoreActivatedCandidates(
  trace: ReturnType<typeof runAttributedActivation>,
  queryFactorCount: number,
  candidates: ReadonlySet<string>
): Record<string, number> {
  const paths = new Map<string, { max: number; seeds: Set<string> }>();
  for (const path of trace.paths) {
    if (!candidates.has(path.to)) continue;
    const current = paths.get(path.to) ?? { max: 0, seeds: new Set<string>() };
    current.max = Math.max(current.max, path.energy);
    current.seeds.add(path.from);
    paths.set(path.to, current);
  }
  return Object.fromEntries([...paths.entries()].map(([candidate, value]) => {
    const coverage = queryFactorCount === 0 ? 0 : value.seeds.size / queryFactorCount;
    return [candidate, value.max * (0.5 + (0.5 * coverage))];
  }));
}

function certifyBundleFrontier(
  input: Parameters<typeof selectPinnedProjectionCandidates>[0],
  candidateKeys: readonly string[],
  activationBudgetRemaining: number
) {
  const terms = new Set(createQueryFactorKeys(input.condition).map(
    (query) => query.key.normalized_value
  ));
  const matching = input.artifacts.bundles.filter((bundle) =>
    bundle.factor_summary.some((factor) => terms.has(factor.value))
  );
  return openProjectionBundlesProgressively({
    workspace_id: input.condition.condition.workspace_id,
    generation_id: input.condition.generation_id,
    condition_digest: input.condition.identity,
    recorded_at: input.condition.recorded_at,
    sha256: input.sha256,
    selected_candidate_keys: candidateKeys,
    activationBudget: activationBudgetRemaining,
    frontiers: matching.map((bundle) => ({
      bundle_id: bundle.bundle_id,
      unseen_gain_upper_bound: bundle.unseen_frontier_upper_bound,
      incumbent_loss: 0,
      opened: bundle.opened
    }))
  });
}

function freezeRecord(values: Record<string, number>): Readonly<Record<string, number>> {
  return Object.freeze(Object.fromEntries(Object.entries(values).sort(([left], [right]) =>
    compareText(left, right)
  )));
}

function freezeReceipts(
  matches: readonly CandidateMatch[],
  candidateKeys: readonly string[]
): Readonly<Record<string, readonly Readonly<AttributedKeyActivationReceiptV1>[]>> {
  const selected = new Set(candidateKeys);
  return Object.freeze(Object.fromEntries(matches.flatMap((match) =>
    selected.has(match.candidate_key)
      ? [[match.candidate_key, Object.freeze([...match.receipts])]]
      : []
  )));
}

function assertPinnedArtifacts(
  condition: QueryConditionReceipt,
  artifacts: ProjectionGenerationArtifacts
): void {
  if (condition.generation_id !== artifacts.generation_id) {
    throw new Error("projection artifacts do not match the query pin");
  }
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
