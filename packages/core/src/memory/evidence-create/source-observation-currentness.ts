import {
  compareUtcInstants,
  formatFieldContractDigest,
  hashContentDigest,
  normalizeMemoryObjectKeySurface,
  type FieldContractSha256,
  type SourceLocatedInterpretation,
  type SourceScopeClass
} from "@do-soul/alaya-protocol";
import { CoreError } from "../../shared/errors.js";
import type { AuditedSourceAdmission } from "./audited-source-admission.js";
import type { FieldFormationStores, StoredSourceRecord } from "./field-stores.js";
import {
  sourceSpanFromCodeUnitOffsets,
  type SourceSpanDraft
} from "./source-span-views.js";

type BoundPhrase = SourceLocatedInterpretation["candidates"][number]["predicate"];

export function resolveCurrentSource(
  stores: Pick<FieldFormationStores, "listRecords" | "getStoredRecord">,
  workspaceId: string,
  located: SourceLocatedInterpretation,
  sha256: FieldContractSha256
): StoredSourceRecord {
  const expectedDigest = formatFieldContractDigest(located.source_corpus_digest);
  const records = stores.listRecords(workspaceId).filter(
    (row) => row.source_id === located.artifact_key
  );
  if (records.length === 0) {
    throw new CoreError("VALIDATION", "source is not currently admitted");
  }
  const current = records.reduce(newerRecord);
  const stored = stores.getStoredRecord(workspaceId, current.identity);
  if (stored === null) {
    throw new CoreError("VALIDATION", "current source body is not available");
  }
  if (stored.record.content_digest !== expectedDigest) {
    throw new CoreError("VALIDATION", "source digest is not current");
  }
  if (hashContentDigest(stored.content_bytes, sha256) !== stored.record.content_digest) {
    throw new CoreError("OBLIGATION_VIOLATION", "stored source body does not match its digest");
  }
  if (sha256(stored.content_bytes) !== located.source_corpus_digest) {
    throw new CoreError("VALIDATION", "located corpus digest does not match current source");
  }
  return stored;
}

export function verifyAssertionAndScope(
  stored: StoredSourceRecord,
  workspaceId: string,
  scopeHint: string | null,
  located: SourceLocatedInterpretation
): SourceScopeClass {
  if (stored.record.workspace_id !== workspaceId) {
    throw new CoreError("VALIDATION", "source workspace differs from the observation signal");
  }
  const scope = resolvePublishedScope(stored, scopeHint);
  const [start, end] = located.assertion_binding.source_span;
  if (stored.content_bytes.slice(start, end) !== located.assertion_binding.text) {
    throw new CoreError("VALIDATION", "assertion binding does not match current source");
  }
  for (const candidate of located.candidates) {
    verifyPhrase(stored.content_bytes, located.assertion_binding.source_span, candidate.predicate);
    for (const role of [...candidate.arguments, ...candidate.qualifiers]) {
      verifyPhrase(stored.content_bytes, located.assertion_binding.source_span, role.phrase);
    }
  }
  return scope;
}

function resolvePublishedScope(
  stored: StoredSourceRecord,
  scopeHint: string | null
): SourceScopeClass {
  const hint = parseScopeHint(scopeHint);
  const sourceScope = stored.record.scope_class;
  if (sourceScope !== undefined && sourceScope !== null) {
    if (hint !== null && hint !== sourceScope) {
      throw new CoreError("VALIDATION", "source scope is not current");
    }
    return sourceScope;
  }
  if (hint === "global_core" || hint === "global_domain") {
    throw new CoreError("VALIDATION", "sourceless scope hint cannot publish a global scope");
  }
  return hint ?? "project";
}

export function durableInterpretation(
  content: string,
  located: SourceLocatedInterpretation
): SourceLocatedInterpretation {
  return {
    ...located,
    assertion_binding: {
      ...located.assertion_binding,
      source_span: durableOffsets(content, located.assertion_binding.source_span)
    },
    candidates: located.candidates.map((candidate) => ({
      ...candidate,
      predicate: durablePhrase(content, candidate.predicate),
      arguments: candidate.arguments.map((role) => ({
        ...role,
        phrase: durablePhrase(content, role.phrase)
      })),
      qualifiers: candidate.qualifiers.map((role) => ({
        ...role,
        phrase: durablePhrase(content, role.phrase)
      }))
    }))
  };
}

