import { digestRecallFieldIdentity, type RecallFieldDigest } from
  "../../field/field-identity.js";

const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;

export function isSnapshotDigest(value: string): value is RecallFieldDigest {
  return SHA256.test(value);
}

export function unavailableProducerDigest(owner: string): RecallFieldDigest {
  return digestRecallFieldIdentity({
    status: "producer_receipt_unavailable",
    owner
  });
}

export function isSnapshotInstant(value: string): boolean {
  return INSTANT.test(value) && Number.isFinite(Date.parse(value));
}
