import { type CandidateMemorySignal } from "@do-soul/alaya-protocol";
import type { HandoffGapCreatedObject } from "../handoff-gap-handler.js";
import type { MaterializationResult, MaterializationTarget } from "./contracts.js";
import { buildDistilledFact, buildEvidenceInput, buildSynthesisInput, readStringPayload } from "./inputs.js";
import { materializationFailure, materializationSuccess } from "./materialization-results.js";
import { MaterializationRouterMemoryRoutes } from "./memory-routes.js";

export class MaterializationRouterRouteHandlers extends MaterializationRouterMemoryRoutes {
  protected async materializeSynthesis(
    signal: CandidateMemorySignal,
    target: MaterializationTarget
  ): Promise<MaterializationResult> {
    const createdObjects: Array<{ object_kind: string; object_id: string }> = [];

    try {
      const evidenceRefs = normalizeSynthesisEvidenceRefs(signal.evidence_refs);
      if (evidenceRefs.length < 2) {
        return materializationFailure(
          {
            signal_id: signal.signal_id,
            target_kind: target.kind,
            route_target: target.route_target,
            routing_reason: target.routing_reason,
            created_objects: []
          },
          "Synthesis materialization requires at least two evidence_refs",
          "Synthesis materialization requires at least two evidence_refs"
        );
      }
      const evidenceInputs = evidenceRefs.map((evidenceRef) =>
        buildEvidenceInput(signal, evidenceRef, {
          artifactRef: evidenceRef,
          fullTurnExcerpt: this.dependencies.fullTurnEvidenceExcerpt
        })
      );

      const evidences = await Promise.all(
        evidenceInputs.map(async (evidenceInput) => await this.dependencies.evidenceService.create(evidenceInput))
      );

      const evidenceIds = evidences.map((evidence) => evidence.object_id);
      for (const evidence of evidences) {
        createdObjects.push({ object_kind: evidence.object_kind, object_id: evidence.object_id });
      }

      const synthesis = await this.dependencies.synthesisService.create(
        buildSynthesisInput(signal, evidenceIds)
      );
      createdObjects.push({ object_kind: synthesis.object_kind, object_id: synthesis.object_id });

      // No graph relation here: the path plane anchors on memory_entries, and a
      // synthesis_capsule id is not a memory endpoint. The synthesis↔memory
      // relation is carried by synthesis.evidence_refs (which point at evidence
      // ids) and by claim resolution downstream. A synthesis-to-memory
      // provenance relation would need a deliberate anchor-domain change.

      return materializationSuccess({
        signal_id: signal.signal_id,
        target_kind: target.kind,
        route_target: target.route_target,
        routing_reason: target.routing_reason,
        created_objects: createdObjects
      });
    } catch (error) {
      return materializationFailure(
        {
          signal_id: signal.signal_id,
          target_kind: target.kind,
          route_target: target.route_target,
          routing_reason: target.routing_reason,
          created_objects: createdObjects
        },
        error
      );
    }
  }

  protected async materializeHandoffGap(
    signal: CandidateMemorySignal,
    target: MaterializationTarget
  ): Promise<MaterializationResult> {
    try {
      const createdObject: HandoffGapCreatedObject =
        this.dependencies.handoffGapHandler.createFromSignal(signal);

      return materializationSuccess({
        signal_id: signal.signal_id,
        target_kind: target.kind,
        route_target: target.route_target,
        routing_reason: target.routing_reason,
        created_objects: [createdObject]
      });
    } catch (error) {
      return materializationFailure(
        {
          signal_id: signal.signal_id,
          target_kind: target.kind,
          route_target: target.route_target,
          routing_reason: target.routing_reason,
          created_objects: []
        },
        error
      );
    }
  }

