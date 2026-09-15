import type { SourceInterpretationSignal } from "@do-soul/alaya-protocol";
import type {
  MaterializationContext,
  MaterializationResult,
  MaterializationRouterDeps,
  MaterializationTarget
} from "./contracts.js";
import { materializationFailure, materializationSuccess } from "./materialization-results.js";

export function sourceObservationTarget(portWired: boolean): MaterializationTarget {
  if (!portWired) {
    return {
      kind: "deferred",
      route_target: "deferred",
      routing_reason: "source observation admission is not connected"
    };
  }
  return {
    kind: "evidence_only",
    route_target: "memory_entry_only",
    routing_reason: "source-bound observation through core admission"
  };
}

export async function materializeSourceObservation(
  dependencies: MaterializationRouterDeps,
  signal: SourceInterpretationSignal,
  context: MaterializationContext
): Promise<MaterializationResult> {
  const target = sourceObservationTarget(dependencies.sourceObservationPublicationPort !== undefined);
  const port = dependencies.sourceObservationPublicationPort;
  if (port === undefined) {
    return materializationSuccess({
      signal_id: signal.signal_id,
      target_kind: "deferred",
      route_target: target.route_target,
      routing_reason: target.routing_reason,
      created_objects: []
    });
  }
  try {
    const published = await port.publish({ signal, context });
    return materializationSuccess({
      signal_id: signal.signal_id,
      target_kind: "evidence_only",
      route_target: "memory_entry_only",
      routing_reason: `${target.routing_reason} (${published.bound.outcome})`,
      created_objects: [
        { object_kind: published.evidence.object_kind, object_id: published.evidence.object_id },
        { object_kind: published.memory.object_kind, object_id: published.memory.object_id }
      ]
    });
  } catch (error) {
    return materializationFailure(
      {
        signal_id: signal.signal_id,
        target_kind: "evidence_only",
        route_target: "memory_entry_only",
        routing_reason: target.routing_reason,
        created_objects: []
      },
      error
    );
  }
}
