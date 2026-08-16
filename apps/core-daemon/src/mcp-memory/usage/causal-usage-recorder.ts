import {
  verifyCausalUsageReceipt,
  type CausalUsagePort,
  type CausalUsageReceipt,
  type EventLogEntry
} from "@do-soul/alaya-protocol";
import { appendCausalUsageRecorded } from "../../runtime/field/usage-audit.js";
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
    readonly eventLog?: {
      append(event: Omit<EventLogEntry, "event_id" | "created_at" | "revision">):
        EventLogEntry | Promise<EventLogEntry>;
    };
  }>
): readonly CausalUsageReceipt[] {
  return Object.freeze(input.usedObjectIds.map((objectId) => {
    const receipt = port.recordUsage(buildCausalUsageReceipt({
      workspaceId: input.workspaceId,
      causalKey: `${input.deliveryId}:${objectId}`,
      downstreamRef: objectId,
      occurredAt: input.occurredAt,
      scope: input.scope,
      usageKind: "causal"
    }));
    if (input.eventLog !== undefined) {
      appendCausalUsageRecorded(input.eventLog, receipt);
    }
    return receipt;
  }));
}
