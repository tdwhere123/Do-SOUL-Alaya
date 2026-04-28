import type { ActivationCandidate, PathRelation } from "../structure/types.js";
import {
  buildExclusion,
  buildStructuredContribution,
  clampUnit,
  compareCandidates,
  createCandidate,
  evaluateRecordEligibility,
  listAnchorObjectRefs,
  normalizeLimit,
  recordMap,
  roundScore
} from "./shared.js";
import type {
  MergePathRecallContributionsInput,
  RecallCandidate,
  RecallExclusion,
  RecallMergeResult,
  RecallRouteContribution
} from "./types.js";

interface PathSignal {
  readonly object_id: string;
  readonly path_id: string;
  readonly score: number;
  readonly reason: string;
  readonly relation_kind: string | null;
  readonly activation_candidate_id: string | null;
}

export function mergePathRecallContributions(input: MergePathRecallContributionsInput): RecallMergeResult {
  const limit = normalizeLimit(input.query.limit);
  const existing = new Map(input.baseline.map((candidate) => [candidate.object_id, candidate] as const));
  const recordsById = recordMap(input.records);
  const merged = new Map<string, RecallCandidate>();
  const exclusions: RecallExclusion[] = [];
  const signalByObjectAndPath = new Map<string, PathSignal>();

  for (const candidate of input.baseline) {
    merged.set(candidate.object_id, candidate);
  }

  for (const relation of input.path_relations ?? []) {
    if (relation.workspace_id !== input.query.workspace_id || relation.lifecycle.state !== "active") {
      continue;
    }
    for (const signal of relationSignals(relation)) {
      addOrMergeSignal(signalByObjectAndPath, signal);
    }
  }

  for (const candidate of input.activation_candidates ?? []) {
    if (candidate.workspace_id !== input.query.workspace_id) {
      continue;
    }
    if (input.query.run_id !== undefined && input.query.run_id !== null && candidate.run_id !== input.query.run_id) {
      continue;
    }
    for (const signal of activationSignals(candidate)) {
      addOrMergeSignal(signalByObjectAndPath, signal);
    }
  }

  const signalsByObject = groupSignalsByObject(signalByObjectAndPath);
  for (const [objectId, signals] of Array.from(signalsByObject.entries()).sort(([left], [right]) => left.localeCompare(right))) {
    const existingCandidate = existing.get(objectId);
    if (existingCandidate !== undefined) {
      merged.set(objectId, withPathContribution(existingCandidate, signals));
      continue;
    }

    const record = recordsById.get(objectId);
    if (record === undefined) {
      continue;
    }

    const eligibility = evaluateRecordEligibility(record, input.query, "path");
    if (!eligibility.eligible) {
      exclusions.push(eligibility.exclusion);
      continue;
    }

    const pathContribution = buildPathContribution(signals);
    merged.set(objectId, createCandidate({
      memory: record.memory,
      inclusionReason: "structured_filters_passed_and_path_signal_matched",
      contributions: [buildStructuredContribution(record.memory), pathContribution]
    }));
  }

  const ordered = Array.from(merged.values()).sort(compareCandidates).slice(0, limit);
  const maxPathOnly = input.max_path_only;
  const capped =
    maxPathOnly === undefined
      ? ordered
      : capPathOnlyCandidates(ordered, input.baseline, maxPathOnly, exclusions);

  return {
    candidates: Object.freeze(capped),
    exclusions: Object.freeze(exclusions.sort((left, right) => left.object_id.localeCompare(right.object_id))),
    degradations: Object.freeze([])
  };
}

function relationSignals(relation: PathRelation): readonly PathSignal[] {
  const targets = targetObjectIdsForRelation(relation);
  return targets.map((objectId) => ({
    object_id: objectId,
    path_id: relation.path_id,
    score: roundScore(
      clampUnit(relation.effect_vector.recall_bias) * 0.45 +
        clampUnit(relation.effect_vector.salience) * 0.25 +
        clampUnit(relation.plasticity_state.strength) * 0.2
    ),
    reason: `${relation.constitution.relation_kind}: ${relation.constitution.why_this_relation_exists.join("; ")}`,
    relation_kind: relation.constitution.relation_kind,
    activation_candidate_id: null
  }));
}

function activationSignals(candidate: ActivationCandidate): readonly PathSignal[] {
  const targets = listAnchorObjectRefs(candidate.target_anchor);
  return targets.map((objectId) => ({
    object_id: objectId,
    path_id: candidate.source_path_id,
    score: roundScore(clampUnit(candidate.pressure) * clampUnit(candidate.confidence) * 0.4),
    reason: candidate.why_now,
    relation_kind: null,
    activation_candidate_id: candidate.candidate_id
  }));
}

