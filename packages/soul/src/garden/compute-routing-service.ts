import { randomUUID } from "node:crypto";
import {
  ComputeProviderPriority,
  ComputeRoutingDecisionSchema,
  type ComputeProviderPriority as ComputeProviderPriorityValue,
  type ComputeRoutingDecision,
  type ExecutionStanceModelRef
} from "@do-soul/alaya-protocol";
import type { GardenComputeProvider } from "./compute-provider.js";

export interface ComputeRoutingCandidate {
  readonly kind: ComputeProviderPriorityValue;
  readonly provider: GardenComputeProvider;
  readonly model_id: string;
  readonly adapter?: string;
}

export interface ComputeRoutingDependencies {
  readonly providers: readonly ComputeRoutingCandidate[];
  readonly now?: () => string;
  readonly generateDecisionId?: () => string;
}

const providerPriorityRank: Readonly<Record<ComputeProviderPriorityValue, number>> = Object.freeze({
  [ComputeProviderPriority.OFFICIAL_API]: 0,
  [ComputeProviderPriority.CUSTOM_API]: 1,
  [ComputeProviderPriority.LOCAL_MODEL]: 2,
  [ComputeProviderPriority.STUB]: 3
});
const SYSTEM_NOW = () => new Date().toISOString();

export class ComputeRoutingService {
  private readonly now: () => string;

  public constructor(private readonly deps: ComputeRoutingDependencies) {
    this.now = deps.now ?? SYSTEM_NOW;
  }

  public async route(workspaceId: string): Promise<Readonly<ComputeRoutingDecision>> {
    const selectedCandidate = selectHighestPriorityCandidate(this.deps.providers);

    if (selectedCandidate == null) {
      throw new Error("Compute routing failed closed: no configured compute providers.");
    }

    return ComputeRoutingDecisionSchema.parse({
      decision_id: this.generateDecisionId(),
      workspace_id: workspaceId,
      selected_provider: selectedCandidate.kind,
      model_id: selectedCandidate.model_id,
      ...(selectedCandidate.adapter != null ? { adapter: selectedCandidate.adapter } : {}),
      selection_reason: describeSelectionReason(selectedCandidate.kind),
      decided_at: this.now()
    });
  }

  public getDefaultProvider(): GardenComputeProvider {
    const selectedCandidate = selectHighestPriorityCandidate(this.deps.providers);

    if (selectedCandidate == null) {
      throw new Error("Compute routing failed closed: no configured compute providers.");
    }

    return selectedCandidate.provider;
  }

  public toModelRef(decision: Readonly<ComputeRoutingDecision>): Readonly<ExecutionStanceModelRef> {
    return toModelRef(decision);
  }

  public resolveProvider(
    modelRef: Readonly<ExecutionStanceModelRef> | null
  ): GardenComputeProvider | null {
    if (modelRef === null) {
      return null;
    }

    const matchedCandidate =
      this.deps.providers.find(
        (candidate) =>
          candidate.kind === modelRef.provider &&
          candidate.model_id === modelRef.model_id &&
          (candidate.adapter ?? null) === (modelRef.adapter ?? null)
      ) ?? null;

    return matchedCandidate?.provider ?? null;
  }

  private generateDecisionId(): string {
    return this.deps.generateDecisionId?.() ?? `compute-routing-${randomUUID()}`;
  }
}

export function toModelRef(
  decision: Readonly<ComputeRoutingDecision>
): Readonly<ExecutionStanceModelRef> {
  return {
    provider: decision.selected_provider,
    model_id: decision.model_id,
    ...(decision.adapter != null ? { adapter: decision.adapter } : {})
  };
}

function selectHighestPriorityCandidate(
  providers: readonly ComputeRoutingCandidate[]
): ComputeRoutingCandidate | null {
  let selected: ComputeRoutingCandidate | null = null;

  for (const candidate of providers) {
    if (selected == null) {
      selected = candidate;
      continue;
    }

    if (compareCandidates(candidate, selected) < 0) {
      selected = candidate;
    }
  }

  return selected;
}

function compareCandidates(
  left: Readonly<ComputeRoutingCandidate>,
  right: Readonly<ComputeRoutingCandidate>
): number {
  const rankDelta = providerPriorityRank[left.kind] - providerPriorityRank[right.kind];

  if (rankDelta !== 0) {
    return rankDelta;
  }

  const leftTieBreaker = JSON.stringify([
    left.provider.provider_kind,
    left.model_id,
    left.adapter ?? ""
  ]);
  const rightTieBreaker = JSON.stringify([
    right.provider.provider_kind,
    right.model_id,
    right.adapter ?? ""
  ]);

  return leftTieBreaker.localeCompare(rightTieBreaker);
}

function describeSelectionReason(selectedProvider: ComputeProviderPriorityValue): string {
  if (selectedProvider === ComputeProviderPriority.STUB) {
    return "stub selected as configured fallback compute provider";
  }

  return `${selectedProvider} selected as highest-priority configured compute provider`;
}
