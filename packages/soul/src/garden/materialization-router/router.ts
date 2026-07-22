import type { CandidateMemorySignal } from "@do-soul/alaya-protocol";
import { validateSchemaGroundingForSignal } from "../schema-grounding.js";
import {
  requiresGardenSourceGrounding,
  resolveGardenSignalGrounding
} from "../grounding/signal-source-grounding.js";
import { EMPTY_MATERIALIZATION_CONTEXT } from "./contracts.js";
import type {
  MaterializationCreatedObject,
  MaterializationContext,
  MaterializationResult,
  MaterializationRouterDeps,
  MaterializationTarget
} from "./contracts.js";
import { isGardenTurnEvidenceFallback } from "../evidence-preservation/turn-evidence-anchor.js";
import {
  hasMaterializableSignalMemoryRefs,
  routeByObjectKind,
  signalCarriesProjectionPayload
} from "./inputs.js";
import { materializationFailure } from "./materialization-results.js";
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

function guardSignalGrounding(signal: CandidateMemorySignal): MaterializationTarget | null {
  if (requiresGardenSourceGrounding(signal)) {
    const grounding = resolveGardenSignalGrounding(signal);
    if (grounding.status === "rejected") {
      return {
        kind: "deferred",
        route_target: "deferred",
        routing_reason: `garden source grounding failed: ${grounding.reason}`,
        defer_reason: grounding.reason,
        defer_class: "source_grounding"
      };
    }
  }
  return guardSchemaGrounding(signal);
}

function guardSchemaGrounding(signal: CandidateMemorySignal): MaterializationTarget | null {
  const schema = validateSchemaGroundingForSignal(signal);
  if (!schema.declared || schema.status === "valid") return null;
  return {
    kind: "deferred",
    route_target: "deferred",
    routing_reason: `schema-grounded signal failed validation: ${schema.reasons.join("; ")}`
  };
}

export class MaterializationRouter extends MaterializationRouterRouteHandlers {
  public constructor(dependencies: MaterializationRouterDeps) {
    super(dependencies);
  }

  public async replaySignalRefs(input: {
    readonly newObjectId: string;
    readonly evidenceId: string;
    readonly signal: CandidateMemorySignal;
    readonly context: MaterializationContext;
  }): Promise<readonly MaterializationCreatedObject[]> {
    if (hasMaterializableSignalMemoryRefs(input.signal)) {
      if (
        this.dependencies.pathCandidateSinkPort === undefined &&
        this.dependencies.temporalRelationAssertionPort === undefined
      ) {
        throw new Error("Signal-ref replay has neither temporal assertion nor path candidate admission.");
      }
      if (
        this.dependencies.temporalRelationAssertionPort !== undefined &&
        input.context.source_event_anchor === null
      ) {
        throw new Error("Temporal signal-ref replay requires a verified signal emission anchor.");
      }
      if (
        this.dependencies.temporalRelationAssertionPort !== undefined &&
        input.evidenceId.trim().length === 0
      ) {
        throw new Error("Temporal signal-ref replay requires persisted evidence linked to the new memory.");
      }
    }
    return await this.createAllMemoryRefEdges(
      input.newObjectId,
      [input.evidenceId],
      input.signal,
      input.context,
      "throw_for_retry"
    );
  }

  public route(signal: CandidateMemorySignal): MaterializationTarget {
    // Evidence anchors archive source input; they do not assert a fact and
    // therefore must not be blocked by the durable-fact grounding guard.
    if (isGardenTurnEvidenceFallback(signal)) {
      const schemaGuard = guardSchemaGrounding(signal);
      if (schemaGuard !== null) return schemaGuard;
      return {
        kind: "evidence_only",
        route_target: "evidence_only",
        routing_reason: "evidence archival"
      };
    }
    const guard = guardSignalGrounding(signal);
    if (guard !== null) return guard;

    for (const strategy of SIGNAL_ROUTE_STRATEGIES) {
      if (strategy.matches(signal)) {
        return strategy.target(signal);
      }
    }

    const durable = this.routeDurableSignal(signal);
    if (durable !== null) return durable;

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

  private routeDurableSignal(signal: CandidateMemorySignal): MaterializationTarget | null {
    const floor = this.dependencies.materializationConfidenceFloor ?? 0.5;
    const eligibleKind = signal.signal_kind === "potential_claim" ||
      signal.signal_kind === "potential_preference";
    if (!eligibleKind || signal.confidence < floor) return null;
    const route = routeByObjectKind(signal.object_kind);
    if (route !== null) return this.liftSignalOnlyForProjection(signal, route);
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

  public async materializeSignal(
    signal: CandidateMemorySignal,
    context: MaterializationContext = EMPTY_MATERIALIZATION_CONTEXT
  ): Promise<MaterializationResult> {
    return await this.materialize(signal, this.route(signal), context);
  }

  public async materialize(
    signal: CandidateMemorySignal,
    target: MaterializationTarget,
    context: MaterializationContext = EMPTY_MATERIALIZATION_CONTEXT
  ): Promise<MaterializationResult> {
    if (target.route_target === "memory_entry_only") {
      return await this.materializeMemoryEntryOnly(signal, target, context);
    }
    if (target.route_target === "conflict_evaluation") {
      return await this.materializeConflictEvaluation(signal, target, context);
    }
    if (target.route_target === "path_relation_proposal") {
      return await this.materializePathRelationProposal(signal, target, context);
    }
    if (target.route_target === "signal_only") {
      return this.materializeDeferred(signal, target, context);
    }

    switch (target.kind) {
      case "memory_and_claim":
        return await this.materializeMemoryAndClaim(signal, target, context);
      case "synthesis":
        return await this.materializeSynthesis(signal, target, context);
      case "handoff_gap":
        return await this.materializeHandoffGap(signal, target, context);
      case "evidence_only":
        return await this.materializeEvidenceOnly(signal, target, context);
      case "deferred":
        return this.materializeDeferred(signal, target, context);
      default: {
        const exhaustiveCheck: never = target.kind;
        return materializationFailure(
          {
            signal_id: signal.signal_id,
            target_kind: exhaustiveCheck,
            route_target: target.route_target,
            routing_reason: target.routing_reason,
            created_objects: []
          },
          "Unsupported materialization target",
          "Unsupported materialization target"
        );
      }
    }
  }

}
