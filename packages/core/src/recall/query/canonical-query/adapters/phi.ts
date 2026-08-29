import { digestRecallFieldIdentity, type RecallFieldDigest } from
  "../../../field/field-identity.js";
import { isSnapshotDigest } from
  "../../../runtime/snapshot-coherence/digest.js";
import {
  type CanonicalAnswerProgramV1,
  type CanonicalEvidenceProvenanceV1,
  type CanonicalPredicateV1,
  type CanonicalQueryV1
} from "../types.js";
import { validateCanonicalQueryV1 } from "../validate.js";

export type AdapterUnresolved = {
  readonly code: string;
  readonly source: string;
  readonly capture_digest?: RecallFieldDigest;
  readonly detail?: string;
};

export type AdapterSink = {
  readonly hypotheses: CanonicalQueryV1[];
  readonly hypothesis_provenance: CanonicalEvidenceProvenanceV1[];
  readonly unresolved: AdapterUnresolved[];
  readonly provenance: string[];
};

export function unaryPredicate(
  id: string,
  relation: string,
  provenance: CanonicalEvidenceProvenanceV1
): CanonicalPredicateV1 {
  return Object.freeze({
    id,
    relation,
    arguments: Object.freeze(["x0"]),
    provenance: Object.freeze(provenance)
  });
}

export function pushSupportedQuery(
  predicates: readonly CanonicalPredicateV1[],
  answer: CanonicalAnswerProgramV1,
  provenance: CanonicalEvidenceProvenanceV1,
  sink: AdapterSink,
  source: string
): boolean {
  if (predicates.length === 0) return false;
  const result = validateCanonicalQueryV1({
    variables: [{ name: "x0", sort: "entity" }],
    predicates,
    answer
  });
  if (result.status !== "supported") {
    pushUnresolved(sink.unresolved, {
      code: result.reason_code,
      source,
      detail: result.message
    });
    return false;
  }
  sink.hypotheses.push(result.query);
  sink.hypothesis_provenance.push(Object.freeze(provenance));
  if (!sink.provenance.includes(source)) sink.provenance.push(source);
  return true;
}

export function captureDigest(capture: object): RecallFieldDigest {
  const digest = (capture as { readonly capture_digest?: unknown }).capture_digest;
  if (typeof digest === "string" && isSnapshotDigest(digest)) return digest;
  return digestRecallFieldIdentity(capture);
}

export function pushUnresolved(
  unresolved: AdapterUnresolved[],
  item: AdapterUnresolved
): void {
  const exists = unresolved.some((row) =>
    row.code === item.code
    && row.source === item.source
    && row.detail === item.detail
    && row.capture_digest === item.capture_digest
  );
  if (exists) return;
  unresolved.push(Object.freeze(item));
}

export function normalizeRelationToken(value: string): string {
  return value.trim().replace(/\s+/gu, " ").toLocaleLowerCase();
}
