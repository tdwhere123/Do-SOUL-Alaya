import { fulfillAssertionCapability, type CapabilityFulfillment } from "./fulfill.js";
import type { SemanticFillEnvelope, SemanticFillTask, SemanticFillTransport } from
  "../../fill/semantic-fill-executor.js";

export interface LazyF3ShadowReport {
  readonly revealed: readonly CapabilityFulfillment[];
  readonly warm: readonly CapabilityFulfillment[];
  readonly coldCalls: number;
  readonly warmCalls: number;
}

export function shadowLazyF3Fulfillment(input: {
  readonly root: string;
  readonly demand: readonly SemanticFillTask[];
  readonly envelope: SemanticFillEnvelope;
  readonly transport?: SemanticFillTransport;
}): LazyF3ShadowReport {
  const revealed = input.demand.map((task) => fulfillAssertionCapability({
    root: input.root,
    task,
    envelope: input.envelope,
    transport: input.transport
  }));
  const warm = input.demand.map((task) => fulfillAssertionCapability({
    root: input.root,
    task,
    envelope: input.envelope
  }));
  return {
    revealed,
    warm,
    coldCalls: revealed.reduce((sum, item) => sum + item.calls, 0),
    warmCalls: warm.reduce((sum, item) => sum + item.calls, 0)
  };
}