function targetObjectIdsForRelation(relation: PathRelation): readonly string[] {
  const sourceRefs = listAnchorObjectRefs(relation.anchors.source_anchor);
  const targetRefs = listAnchorObjectRefs(relation.anchors.target_anchor);
  switch (relation.plasticity_state.direction_bias) {
    case "source_to_target":
      return targetRefs;
    case "target_to_source":
      return sourceRefs;
    case "bidirectional_asymmetric":
      return Object.freeze(Array.from(new Set([...sourceRefs, ...targetRefs])));
  }
}

function addOrMergeSignal(signals: Map<string, PathSignal>, signal: PathSignal): void {
  const key = `${signal.object_id}\u0000${signal.path_id}`;
  const previous = signals.get(key);
  if (previous === undefined) {
    signals.set(key, signal);
    return;
  }

  signals.set(key, {
    object_id: signal.object_id,
    path_id: signal.path_id,
    score: roundScore(previous.score + signal.score),
    reason: previous.relation_kind !== null ? previous.reason : signal.reason,
    relation_kind: previous.relation_kind ?? signal.relation_kind,
    activation_candidate_id: mergeActivationIds(previous.activation_candidate_id, signal.activation_candidate_id)
  });
}

function mergeActivationIds(left: string | null, right: string | null): string | null {
  if (left === null) {
    return right;
  }
  if (right === null || right === left) {
    return left;
  }
  return `${left},${right}`;
}

function groupSignalsByObject(signals: ReadonlyMap<string, PathSignal>): ReadonlyMap<string, readonly PathSignal[]> {
  const grouped = new Map<string, PathSignal[]>();
  for (const signal of signals.values()) {
    const entries = grouped.get(signal.object_id) ?? [];
    entries.push(signal);
    grouped.set(signal.object_id, entries);
  }
  return grouped;
}

function withPathContribution(candidate: RecallCandidate, signals: readonly PathSignal[]): RecallCandidate {
  const nextContributions = [
    ...candidate.contributions.filter((entry) => entry.route !== "path"),
    buildPathContribution(signals)
  ];
  return createCandidate({
    memory: candidate.memory,
    inclusionReason: `${candidate.inclusion_reason}; path_signal_matched`,
    contributions: nextContributions
  });
}

function buildPathContribution(signals: readonly PathSignal[]): RecallRouteContribution {
  const ordered = [...signals].sort((left, right) => {
    const scoreDelta = right.score - left.score;
    if (scoreDelta !== 0) {
      return scoreDelta;
    }
    return left.path_id.localeCompare(right.path_id);
  });
  const primary = ordered[0];
  if (primary === undefined) {
    return {
      route: "path",
      source_plane: "structure_registry",
      score: 0,
      reason: "path_signal_missing"
    };
  }
  const activationIds = ordered
    .map((signal) => signal.activation_candidate_id)
    .filter((value): value is string => value !== null)
    .flatMap((value) => value.split(","))
    .filter((value, index, values) => values.indexOf(value) === index)
    .sort();

  const contribution: {
    route: "path";
    source_plane: "structure_registry";
    score: number;
    reason: string;
    path_id: string;
    relation_kind?: string;
    activation_candidate_ids?: readonly string[];
  } = {
    route: "path",
    source_plane: "structure_registry",
    score: roundScore(ordered.reduce((sum, signal) => sum + signal.score, 0)),
    reason: primary.reason,
    path_id: primary.path_id
  };
  if (primary.relation_kind !== null) {
    contribution.relation_kind = primary.relation_kind;
  }
  if (activationIds.length > 0) {
    contribution.activation_candidate_ids = Object.freeze(activationIds);
  }
  return contribution;
}

function capPathOnlyCandidates(
  candidates: readonly RecallCandidate[],
  baseline: readonly RecallCandidate[],
  maxPathOnly: number,
  exclusions: RecallExclusion[]
): readonly RecallCandidate[] {
  const baselineIds = new Set(baseline.map((candidate) => candidate.object_id));
  let pathOnlyCount = 0;
  const retained: RecallCandidate[] = [];
  for (const candidate of candidates) {
    if (baselineIds.has(candidate.object_id)) {
      retained.push(candidate);
      continue;
    }
    if (pathOnlyCount < maxPathOnly) {
      pathOnlyCount += 1;
      retained.push(candidate);
      continue;
    }
    exclusions.push(buildExclusion(
      {
        memory: candidate.memory,
        governance_state: "visible"
      },
      "path",
      "path_budget_exhausted",
      true
    ));
  }
  return Object.freeze(retained);
}