export async function admitLocatedSpans(
  admission: AuditedSourceAdmission,
  stored: StoredSourceRecord,
  durable: SourceLocatedInterpretation
): Promise<void> {
  await admission.admit({
    workspace_id: stored.record.workspace_id,
    source_id: stored.record.source_id,
    source_version: stored.record.source_version,
    content_bytes: stored.content_bytes,
    evidence_object_id: stored.record.evidence_object_id,
    recorded_at: stored.record.recorded_at,
    event_time: stored.record.event_time,
    valid_from: stored.record.valid_from,
    valid_to: stored.record.valid_to,
    ...(stored.record.speaker === undefined ? {} : { speaker: stored.record.speaker }),
    ...(stored.record.scope_class === undefined ? {} : { scope_class: stored.record.scope_class }),
    spans: uniqueSpans(spanDrafts(durable))
  }, { workspaceId: stored.record.workspace_id });
}

function newerRecord<T extends { readonly recorded_at: string; readonly identity: string }>(
  left: T,
  right: T
): T {
  const order = compareUtcInstants(left.recorded_at, right.recorded_at);
  if (order === 1) return left;
  if (order === -1) return right;
  return left.identity >= right.identity ? left : right;
}

function parseScopeHint(scopeHint: string | null): SourceScopeClass | null {
  if (scopeHint === null) return null;
  if (scopeHint === "global_core" || scopeHint === "global_domain" || scopeHint === "project") {
    return scopeHint;
  }
  throw new CoreError("VALIDATION", "unknown scope_hint");
}

function verifyPhrase(
  content: string,
  assertion: readonly [number, number],
  phrase: BoundPhrase
): void {
  if (phrase.source_span[0] < assertion[0] || phrase.source_span[1] > assertion[1]) {
    throw new CoreError("VALIDATION", "phrase span is outside the assertion context");
  }
  const [start, end] = phrase.source_span;
  if (content.slice(start, end) !== phrase.text) {
    throw new CoreError("VALIDATION", "candidate phrase does not match current source");
  }
  if (normalizeMemoryObjectKeySurface(phrase.text) !== phrase.lookup_key) {
    throw new CoreError("VALIDATION", "candidate lookup_key does not match current source");
  }
}

function durablePhrase(content: string, phrase: BoundPhrase): BoundPhrase {
  return {
    ...phrase,
    source_span: durableOffsets(content, phrase.source_span),
    lookup_key: normalizeMemoryObjectKeySurface(phrase.text)
  };
}

function durableOffsets(content: string, span: readonly [number, number]): readonly [number, number] {
  const converted = sourceSpanFromCodeUnitOffsets(content, {
    start_offset: span[0],
    end_offset: span[1],
    purpose: "proposed_subspan"
  });
  return [converted.start_offset, converted.end_offset];
}

function spanDrafts(durable: SourceLocatedInterpretation): readonly SourceSpanDraft[] {
  return [
    {
      start_offset: durable.assertion_binding.source_span[0],
      end_offset: durable.assertion_binding.source_span[1],
      purpose: "proposed_subspan"
    },
    ...durable.candidates.flatMap((candidate) => [
      {
        start_offset: candidate.predicate.source_span[0],
        end_offset: candidate.predicate.source_span[1],
        purpose: "proposed_subspan" as const
      },
      ...[...candidate.arguments, ...candidate.qualifiers].map((role) => ({
        start_offset: role.phrase.source_span[0],
        end_offset: role.phrase.source_span[1],
        purpose: "proposed_subspan" as const
      }))
    ])
  ];
}

function uniqueSpans(spans: readonly SourceSpanDraft[]): readonly SourceSpanDraft[] {
  const seen = new Set<string>();
  const unique: SourceSpanDraft[] = [];
  for (const span of spans) {
    const key = `${span.start_offset}:${span.end_offset}:${span.purpose}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(span);
  }
  return unique;
}
