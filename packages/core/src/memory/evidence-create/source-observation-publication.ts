import {
  BoundSourceInterpretationSchema,
  EvidenceHealthState,
  FormationKind,
  MemoryDimension,
  SourceInterpretationSignalSchema,
  SourceKind,
  formatFieldContractDigest,
  hashContentDigest,
  sourceRecallTarget,
  type BoundSourceInterpretation,
  type EvidenceCapsule,
  type FieldContractSha256,
  type MemoryEntry,
  type SourceDeliveredSpan,
  type SourceInterpretationSignal,
  type SourceLocatedInterpretation,
  type SourceScopeClass
} from "@do-soul/alaya-protocol";
import { CoreError } from "../../shared/errors.js";
import type { AuditedSourceAdmission } from "./audited-source-admission.js";
import type { EvidenceService } from "../evidence-service.js";
import type { MemoryService } from "../memory-service.js";
import type { FieldFormationStores, StoredSourceRecord } from "./field-stores.js";
import {
  sourceSpanFromCodeUnitOffsets,
  type SourceSpanDraft
} from "./source-span-views.js";

export type SourceObservationPublicationInput = Readonly<{
  readonly signal: SourceInterpretationSignal;
  readonly sourceEventAnchor: Readonly<{
    readonly event_type: "soul.signal.emitted";
    readonly event_id: string;
    readonly occurred_at: string;
  }> | null;
}>;

export type SourceObservationPublicationResult = Readonly<{
  readonly bound: BoundSourceInterpretation;
  readonly evidence: Readonly<EvidenceCapsule>;
  readonly memory: Readonly<MemoryEntry>;
}>;

export type SourceObservationPublication = Readonly<{
  publish(input: SourceObservationPublicationInput): Promise<SourceObservationPublicationResult>;
}>;

type ObservationEvidencePort = Pick<
  EvidenceService,
  "create" | "findByIdScoped" | "findByWorkspaceId"
>;
type ObservationMemoryPort = Pick<
  MemoryService,
  "create" | "findByIdScoped" | "findByDimensionAll"
>;

/** Core admission for located source observations. Protocol location cannot mint source_target. */
export function createSourceObservationPublication(input: Readonly<{
  readonly stores: FieldFormationStores;
  readonly sourceAdmission: AuditedSourceAdmission;
  readonly evidenceService: ObservationEvidencePort;
  readonly memoryService: ObservationMemoryPort;
  readonly sha256: FieldContractSha256;
}>): SourceObservationPublication {
  return {
    async publish(request) {
      const signal = SourceInterpretationSignalSchema.parse(request.signal);
      if (signal.source !== "garden_compile") {
        throw new CoreError("VALIDATION", "source observation producer is not trusted");
      }
      const located = signal.raw_payload.source_interpretation;
      const stored = resolveCurrentSource(
        input.stores,
        signal.workspace_id,
        located,
        input.sha256
      );
      verifyAssertionAndScope(stored, signal, located);
      const assertionSpan = durableSpan(stored.content_bytes, located.assertion_binding.source_span);
      await admitLocatedSpans(input.sourceAdmission, stored, located, assertionSpan);
      const bound = bindInterpretation(located, stored, assertionSpan, null);
      const existing = await findExistingPublication(
        input.evidenceService,
        input.memoryService,
        signal.workspace_id,
        bound
      );
      if (existing !== null) return existing;
      return await persistObservation(input, signal, request.sourceEventAnchor, bound);
    }
  };
}

function resolveCurrentSource(
  stores: FieldFormationStores,
  workspaceId: string,
  located: SourceLocatedInterpretation,
  sha256: FieldContractSha256
): StoredSourceRecord {
  const expectedDigest = formatFieldContractDigest(located.source_corpus_digest);
  const live = stores.listStoredRecords(workspaceId).filter(
    (row) => row.record.source_id === located.artifact_key
  );
  if (live.length === 0) {
    throw new CoreError("VALIDATION", "source is not currently admitted");
  }
  const current = live.reduce(newerSource);
  if (current.record.content_digest !== expectedDigest) {
    throw new CoreError("VALIDATION", "source digest is not current");
  }
  if (hashContentDigest(current.content_bytes, sha256) !== current.record.content_digest) {
    throw new CoreError("OBLIGATION_VIOLATION", "stored source body does not match its digest");
  }
  if (sha256(current.content_bytes) !== located.source_corpus_digest) {
    throw new CoreError("VALIDATION", "located corpus digest does not match current source");
  }
  return current;
}

