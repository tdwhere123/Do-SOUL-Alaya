import {
  verifyCausalUsageReceipt,
  type CausalUsagePort,
  type CausalUsageReceipt
} from "@do-soul/alaya-protocol";
import type { EventPublisher } from "@do-soul/alaya-core";
import { buildCausalUsageRecordedEvent } from "../../runtime/field/usage-audit.js";
import { buildCausalUsageReceipt, usageIdentitySha256 } from "./causal-usage-identity.js";

export class InMemoryCausalUsageRecorder implements CausalUsagePort {
  private readonly byIdentity = new Map<string, CausalUsageReceipt>();

  public recordUsage(input: CausalUsageReceipt) {
    const receipt = verifyCausalUsageReceipt(input, usageIdentitySha256);
    const existing = this.byIdentity.get(receipt.identity);
    if (existing !== undefined) return Object.freeze({ receipt: existing, inserted: false });
    this.byIdentity.set(receipt.identity, receipt);
    return Object.freeze({ receipt, inserted: true });
  }

  public list(): readonly CausalUsageReceipt[] {
    return Object.freeze([...this.byIdentity.values()]);
  }
}

export async function recordCausalUsedReceipts(
  port: CausalUsagePort,
  input: Readonly<{
    readonly workspaceId: string;
    readonly causalKey: string;
    readonly usedObjectIds: readonly string[];
    readonly occurredAt: string;
    readonly scope: string;
    readonly eventPublisher: Pick<EventPublisher, "mutateThenAppendMany">;
    readonly runId?: string | null;
    readonly causedBy?: string | null;
  }>
): Promise<readonly CausalUsageReceipt[]> {
  if (input.usedObjectIds.length === 0) return Object.freeze([]);
  const candidates = input.usedObjectIds.map((objectId) => buildCausalUsageReceipt({
      workspaceId: input.workspaceId,
      causalKey: input.causalKey,
      downstreamRef: objectId,
      occurredAt: input.occurredAt,
      scope: input.scope,
      usageKind: "causal"
    }));
  const persisted = await input.eventPublisher.mutateThenAppendMany(() => {
    const results = candidates.map((candidate) => port.recordUsage(candidate));
    return {
      events: results.filter((result) => result.inserted)
        .map((result) => buildCausalUsageRecordedEvent(result.receipt, input)),
      result: results.map((result) => result.receipt)
    };
  });
  return Object.freeze(persisted.result);
}
