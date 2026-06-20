import type { RuntimeEvent } from "@do-soul/alaya-protocol";

import type { NormalizerContext } from "./runtime-event-normalizer.js";
import { RecoveryPrimitives } from "./serial-delegation-recovery-primitives.js";
import { SerialDelegationStartupRecovery } from "./serial-delegation-startup-recovery.js";
import { SerialDelegationEventRecovery } from "./serial-delegation-event-recovery.js";
import type {
  PreDispatchFreezeIntent,
  RuntimeEventFailureParams,
  SerialDelegationRecoveryDependencies,
  StartupFailureRecoveryParams
} from "./serial-delegation-recovery-ports.js";

export { summarizeError, toErrorOptions } from "./serial-delegation-recovery-errors.js";
export type {
  PreDispatchFreezeIntent,
  RecoveryMetadata,
  SerialDelegationRecoveryDependencies
} from "./serial-delegation-recovery-ports.js";

export class SerialDelegationRecovery {
  private readonly startup: SerialDelegationStartupRecovery;
  private readonly events: SerialDelegationEventRecovery;

  public constructor(public readonly deps: SerialDelegationRecoveryDependencies) {
    const primitives = new RecoveryPrimitives(deps);
    this.startup = new SerialDelegationStartupRecovery(primitives);
    this.events = new SerialDelegationEventRecovery(primitives);
  }

  public async recoverPreDispatchFailure(
    workerRunId: string,
    error: unknown,
    freezeIntent: PreDispatchFreezeIntent | null,
    durableDecisionCommitted: boolean
  ): Promise<void> {
    return this.startup.recoverPreDispatchFailure(workerRunId, error, freezeIntent, durableDecisionCommitted);
  }

  public async handleStartupFailure(params: StartupFailureRecoveryParams): Promise<void> {
    return this.startup.handleStartupFailure(params);
  }

  public async handleRuntimeEvent(
    event: RuntimeEvent,
    context: NormalizerContext,
    workerRunId: string,
    unsubscribe: () => void,
    stopEventIntake: () => void
  ): Promise<void> {
    return this.events.handleRuntimeEvent(event, context, workerRunId, unsubscribe, stopEventIntake);
  }

  public async handleRuntimeEventFailure(params: RuntimeEventFailureParams): Promise<void> {
    return this.events.handleRuntimeEventFailure(params);
  }
}