function newerSource(left: StoredSourceRecord, right: StoredSourceRecord): StoredSourceRecord {
  if (left.record.recorded_at > right.record.recorded_at) return left;
  if (left.record.recorded_at < right.record.recorded_at) return right;
  return left.record.identity >= right.record.identity ? left : right;
}

function verifyAssertionAndScope(
  stored: StoredSourceRecord,
  signal: SourceInterpretationSignal,
  located: SourceLocatedInterpretation
): void {
  if (stored.record.workspace_id !== signal.workspace_id) {
    throw new CoreError("VALIDATION", "source workspace differs from the observation signal");
  }
  const scope = scopeClassFromHint(signal.scope_hint);
  if (stored.record.scope_class !== undefined && stored.record.scope_class !== scope) {
    throw new CoreError("VALIDATION", "source scope is not current");
  }
  const [start, end] = located.assertion_binding.source_span;
  if (stored.content_bytes.slice(start, end) !== located.assertion_binding.text) {
    throw new CoreError("VALIDATION", "assertion binding does not match current source");
  }
  for (const candidate of located.candidates) {
    assertPhraseInAssertion(located.assertion_binding.source_span, candidate.predicate.source_span);
    for (const role of [...candidate.arguments, ...candidate.qualifiers]) {
      assertPhraseInAssertion(located.assertion_binding.source_span, role.phrase.source_span);
    }
  }
}

function assertPhraseInAssertion(
  assertion: readonly [number, number],
  phrase: readonly [number, number]
): void {
  if (phrase[0] < assertion[0] || phrase[1] > assertion[1]) {
    throw new CoreError("VALIDATION", "phrase span is outside the assertion context");
  }
}

function durableSpan(content: string, span: readonly [number, number]): SourceSpanDraft {
  return sourceSpanFromCodeUnitOffsets(content, {
    start_offset: span[0],
    end_offset: span[1],
    purpose: "proposed_subspan"
  });
}

async function admitLocatedSpans(
  admission: AuditedSourceAdmission,
  stored: StoredSourceRecord,
  located: SourceLocatedInterpretation,
  assertionSpan: SourceSpanDraft
): Promise<void> {
  const drafts = uniqueSpans([
    assertionSpan,
    ...located.candidates.flatMap((candidate) => [
      durableSpan(stored.content_bytes, candidate.predicate.source_span),
      ...[...candidate.arguments, ...candidate.qualifiers].map((role) =>
        durableSpan(stored.content_bytes, role.phrase.source_span)
      )
    ])
  ]);
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
    spans: drafts
  }, { workspaceId: stored.record.workspace_id });
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

function bindInterpretation(
  located: SourceLocatedInterpretation,
  stored: StoredSourceRecord,
  assertionSpan: SourceSpanDraft,
  evidenceObjectId: string | null
): BoundSourceInterpretation {
  const span: SourceDeliveredSpan = {
    content_start: assertionSpan.start_offset,
    content_end: assertionSpan.end_offset,
    retained_extent: "body",
    content_complete: true,
    original_complete: true
  };
  return BoundSourceInterpretationSchema.parse({
    ...located,
    source_target: sourceRecallTarget({
      workspace_id: stored.record.workspace_id,
      root_kind: "source_record",
      root_id: stored.record.identity,
      source_version: stored.record.source_version,
      content_digest: stored.record.content_digest,
      evidence_object_id: evidenceObjectId,
      span
    })
  });
}

async function findExistingPublication(
  evidenceService: ObservationEvidencePort,
  memoryService: ObservationMemoryPort,
  workspaceId: string,
  bound: BoundSourceInterpretation
): Promise<SourceObservationPublicationResult | null> {
  const memories = await memoryService.findByDimensionAll(workspaceId, MemoryDimension.OBSERVATION);
  for (const memory of memories) {
    const evidenceId = memory.evidence_refs[0];
    if (memory.content !== bound.assertion_binding.text || evidenceId === undefined) continue;
    const evidence = await evidenceService.findByIdScoped(evidenceId, workspaceId);
    if (evidence === null || !sameBoundPublication(parseBoundGist(evidence.gist), bound)) continue;
    return Object.freeze({
      bound: attachEvidenceId(bound, evidence.object_id),
      evidence,
      memory
    });
  }
  return null;
}

