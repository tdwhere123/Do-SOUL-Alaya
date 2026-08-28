import {
  serializeRemainingEffect,
  unavailableProducerDigest
} from "./digest.js";
import { derivedSources } from "./sources.js";
import type {
  SnapshotCoherenceState,
  SnapshotVectorV1,
  SnapshotValidTimeDomainV1,
  SourceFrontierDeclarationV1
} from "./types.js";

export type SnapshotCoherenceClassification = Readonly<{
  readonly state: SnapshotCoherenceState;
  readonly reasons: readonly string[];
  readonly lag_bounds: readonly string[];
}>;

export function classifySnapshotCoherence(
  vector: SnapshotVectorV1
): SnapshotCoherenceClassification {
  const sources = derivedSources(vector);
  const active = sources.filter((source) => source.lag_bound.kind !== "not_applicable");
  const lag_bounds = Object.freeze(collectLagBounds(active));
  const undeclared = [...undeclaredReasons(vector)];
  if (active.some((source) => source.lag_bound.kind === "unavailable")) {
    undeclared.push("source_unavailable");
  }
  if (undeclared.length > 0) {
    return freezeClass("unavailable", undeclared, lag_bounds);
  }
  const torn = tornReasons(vector, active);
  if (torn.length > 0) return freezeClass("incoherent", torn, lag_bounds);
  if (lag_bounds.length > 0) {
    return freezeClass("coherent_bounded", ["declared_lag"], lag_bounds);
  }
  return freezeClass("coherent_exact", [], lag_bounds);
}

function undeclaredReasons(vector: SnapshotVectorV1): readonly string[] {
  const reasons: string[] = [];
  if (vector.retrieval_channel_snapshots.length === 0) {
    reasons.push("retrieval_undeclared");
  }
  if (vector.formation_operator_versions.length === 0) {
    reasons.push("formation_undeclared");
  }
  if (vector.base_store_digest === unavailableProducerDigest("base_store")) {
    reasons.push("base_store_unknown");
  }
  if (vector.decision_contract_digest === unavailableProducerDigest("decision_contract")) {
    reasons.push("decision_contract_unknown");
  }
  return Object.freeze(reasons);
}

function tornReasons(
  vector: SnapshotVectorV1,
  sources: readonly SourceFrontierDeclarationV1[]
): readonly string[] {
  const reasons: string[] = [];
  if (tornRetrievalEmbedding(vector)) reasons.push("torn_fts_embedding");
  if (tornGovernanceProjection(vector)) reasons.push("torn_governance_projection");
  if (sources.some((source) => exactTimeMismatch(source, vector.effective_as_of))) {
    reasons.push("valid_time_transaction_time_mismatch");
  }
  return Object.freeze(reasons);
}

function tornRetrievalEmbedding(vector: SnapshotVectorV1): boolean {
  const embedding = vector.embedding_generation_and_model;
  if (embedding.lag_bound.kind !== "exact") return false;
  return vector.retrieval_channel_snapshots.some((channel) =>
    channel.lag_bound.kind === "exact" && channel.generation !== embedding.generation
  );
}

function tornGovernanceProjection(vector: SnapshotVectorV1): boolean {
  const governance = vector.governance_frontier;
  const projection = vector.projection_generation;
  return governance.lag_bound.kind === "exact"
    && projection.lag_bound.kind === "exact"
    && governance.generation !== projection.generation;
}

function exactTimeMismatch(
  source: SourceFrontierDeclarationV1,
  asOf: string
): boolean {
  return source.lag_bound.kind === "exact"
    && !validTimeContains(source.valid_time_domain, asOf);
}

function validTimeContains(domain: SnapshotValidTimeDomainV1, asOf: string): boolean {
  if (domain.kind === "timeless") return true;
  if (domain.kind === "open") return domain.from <= asOf;
  return domain.from <= asOf && asOf < domain.to;
}

function collectLagBounds(sources: readonly SourceFrontierDeclarationV1[]): string[] {
  const bounds: string[] = [];
  for (const source of sources) {
    if (source.lag_bound.kind === "bounded") {
      bounds.push(serializeRemainingEffect(source.lag_bound.remaining_effect));
    }
  }
  return bounds;
}

function freezeClass(
  state: SnapshotCoherenceState,
  reasons: readonly string[],
  lag_bounds: readonly string[]
): SnapshotCoherenceClassification {
  return Object.freeze({
    state,
    reasons: Object.freeze([...reasons]),
    lag_bounds
  });
}
