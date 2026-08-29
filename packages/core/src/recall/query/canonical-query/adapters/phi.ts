import { digestRecallFieldIdentity, type RecallFieldDigest } from
  "../../../field/field-identity.js";
import { isSnapshotDigest } from
  "../../../runtime/snapshot-coherence/digest.js";
import {
  type CanonicalAnswerProgramV1,
  type CanonicalConstantV1,
  type CanonicalEvidenceProvenanceV1,
  type CanonicalPredicateV1,
  type CanonicalQueryV1,
  type CanonicalVariableV1
} from "../types.js";
import { validateCanonicalQueryV1 } from "../validate.js";

export type AdapterUnresolved = {
  readonly code: string;
  readonly source: string;
  readonly capture_digest?: RecallFieldDigest;
  readonly hypothesis_digest?: RecallFieldDigest;
  readonly detail?: string;
};

export type AdapterSink = {
  readonly hypotheses: CanonicalQueryV1[];
  readonly hypothesis_provenance: CanonicalEvidenceProvenanceV1[];
  readonly unresolved: AdapterUnresolved[];
  readonly provenance: string[];
};

export function naryPredicate(
  id: string,
  relation: string,
  args: readonly string[],
  provenance: CanonicalEvidenceProvenanceV1
): CanonicalPredicateV1 {
  return Object.freeze({
    id,
    relation,
    arguments: Object.freeze([...args]),
    provenance: Object.freeze({ ...provenance })
  });
}

export function entityConstantsFrom(
  terms: readonly string[]
): readonly CanonicalConstantV1[] {
  const seen = new Set<string>();
  const constants: CanonicalConstantV1[] = [];
  for (const term of terms) {
    if (term.length === 0 || term.trim() !== term || seen.has(term)) continue;
    seen.add(term);
    constants.push(Object.freeze({ name: term, sort: "entity" as const, value: term }));
  }
  return constants;
}

export function pushSupportedQuery(
  predicates: readonly CanonicalPredicateV1[],
  answer: CanonicalAnswerProgramV1,
  provenance: CanonicalEvidenceProvenanceV1,
  sink: AdapterSink,
  source: string,
  terms?: Readonly<{
    readonly variables?: readonly CanonicalVariableV1[];
    readonly constants?: readonly CanonicalConstantV1[];
  }>
): boolean {
  if (predicates.length === 0) return false;
  const result = validateCanonicalQueryV1({
    variables: terms?.variables ?? [{ name: "x0", sort: "entity" }],
    constants: terms?.constants ?? [],
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
    && row.hypothesis_digest === item.hypothesis_digest
  );
  if (exists) return;
  unresolved.push(Object.freeze(item));
}

export function normalizeRelationToken(value: string): string {
  return value.trim().replace(/\s+/gu, " ").toLowerCase();
}
