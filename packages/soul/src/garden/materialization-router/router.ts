import type { CandidateMemorySignal } from "@do-soul/alaya-protocol";
import { validateSchemaGroundingForSignal } from "../schema-grounding.js";
import type {
  MaterializationCreatedObject,
  MaterializationResult,
  MaterializationRouterDeps,
  MaterializationTarget
} from "./contracts.js";
import {
  hasMaterializableSignalMemoryRefs,
  routeByObjectKind,
  signalCarriesProjectionPayload
} from "./inputs.js";
import { MaterializationRouterRouteHandlers } from "./route-handlers.js";

type SignalRouteStrategy = {
  readonly matches: (signal: CandidateMemorySignal) => boolean;
  readonly target: (signal: CandidateMemorySignal) => MaterializationTarget;
};

const SIGNAL_ROUTE_STRATEGIES: readonly SignalRouteStrategy[] = [
  {
    matches: (signal) => signal.signal_kind === "potential_synthesis" && signal.evidence_refs.length >= 2,
    target: () => ({
      kind: "synthesis",
      route_target: "synthesis",
      routing_reason: "multi-evidence synthesis candidate"
    })
  },
  {
    matches: (signal) => signal.signal_kind === "potential_handoff",
    target: () => ({
      kind: "handoff_gap",
      route_target: "handoff_gap",
      routing_reason: "run-bound handoff/gap detection"
    })
  },
  {
    matches: (signal) => signal.signal_kind === "potential_evidence_anchor",
    target: () => ({
      kind: "evidence_only",
      route_target: "evidence_only",
      routing_reason: "evidence archival"
    })
  },
  {
    matches: (signal) => signal.signal_kind === "potential_conflict",
    target: () => ({
      kind: "deferred",
      route_target: "conflict_evaluation",
      routing_reason: "potential_conflict -> ConflictDetectionPort.evaluate"
    })
  },
  {
    matches: (signal) => signal.signal_kind === "potential_claim" && signal.object_kind === "path_relation",
    target: () => ({
      kind: "deferred",
      route_target: "path_relation_proposal",
      routing_reason: "object_kind=path_relation -> path_relation_proposal"
    })
  }
];

export class MaterializationRouter extends MaterializationRouterRouteHandlers {
  public constructor(dependencies: MaterializationRouterDeps) {
    super(dependencies);
  }

  public async replaySignalRefs(input: {
    readonly newObjectId: string;
    readonly signal: CandidateMemorySignal;
  }): Promise<readonly MaterializationCreatedObject[]> {
    if (
      this.dependencies.pathCandidateSinkPort === undefined &&
      hasMaterializableSignalMemoryRefs(input.signal)
    ) {
      throw new Error("PathCandidateSinkPort unavailable during signal-ref replay.");
    }
    return await this.createAllMemoryRefEdges(
      input.newObjectId,
      input.signal,
      "throw_for_retry"
    );
  }

