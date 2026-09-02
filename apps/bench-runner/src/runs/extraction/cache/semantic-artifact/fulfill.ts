import {
  capabilitiesAreCompatible,
  resolveExtractionCapability
} from "./capability.js";
import { inspectSemanticArtifact, recordSourceBinding } from "./store.js";
import {
  runSemanticFill,
  type SemanticFillEnvelope,
  type SemanticFillTask,
  type SemanticFillTransport
} from "../../fill/semantic-fill-executor.js";

export type CapabilityFulfillmentState =
  | "cache-hit"
  | "materialized-now"
  | "unavailable"
  | "failed";

export interface CapabilityFulfillment {
  readonly state: CapabilityFulfillmentState;
  readonly semanticKey: string;
  readonly capability: string;
  readonly reason?: string;
  readonly calls: number;
}

export function fulfillAssertionCapability(input: {
  readonly root: string;
  readonly task: SemanticFillTask;
  readonly envelope: SemanticFillEnvelope;
  readonly transport?: SemanticFillTransport;
}): CapabilityFulfillment {
  const contract = resolveExtractionCapability(input.task.capability);
  const available = contract.requirements.filter((capability) => {
    const inspected = inspectSemanticArtifact(input.root, input.task.semanticKey, capability);
    return inspected.status === "provider_backed" || inspected.status === "deterministic_empty";
  });
  if (!capabilitiesAreCompatible(contract.requirements, available)) {
    return {
      state: "unavailable",
      semanticKey: input.task.semanticKey,
      capability: input.task.capability,
      reason: "capability requirements unavailable",
      calls: 0
    };
  }
  const existing = inspectSemanticArtifact(input.root, input.task.semanticKey, input.task.capability);
  if (existing.status === "provider_backed" || existing.status === "deterministic_empty") {
    recordSourceBinding(input.root, input.task.semanticKey, input.task.capability, input.task.binding);
    return {
      state: "cache-hit",
      semanticKey: input.task.semanticKey,
      capability: input.task.capability,
      calls: 0
    };
  }
  if (input.transport === undefined) {
    return {
      state: "unavailable",
      semanticKey: input.task.semanticKey,
      capability: input.task.capability,
      reason: existing.status,
      calls: 0
    };
  }
  const report = runSemanticFill({
    root: input.root,
    tasks: [input.task],
    envelope: input.envelope,
    transport: input.transport
  });
  if (report.admitted === 1) {
    return {
      state: "materialized-now",
      semanticKey: input.task.semanticKey,
      capability: input.task.capability,
      calls: report.calls
    };
  }
  if (report.failures > 0) {
    return {
      state: "failed",
      semanticKey: input.task.semanticKey,
      capability: input.task.capability,
      reason: report.attempts[0]?.reason,
      calls: report.calls
    };
  }
  return {
    state: "unavailable",
    semanticKey: input.task.semanticKey,
    capability: input.task.capability,
    reason: report.attempts[0]?.reason ?? "unresolved",
    calls: report.calls
  };
}