async function persistObservation(
  input: Readonly<{
    readonly evidenceService: ObservationEvidencePort;
    readonly memoryService: ObservationMemoryPort;
  }>,
  signal: SourceInterpretationSignal,
  sourceEventAnchor: SourceObservationPublicationInput["sourceEventAnchor"],
  bound: BoundSourceInterpretation
): Promise<SourceObservationPublicationResult> {
  const evidence = await findOrCreateEvidence(input.evidenceService, signal, sourceEventAnchor, bound);
  try {
    const memory = await input.memoryService.create({
      created_by: signal.source,
      dimension: MemoryDimension.OBSERVATION,
      source_kind: SourceKind.COMPILER,
      formation_kind: FormationKind.EXTRACTED,
      scope_class: scopeClassFromHint(signal.scope_hint),
      content: bound.assertion_binding.text,
      domain_tags: signal.domain_tags,
      evidence_refs: [evidence.object_id],
      workspace_id: signal.workspace_id,
      run_id: signal.run_id,
      surface_id: signal.surface_id
    });
    return Object.freeze({
      bound: attachEvidenceId(bound, evidence.object_id),
      evidence,
      memory
    });
  } catch (error) {
    throw new CoreError(
      "CONFLICT",
      "source observation memory write interrupted after evidence creation",
      { cause: error }
    );
  }
}

async function findOrCreateEvidence(
  evidenceService: ObservationEvidencePort,
  signal: SourceInterpretationSignal,
  sourceEventAnchor: SourceObservationPublicationInput["sourceEventAnchor"],
  bound: BoundSourceInterpretation
): Promise<Readonly<EvidenceCapsule>> {
  const existing = await findExistingEvidence(evidenceService, signal.workspace_id, bound);
  if (existing !== null) return existing;
  const assertion = bound.assertion_binding.text;
  return await evidenceService.create({
    created_by: signal.source,
    evidence_kind: "conversation_excerpt",
    semantic_anchor: {
      topic: assertion,
      keywords: [...signal.domain_tags],
      summary: assertion
    },
    event_anchor: sourceEventAnchor === null ? null : {
      event_type: sourceEventAnchor.event_type,
      event_id: sourceEventAnchor.event_id,
      occurred_at: sourceEventAnchor.occurred_at
    },
    physical_anchor: {
      file_path: null,
      line_range: null,
      symbol_name: null,
      artifact_ref: null
    },
    evidence_health_state: EvidenceHealthState.QUESTIONABLE,
    gist: JSON.stringify(bound),
    excerpt: assertion,
    source_hash: bound.source_target.content_digest,
    run_id: signal.run_id,
    workspace_id: signal.workspace_id,
    surface_id: signal.surface_id
  });
}

async function findExistingEvidence(
  evidenceService: ObservationEvidencePort,
  workspaceId: string,
  bound: BoundSourceInterpretation
): Promise<Readonly<EvidenceCapsule> | null> {
  const capsules = await evidenceService.findByWorkspaceId(workspaceId);
  for (const capsule of capsules) {
    if (sameBoundPublication(parseBoundGist(capsule.gist), bound)) return capsule;
  }
  return null;
}

function parseBoundGist(gist: string): BoundSourceInterpretation | null {
  try {
    const parsed = BoundSourceInterpretationSchema.safeParse(JSON.parse(gist));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function sameBoundPublication(
  existing: BoundSourceInterpretation | null,
  bound: BoundSourceInterpretation
): boolean {
  return existing !== null &&
    existing.assertion_binding.context_id === bound.assertion_binding.context_id &&
    existing.outcome === bound.outcome &&
    existing.source_target.root_id === bound.source_target.root_id &&
    existing.source_target.source_version === bound.source_target.source_version &&
    existing.source_target.content_digest === bound.source_target.content_digest &&
    JSON.stringify(existing.candidates) === JSON.stringify(bound.candidates) &&
    JSON.stringify(existing.diagnostics) === JSON.stringify(bound.diagnostics);
}

function attachEvidenceId(
  bound: BoundSourceInterpretation,
  evidenceObjectId: string
): BoundSourceInterpretation {
  return BoundSourceInterpretationSchema.parse({
    ...bound,
    source_target: {
      ...bound.source_target,
      evidence_object_id: evidenceObjectId
    }
  });
}

function scopeClassFromHint(scopeHint: string | null): SourceScopeClass {
  if (scopeHint === "global_core" || scopeHint === "global_domain" || scopeHint === "project") {
    return scopeHint;
  }
  return "project";
}
