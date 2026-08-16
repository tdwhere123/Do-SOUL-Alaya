import {
  FieldGenerationEventType,
  SoulFieldEffectDecidedPayloadSchema,
  type EffectDecisionReceipt,
  type EffectRequest,
  type ProjectionEraseBarrier,
  type ProofEffectPort
} from "@do-soul/alaya-protocol";
import { SYSTEM_ACTOR } from "../../shared/actors.js";
import { readNow, type NowProvider } from "../../shared/time.js";
import {
  EventLogSafeEraseBarrier,
  buildEraseBarrierEventInput,
  type GovernanceEventLogPort
} from "./erase-barrier.js";
import { GovernedEffectAction } from "./proof-effect-policy.js";

export type LifecycleHistory = Readonly<{
  readonly predecessors: readonly string[];
  readonly successors: readonly string[];
  readonly revoked_from: string | null;
  readonly sealed: boolean;
  readonly erased: boolean;
}>;

export interface GovernedEffectLifecycleDependencies {
  readonly proof: ProofEffectPort;
  readonly erase: EventLogSafeEraseBarrier;
  readonly eventLog: GovernanceEventLogPort;
  readonly now?: NowProvider;
  readonly buildEraseBarrier: (request: EffectRequest) => ProjectionEraseBarrier;
}

export class GovernedEffectLifecycle {
  private readonly history = new Map<string, LifecycleHistory>();
  private readonly now: NowProvider;

  public constructor(private readonly dependencies: GovernedEffectLifecycleDependencies) {
    this.now = dependencies.now ?? (() => new Date().toISOString());
  }

  public apply(request: EffectRequest): {
    readonly decision: EffectDecisionReceipt;
    readonly history: LifecycleHistory;
  } {
    const decision = this.dependencies.proof.decide(request);
    this.dependencies.eventLog.append({
      event_type: FieldGenerationEventType.SOUL_FIELD_EFFECT_DECIDED,
      entity_type: "proof_effect_decision",
      entity_id: decision.request_digest,
      workspace_id: request.workspace_id,
      run_id: null,
      caused_by: SYSTEM_ACTOR,
      payload_json: SoulFieldEffectDecidedPayloadSchema.parse({
        workspace_id: request.workspace_id,
        request_digest: decision.request_digest,
        action: request.action,
        target: request.target,
        scope: request.scope,
        effective_as_of: request.effective_as_of,
        decision: decision.decision,
        occurred_at: readNow(this.now)
      })
    });
    if (decision.decision === "allow") {
      this.applyAllowed(request);
    }
    return { decision, history: this.readHistory(request.target) };
  }

  public readHistory(target: string): LifecycleHistory {
    return this.history.get(target) ?? emptyHistory();
  }

  private applyAllowed(request: EffectRequest): void {
    const current = this.readHistory(request.target);
    if (request.action === GovernedEffectAction.ERASE) {
      const stored = this.dependencies.erase.erase(
        this.dependencies.buildEraseBarrier(request)
      );
      this.dependencies.eventLog.append(buildEraseBarrierEventInput(stored));
      this.history.set(request.target, { ...current, erased: true });
      return;
    }
    if (request.action === GovernedEffectAction.REVOKE) {
      this.history.set(request.target, { ...current, revoked_from: request.effective_as_of });
      return;
    }
    if (request.action === GovernedEffectAction.SEAL) {
      this.history.set(request.target, { ...current, sealed: true });
      return;
    }
    if (request.action === GovernedEffectAction.CORRECT || request.action === GovernedEffectAction.SUPERSEDE) {
      this.history.set(request.target, retainSuccessorHistory(current, request.supporting_receipt_ids));
    }
  }
}

function retainSuccessorHistory(
  current: LifecycleHistory,
  receiptIds: readonly string[]
): LifecycleHistory {
  return {
    ...current,
    predecessors: uniqueIds([...current.predecessors, ...receiptIds.slice(0, 1)]),
    successors: uniqueIds([...current.successors, ...receiptIds.slice(1)])
  };
}

function uniqueIds(ids: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(ids)]);
}

function emptyHistory(): LifecycleHistory {
  return Object.freeze({
    predecessors: Object.freeze([]),
    successors: Object.freeze([]),
    revoked_from: null,
    sealed: false,
    erased: false
  });
}
