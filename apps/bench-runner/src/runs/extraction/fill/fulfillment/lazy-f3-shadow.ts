import { fulfillAssertionCapability, type CapabilityFulfillment } from "./fulfill.js";
import { semanticTaskIdentity } from
  "../../cache/semantic-artifact/admission-identity.js";
import { captureOfflineSemanticEnvelope } from "../semantic-fill-envelope.js";
import {
  runSemanticFill,
  type SemanticFillEnvelope,
  type SemanticFillTask,
  type SemanticFillTransport
} from "../semantic-fill-executor.js";
import {
  assertHistoricalSubstratePublish,
  captureHistoricalSubstrateBinding
} from "../manifest/substrate-key-raw-closure.js";

export interface LazyF3ShadowReport {
  readonly revealed: readonly CapabilityFulfillment[];
  readonly warm: readonly CapabilityFulfillment[];
  readonly coldCalls: number;
  readonly warmCalls: number;
  readonly historicalSubstrate?: Readonly<{
    readonly coverage: 1;
    readonly complete: true;
  }>;
}

export async function shadowLazyF3Fulfillment(input: {
  readonly root: string;
  readonly demand: readonly SemanticFillTask[];
  readonly envelope: SemanticFillEnvelope;
  readonly transport?: SemanticFillTransport;
  readonly signal?: AbortSignal;
  readonly historicalRoot?: string;
}): Promise<LazyF3ShadowReport> {
  const root = input.root;
  const demand = structuredClone(input.demand) as readonly SemanticFillTask[];
  const envelope = captureOfflineSemanticEnvelope(input.envelope);
  const transport = input.transport;
  const signal = input.signal;
  const historical = input.historicalRoot === undefined
    ? undefined
    : captureHistoricalSubstrateBinding(input.historicalRoot);
  signal?.throwIfAborted();
  const unique = [...new Map(demand.map((task) => [semanticTaskIdentity(task), task])).values()];
  const coldReport = transport === undefined ? undefined : await runSemanticFill({
    root,
    tasks: unique,
    envelope,
    transport,
    ...(signal === undefined ? {} : { signal })
  });
  const admitted = new Set(coldReport?.attempts.filter((attempt) =>
    attempt.outcome === "admitted").map((attempt) => `${attempt.semanticKey}\u0000${attempt.capability}`));
  const revealed: CapabilityFulfillment[] = [];
  for (const task of demand) {
    const result = await fulfillAssertionCapability({
      root, task, envelope,
      ...(signal === undefined ? {} : { signal })
    });
    revealed.push(admitted.has(`${task.semanticKey}\u0000${task.capability}`)
      ? { ...result, state: "materialized-now" as const }
      : result);
  }
  const warm: CapabilityFulfillment[] = [];
  for (const task of demand) {
    warm.push(await fulfillAssertionCapability({
      root,
      task,
      envelope,
      ...(signal === undefined ? {} : { signal })
    }));
  }
  if (historical !== undefined) assertHistoricalSubstratePublish(historical);
  return {
    revealed,
    warm,
    coldCalls: coldReport?.calls ?? 0,
    warmCalls: warm.reduce((sum, item) => sum + item.calls, 0),
    ...(historical === undefined ? {} : {
      historicalSubstrate: { coverage: 1 as const, complete: true as const }
    })
  };
}
