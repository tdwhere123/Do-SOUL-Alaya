import { randomUUID } from "node:crypto";
import {
  ActivationCandidateSchema,
  isPathActiveForRecall,
  type ActivationCandidate,
  type PathAnchorRef,
  type PathRelation
} from "@do-soul/alaya-protocol";

// invariant: PathActivationCandidateProducer is the runtime bridge from
// durable PathRelation rows into transient ActivationCandidate values.
// Activation is runtime control, never durable truth — producer holds no
// persistence and runs synchronously per recall trigger.
// see also: manifestation-resolver.ts (downstream consumer).
// see also: path-relation-proposal-service.ts (PathRelation producer).

export interface PathActivationCandidateProducerPathReaderPort {
  // Returns recall-active PathRelation rows whose source_anchor or
  // target_anchor references one of the supplied memory object_ids. The
  // reader is responsible for filtering non-active (retired/dormant) rows;
  // the producer also re-asserts active status in case the port emits a
  // wider set.
  findActiveByAnchorObjectIds(
    workspaceId: string,
    memoryObjectIds: readonly string[]
  ): Promise<readonly Readonly<PathRelation>[]>;
}

export interface ProduceActivationCandidatesParams {
  readonly workspaceId: string;
  readonly runId: string;
  readonly anchorMemoryObjectIds: readonly string[];
  readonly now?: string;
}

export interface PathActivationCandidateProducerDependencies {
  readonly pathReader: PathActivationCandidateProducerPathReaderPort;
  readonly generateCandidateId?: () => string;
  readonly now?: () => string;
}

const SYSTEM_NOW = () => new Date().toISOString();

export class PathActivationCandidateProducer {
  private readonly generateCandidateId: () => string;
  private readonly now: () => string;

  public constructor(private readonly deps: PathActivationCandidateProducerDependencies) {
    this.generateCandidateId = deps.generateCandidateId ?? (() => randomUUID());
    this.now = deps.now ?? SYSTEM_NOW;
  }

  public async produce(
    params: ProduceActivationCandidatesParams
  ): Promise<readonly Readonly<ActivationCandidate>[]> {
    if (params.anchorMemoryObjectIds.length === 0) {
      return Object.freeze([]);
    }

    const uniqueAnchors = Object.freeze([...new Set(params.anchorMemoryObjectIds)]);
    const paths = await this.deps.pathReader.findActiveByAnchorObjectIds(
      params.workspaceId,
      uniqueAnchors
    );
    const createdAt = params.now ?? this.now();

    const candidates: Readonly<ActivationCandidate>[] = [];
    const seen = new Set<string>();
    for (const path of paths) {
      if (!isPathActiveForRecall(path.lifecycle.status)) {
        continue;
      }
      if (seen.has(path.path_id)) {
        continue;
      }
      seen.add(path.path_id);
      const candidate = ActivationCandidateSchema.parse({
        candidate_id: this.generateCandidateId(),
        workspace_id: params.workspaceId,
        run_id: params.runId,
        source_path_id: path.path_id,
        source_anchor: clonePathAnchorRef(path.anchors.source_anchor),
        target_anchor: clonePathAnchorRef(path.anchors.target_anchor),
        why_now: `path:${path.constitution.relation_kind}`,
        effect_vector_snapshot: cloneEffectVector(path.effect_vector),
        pressure: clamp01(path.effect_vector.salience),
        confidence: clamp01(path.plasticity_state.strength),
        governance_ceiling: path.legitimacy.governance_class,
        created_at: createdAt
      });
      candidates.push(candidate);
    }

    return Object.freeze(candidates);
  }
}

function cloneEffectVector(
  effectVector: PathRelation["effect_vector"]
): PathRelation["effect_vector"] {
  return Object.freeze({
    salience: effectVector.salience,
    recall_bias: effectVector.recall_bias,
    verification_bias: effectVector.verification_bias,
    unfinishedness_bias: effectVector.unfinishedness_bias,
    default_manifestation_preference: effectVector.default_manifestation_preference
  });
}

function clonePathAnchorRef(anchor: PathAnchorRef): PathAnchorRef {
  switch (anchor.kind) {
    case "object":
      return Object.freeze({ kind: "object", object_id: anchor.object_id });
    case "object_facet":
      return Object.freeze({
        kind: "object_facet",
        object_id: anchor.object_id,
        facet_key: anchor.facet_key
      });
    case "obligation":
      return Object.freeze({
        kind: "obligation",
        source_object_id: anchor.source_object_id,
        obligation_digest: anchor.obligation_digest
      });
    case "risk_concern":
      return Object.freeze({
        kind: "risk_concern",
        source_object_id: anchor.source_object_id,
        concern_digest: anchor.concern_digest
      });
    case "time_concern":
      return Object.freeze({
        kind: "time_concern",
        source_object_id: anchor.source_object_id,
        window_digest: anchor.window_digest
      });
  }
}

function clamp01(value: number): number {
  if (Number.isNaN(value)) {
    return 0;
  }
  if (value < 0) {
    return 0;
  }
  if (value > 1) {
    return 1;
  }
  return value;
}
