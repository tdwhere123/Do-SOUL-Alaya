import {
  MAX_TEMPORAL_RECALL_CANDIDATES,
  type MemoryEntry
} from "@do-soul/alaya-protocol";
import type { RecallQueryProbes } from "../../query/recall-query-probes.js";
import type { RecallServiceMemoryRepoPort } from "../../runtime/recall-service-types.js";
import { parseQueryTimeWindow } from "../../scoring/temporal-fusion-scoring.js";
import type { AddCoarseCandidate } from "../coarse-filter-admission.js";

export class TemporalWindowCandidateBudget {
  private remainingCount: number;

  public constructor(limit: number) {
    this.remainingCount = Math.min(limit, MAX_TEMPORAL_RECALL_CANDIDATES);
  }

  public get remaining(): number {
    return this.remainingCount;
  }

  public admit(
    entries: readonly Readonly<MemoryEntry>[]
  ): readonly Readonly<MemoryEntry>[] {
    const admitted = entries.slice(0, this.remainingCount);
    this.remainingCount -= admitted.length;
    return admitted;
  }
}

export function createTemporalWindowCandidateBudget(
  limit: number | undefined
): TemporalWindowCandidateBudget | undefined {
  return limit === undefined || limit <= 0
    ? undefined
    : new TemporalWindowCandidateBudget(limit);
}

export async function addTemporalWindowCandidates(params: Readonly<{
  readonly workspaceId: string;
  readonly tier: MemoryEntry["storage_tier"];
  readonly queryProbes: Readonly<RecallQueryProbes>;
  readonly referenceTime?: string;
  readonly budget?: TemporalWindowCandidateBudget;
  readonly memoryRepo: RecallServiceMemoryRepoPort;
  readonly addCandidate: AddCoarseCandidate;
}>): Promise<void> {
  const readWindow = params.memoryRepo.findByEventTimeWindow;
  if (readWindow === undefined || params.budget === undefined || params.budget.remaining <= 0) {
    return;
  }
  const window = parseQueryTimeWindow(params.queryProbes, params.referenceTime);
  if (window === null) {
    return;
  }
  const entries = await readWindow.call(params.memoryRepo, {
    workspaceId: params.workspaceId,
    tier: params.tier,
    startTime: new Date(window.startMs).toISOString(),
    endTime: new Date(window.endMs).toISOString(),
    limit: params.budget.remaining
  });
  for (const entry of params.budget.admit(entries)) {
    params.addCandidate(entry, "temporal_window", 0, "temporal_window");
  }
}
