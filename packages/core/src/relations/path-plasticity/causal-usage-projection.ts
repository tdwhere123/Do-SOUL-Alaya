import {
  getPathAnchorBackingObjectId,
  type CausalUsageReceipt,
  type PathRelation
} from "@do-soul/alaya-protocol";
import {
  DEFAULT_USAGE_DECAY_PER_MS,
  projectSoftUsage
} from "../../governance/effects/causal-plasticity.js";

export function projectCausalUsageOntoPaths(
  paths: readonly Readonly<PathRelation>[],
  receipts: readonly Readonly<CausalUsageReceipt>[],
  asOf: string,
  decayPerMs: number = DEFAULT_USAGE_DECAY_PER_MS
): readonly Readonly<PathRelation>[] {
  const receiptsByRef = indexApplicableReceipts(receipts, asOf);
  return Object.freeze(paths.map((path) => {
    const applicable = receiptsForPath(path, receiptsByRef);
    if (applicable.length === 0) return path;
    const projection = projectSoftUsage(
      applicable.map((receipt) => ({ receipt, channel: "usage" as const })),
      asOf,
      decayPerMs
    );
    return Object.freeze({
      ...path,
      plasticity_state: Object.freeze({
        ...path.plasticity_state,
        strength: combineStrength(path.plasticity_state.strength, projection.strength),
        support_events_count: path.plasticity_state.support_events_count + applicable.length,
        last_reinforced_at: latestReinforcement(path, applicable)
      })
    });
  }));
}

function combineStrength(base: number, usage: number): number {
  return 1 - (1 - base) * (1 - usage);
}

function latestReinforcement(
  path: Readonly<PathRelation>,
  receipts: readonly Readonly<CausalUsageReceipt>[]
): string {
  const usageLatest = latestOccurredAt(receipts);
  const existing = path.plasticity_state.last_reinforced_at;
  return existing !== undefined && Date.parse(existing) > Date.parse(usageLatest)
    ? existing
    : usageLatest;
}

function indexApplicableReceipts(
  receipts: readonly Readonly<CausalUsageReceipt>[],
  asOf: string
): ReadonlyMap<string, readonly Readonly<CausalUsageReceipt>[]> {
  const indexed = new Map<string, Readonly<CausalUsageReceipt>[]>();
  const asOfMs = Date.parse(asOf);
  for (const receipt of receipts) {
    if (
      receipt.scope === receipt.workspace_id &&
      receipt.usage_kind === "causal" &&
      receipt.weight > 0 &&
      Date.parse(receipt.occurred_at) <= asOfMs &&
      Date.parse(receipt.recorded_at) <= asOfMs
    ) {
      const key = receiptIndexKey(receipt.workspace_id, receipt.downstream_ref);
      const bucket = indexed.get(key) ?? [];
      bucket.push(receipt);
      indexed.set(key, bucket);
    }
  }
  return indexed;
}

function receiptsForPath(
  path: Readonly<PathRelation>,
  indexed: ReadonlyMap<string, readonly Readonly<CausalUsageReceipt>[]>
): readonly Readonly<CausalUsageReceipt>[] {
  const refs = [
    path.path_id,
    getPathAnchorBackingObjectId(path.anchors.source_anchor),
    getPathAnchorBackingObjectId(path.anchors.target_anchor)
  ];
  const unique = new Map<string, Readonly<CausalUsageReceipt>>();
  for (const ref of refs) {
    for (const receipt of indexed.get(receiptIndexKey(path.workspace_id, ref)) ?? []) {
      unique.set(receipt.identity, receipt);
    }
  }
  return Object.freeze([...unique.values()]);
}

function receiptIndexKey(workspaceId: string, downstreamRef: string): string {
  return `${workspaceId}\u0000${downstreamRef}`;
}

function latestOccurredAt(receipts: readonly Readonly<CausalUsageReceipt>[]): string {
  return receipts.reduce((latest, receipt) =>
    Date.parse(receipt.occurred_at) > Date.parse(latest) ? receipt.occurred_at : latest,
  receipts[0]!.occurred_at);
}
