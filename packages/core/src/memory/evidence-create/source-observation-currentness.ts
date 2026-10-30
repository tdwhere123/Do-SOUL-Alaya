import { compareUtcInstants, formatFieldContractDigest, type FieldContractSha256 } from "@do-soul/alaya-protocol";
import { CoreError } from "../../shared/errors.js";
import type { FieldFormationStores, StoredSourceRecord } from "./field-stores.js";

/** Shared source currentness for statement publication and explicit caller-authored interpretations. */
export function resolveCurrentSource(
  stores: Pick<FieldFormationStores, "getCurrentRecord" | "getStoredRecord">,
  workspaceId: string,
  located: Readonly<{ artifact_key: string; source_corpus_digest: string }>,
  sha256: FieldContractSha256
): StoredSourceRecord {
  const expectedDigest = formatFieldContractDigest(located.source_corpus_digest);
  const current = stores.getCurrentRecord(workspaceId, located.artifact_key);
  if (current === null) throw new CoreError("VALIDATION", "source is not currently admitted", {
    details: { admission: "no_eligible_source" }
  });
  const stored = stores.getStoredRecord(workspaceId, current.identity);
  if (stored === null) throw new CoreError("VALIDATION", "current source body is not available", {
    details: { admission: "unavailable", unavailable: "source_body" }
  });
  if (stored.record.content_digest !== expectedDigest) throw new CoreError("VALIDATION", "source digest is not current", {
    details: { admission: "filtered" }
  });
  const bodyDigest = sha256(stored.content_bytes);
  if (formatFieldContractDigest(bodyDigest) !== stored.record.content_digest) {
    throw new CoreError("OBLIGATION_VIOLATION", "stored source body does not match its digest");
  }
  if (bodyDigest !== located.source_corpus_digest) throw new CoreError("VALIDATION", "located corpus digest does not match current source");
  return stored;
}
export function newerSourceRecord<T extends { readonly recorded_at: string; readonly identity: string }>(left: T, right: T): T {
  const order = compareUtcInstants(left.recorded_at, right.recorded_at);
  if (order === undefined) throw new CoreError("OBLIGATION_VIOLATION", "source currentness requires valid UTC instants");
  if (order === 1) return left;
  if (order === -1) return right;
  return left.identity >= right.identity ? left : right;
}