  /** Returns a deferred result without persisting anything. */
  protected materializeDeferred(
    signal: CandidateMemorySignal,
    target: MaterializationTarget
  ): MaterializationResult {
    return materializationSuccess({
      signal_id: signal.signal_id,
      target_kind: "deferred",
      route_target: target.route_target,
      routing_reason: target.routing_reason,
      created_objects: [],
      ...(target.defer_reason === undefined ? {} : { defer_reason: target.defer_reason }),
      ...(target.defer_class === undefined ? {} : { defer_class: target.defer_class })
    });
  }

  protected async materializePathRelationProposal(
    signal: CandidateMemorySignal,
    target: MaterializationTarget
  ): Promise<MaterializationResult> {
    const targetObjectId = readStringPayload(signal.raw_payload, "target_object_id");
    if (targetObjectId === null) {
      return materializationSuccess({
        signal_id: signal.signal_id,
        target_kind: "deferred",
        route_target: target.route_target,
        routing_reason: `${target.routing_reason} — deferred: target_object_id missing`,
        created_objects: []
      });
    }

    const created = await this.createTimeConcernPathRelationProposal(targetObjectId, signal);
    return materializationSuccess({
      signal_id: signal.signal_id,
      target_kind: "deferred",
      route_target: target.route_target,
      routing_reason: target.routing_reason,
      created_objects: created === null ? [] : [created]
    });
  }

  // invariant: potential_conflict route sink. evaluate is the only
  // producer for contradicts / incompatible_with edges that originates
  // from a raw signal (memory-time detection runs through
  // detectAndLinkConflicts after the new memory is created). When the
  // port is absent or lacks evaluate, the signal is deferred so the
  // conflict surface is not silently lost as questionable evidence.
  protected async materializeConflictEvaluation(
    signal: CandidateMemorySignal,
    target: MaterializationTarget
  ): Promise<MaterializationResult> {
    const port = this.dependencies.conflictDetectionPort;
    if (port === undefined || port.evaluate === undefined) {
      return materializationSuccess({
        signal_id: signal.signal_id,
        target_kind: "deferred",
        route_target: target.route_target,
        routing_reason: `${target.routing_reason} — deferred: evaluate unavailable`,
        created_objects: []
      });
    }

    try {
      await port.evaluate({
        signalId: signal.signal_id,
        workspaceId: signal.workspace_id,
        runId: signal.run_id,
        objectKind: signal.object_kind,
        scopeHint: signal.scope_hint,
        content: buildDistilledFact(signal),
        domainTags: signal.domain_tags
      });

      return materializationSuccess({
        signal_id: signal.signal_id,
        target_kind: "deferred",
        route_target: target.route_target,
        routing_reason: target.routing_reason,
        created_objects: []
      });
    } catch (error) {
      return materializationFailure(
        {
          signal_id: signal.signal_id,
          target_kind: "deferred",
          route_target: target.route_target,
          routing_reason: target.routing_reason,
          created_objects: []
        },
        error
      );
    }
  }

  protected async materializeEvidenceOnly(
    signal: CandidateMemorySignal,
    target: MaterializationTarget
  ): Promise<MaterializationResult> {
    try {
      const evidence = await this.dependencies.evidenceService.create(buildEvidenceInput(signal, undefined, { fullTurnExcerpt: this.dependencies.fullTurnEvidenceExcerpt }));

      return materializationSuccess({
        signal_id: signal.signal_id,
        target_kind: target.kind,
        route_target: target.route_target,
        routing_reason: target.routing_reason,
        created_objects: [{ object_kind: evidence.object_kind, object_id: evidence.object_id }]
      });
    } catch (error) {
      return materializationFailure(
        {
          signal_id: signal.signal_id,
          target_kind: target.kind,
          route_target: target.route_target,
          routing_reason: target.routing_reason,
          created_objects: []
        },
        error
      );
    }
  }

}

function normalizeSynthesisEvidenceRefs(evidenceRefs: readonly string[]): readonly string[] {
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const evidenceRef of evidenceRefs) {
    const trimmed = evidenceRef.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    normalized.push(trimmed);
  }
  return Object.freeze(normalized);
}