  public route(signal: CandidateMemorySignal): MaterializationTarget {
    const schemaGroundingValidation = validateSchemaGroundingForSignal(signal);
    if (schemaGroundingValidation.declared && schemaGroundingValidation.status !== "valid") {
      return {
        kind: "deferred",
        route_target: "deferred",
        routing_reason: `schema-grounded signal failed validation: ${schemaGroundingValidation.reasons.join("; ")}`
      };
    }

    for (const strategy of SIGNAL_ROUTE_STRATEGIES) {
      if (strategy.matches(signal)) {
        return strategy.target(signal);
      }
    }

    const materializationConfidenceFloor =
      this.dependencies.materializationConfidenceFloor ?? 0.5;
    if (
      (signal.signal_kind === "potential_claim" || signal.signal_kind === "potential_preference") &&
      signal.confidence >= materializationConfidenceFloor
    ) {
      const objectKindRoute = routeByObjectKind(signal.object_kind);
      if (objectKindRoute !== null) {
        return this.liftSignalOnlyForProjection(signal, objectKindRoute);
      }
      // invariant: unknown object_kind never enters governance review as
      // a draft claim — that would re-introduce the producer-side claim
      // collapse the routing table was meant to break. Known claim-
      // capable dimensions are enumerated in routeByObjectKind; anything
      // outside the table is archived as questionable evidence only.
      // retainUnroutedHighConfidenceFacts keeps the fact recallable as a
      // memory_entry_only (a memory with NO draft claim, so the claim/
      // governance surface stays unpolluted) — the same route `fact` takes.
      if (this.dependencies.retainUnroutedHighConfidenceFacts === true) {
        return {
          kind: "evidence_only",
          route_target: "memory_entry_only",
          routing_reason: `high-confidence ${signal.signal_kind} with unrouted object_kind=${signal.object_kind} -> memory_entry_only (retain-unrouted-facts)`
        };
      }
      return {
        kind: "evidence_only",
        route_target: "evidence_only",
        routing_reason: `high-confidence ${signal.signal_kind} with unrouted object_kind=${signal.object_kind} -> evidence_only`
      };
    }

    // Low-confidence unroutable signals are deferred rather than persisted as
    // questionable evidence — avoids accumulating low-confidence noise.
    if (signal.confidence < 0.3) {
      return {
        kind: "deferred",
        route_target: "deferred",
        routing_reason: "uncertain signal — deferred pending higher-confidence reconfirmation"
      };
    }

    return {
      kind: "evidence_only",
      route_target: "evidence_only",
      // invariant: unroutable signals are archived as questionable evidence only;
      // they do not produce verified long-term objects (invariant #16).
      routing_reason: "unroutable signal -> evidence archive (questionable evidence only)"
    };
  }

  // Lift a projection-bearing signal_only kind to memory_entry_only so its projection reaches a recallable memory_entry.
  private liftSignalOnlyForProjection(
    signal: CandidateMemorySignal,
    route: MaterializationTarget
  ): MaterializationTarget {
    if (
      this.dependencies.projectionRoutingEnabled !== true ||
      route.route_target !== "signal_only" ||
      !signalCarriesProjectionPayload(signal)
    ) {
      return route;
    }
    return {
      kind: "evidence_only",
      route_target: "memory_entry_only",
      routing_reason: `${route.routing_reason} -> memory_entry_only (projection payload present)`
    };
  }

  public async materializeSignal(signal: CandidateMemorySignal): Promise<MaterializationResult> {
    return await this.materialize(signal, this.route(signal));
  }

  public async materialize(
    signal: CandidateMemorySignal,
    target: MaterializationTarget
  ): Promise<MaterializationResult> {
    if (target.route_target === "memory_entry_only") {
      return await this.materializeMemoryEntryOnly(signal, target);
    }
    if (target.route_target === "conflict_evaluation") {
      return await this.materializeConflictEvaluation(signal, target);
    }
    if (target.route_target === "path_relation_proposal") {
      return await this.materializePathRelationProposal(signal, target);
    }
    if (target.route_target === "signal_only") {
      return this.materializeDeferred(signal, target);
    }

    switch (target.kind) {
      case "memory_and_claim":
        return await this.materializeMemoryAndClaim(signal, target);
      case "synthesis":
        return await this.materializeSynthesis(signal, target);
      case "handoff_gap":
        return await this.materializeHandoffGap(signal, target);
      case "evidence_only":
        return await this.materializeEvidenceOnly(signal, target);
      case "deferred":
        return this.materializeDeferred(signal, target);
      default: {
        const exhaustiveCheck: never = target.kind;
        return {
          signal_id: signal.signal_id,
          target_kind: exhaustiveCheck,
          route_target: target.route_target,
          routing_reason: target.routing_reason,
          created_objects: [],
          success: false,
          error: "Unsupported materialization target"
        };
      }
    }
  }

}
