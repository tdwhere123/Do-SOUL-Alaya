import {
  verifyCausalUsageReceipt,
  type CausalUsagePort,
  type CausalUsageReceipt
} from "@do-soul/alaya-protocol";
import { buildCausalUsageReceipt, usageIdentitySha256 } from "./causal-usage-identity.js";

export class InMemoryCausalUsageRecorder implements CausalUsagePort {
  private readonly byIdentity = new Map<string, CausalUsageReceipt>();

  public recordUsage(input: CausalUsageReceipt): CausalUsageReceipt {
    const receipt = verifyCausalUsageReceipt(input, usageIdentitySha256);
    const existing = this.byIdentity.get(receipt.identity);
    if (existing !== undefined) return existing;
    this.byIdentity.set(receipt.identity, receipt);
    return receipt;
  }

  public list(): readonly CausalUsageReceipt[] {
    return Object.freeze([...this.byIdentity.values()]);
  }
}

export function recordCausalUsedReceipts(
  port: CausalUsagePort,
  input: Readonly<{
    readonly workspaceId: string;
    readonly deliveryId: string;
    readonly usedObjectIds: readonly string[];
    readonly occurredAt: string;
    readonly scope: string;
  }>
): readonly CausalUsageReceipt[] {
  return Object.freeze(input.usedObjectIds.map((objectId) =>
    port.recordUsage(buildCausalUsageReceipt({
      workspaceId: input.workspaceId,
      causalKey: `${input.deliveryId}:${objectId}`,
      downstreamRef: objectId,
      occurredAt: input.occurredAt,
      scope: input.scope,
      usageKind: "causal"
    }))
  ));
}
