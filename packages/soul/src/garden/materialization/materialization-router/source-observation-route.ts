import type { SourceInterpretationSignal } from "@do-soul/alaya-protocol";
import type {
  MaterializationContext,
  MaterializationCreatedObject,
  MaterializationResult,
  MaterializationRouterDeps,
  MaterializationTarget
} from "./contracts.js";
import {
  materializationFailure,
  materializationSuccess,
  readPartialFailureCreatedObjects
} from "./materialization-results.js";

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
    const partial = partialCreatedObjects(error);
    return materializationFailure(
      {
        signal_id: signal.signal_id,
        target_kind: "evidence_only",
        route_target: "memory_entry_only",
        routing_reason: target.routing_reason,
        created_objects: partial
      },
      error
    );
  }
}

function partialCreatedObjects(error: unknown): readonly MaterializationCreatedObject[] {
  const fromPartial = readPartialFailureCreatedObjects(error);
  if (fromPartial.length > 0) return fromPartial;
  const evidenceObjectId = readEvidenceObjectId(error);
  return evidenceObjectId === null
    ? []
    : [{ object_kind: "evidence_capsule", object_id: evidenceObjectId }];
}

function readEvidenceObjectId(error: unknown): string | null {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current !== null && typeof current === "object"; depth += 1) {
    const details = (current as { readonly details?: { readonly evidence_object_id?: unknown } }).details;
    if (typeof details?.evidence_object_id === "string" && details.evidence_object_id.length > 0) {
      return details.evidence_object_id;
    }
    current = (current as { readonly cause?: unknown }).cause;
  }
  return null;
}
