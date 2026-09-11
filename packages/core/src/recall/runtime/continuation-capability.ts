import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { Continuation } from "@do-soul/alaya-protocol";
import { stableStringify } from "../../shared/stable-stringify.js";

const SECRET = randomBytes(32);

const ISSUED_FIELDS = [
  "schema_version",
  "continuation_id",
  "query_id",
  "snapshot_id",
  "result_version",
  "expires_at",
  "cursor",
  "interpretation_id",
  "interpretation_clock",
  "enumeration_policy",
  "result_kind_view",
  "authorized_scopes",
  "emitted_revisions",
  "cap_contracts",
  "claim_demands",
  "protocol_version",
  "supported_result_kinds"
] as const;

export function mintContinuationCapability(continuationId: string): string {
  return createHmac("sha256", SECRET).update(continuationId, "utf8").digest("hex");
}

export function continuationCapabilityMatches(continuation: Continuation): boolean {
  const received = continuation.capability;
  if (received === undefined) return false;
  const expected = mintContinuationCapability(continuation.continuation_id);
  const left = Buffer.from(expected, "utf8");
  const right = Buffer.from(received, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function sealIssuedContinuation(continuation: Continuation): Continuation {
  const continuation_id = randomUUID();
  return {
    ...continuation,
    continuation_id,
    capability: mintContinuationCapability(continuation_id)
  };
}

export function issuedContinuationTampered(client: Continuation, issued: Continuation): boolean {
  for (const key of ISSUED_FIELDS) {
    const value = client[key];
    if (value === undefined) continue;
    if (stableStringify(value) !== stableStringify(issued[key])) return true;
  }
  return false;
}
