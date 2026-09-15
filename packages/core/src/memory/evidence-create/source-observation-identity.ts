import {
  BoundSourceInterpretationSchema,
  EvidenceHealthState,
  FormationKind,
  MemoryDimension,
  SourceKind,
  canonicalJson,
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
import type { EvidenceService } from "../evidence-service.js";
import type { MemoryService } from "../memory-service.js";
import type { StoredSourceRecord } from "./field-stores.js";

export type ObservationEvidencePort = Pick<
  EvidenceService,
  "create" | "findByIdScoped"
>;
export type ObservationMemoryPort = Pick<
  MemoryService,
  "create" | "findByIdScoped"
>;

export type ObservationTemporalProjection = Partial<Pick<
  Parameters<ObservationMemoryPort["create"]>[0],
  "event_time_start" | "event_time_end" | "valid_from" | "valid_to" |
  "time_precision" | "time_source" | "projection_schema_version"
>>;

export type SourceObservationIdentity = Readonly<{
  readonly evidenceObjectId: string;
  readonly memoryObjectId: string;
}>;

type SourceEventAnchor = Readonly<{
  readonly event_type: "soul.signal.emitted";
  readonly event_id: string;
  readonly occurred_at: string;
}> | null;

type SourceObservationPublicationResult = Readonly<{
  readonly bound: BoundSourceInterpretation;
  readonly evidence: Readonly<EvidenceCapsule>;
  readonly memory: Readonly<MemoryEntry>;
}>;

export function publicationIdentity(
  stored: StoredSourceRecord,
  durable: SourceLocatedInterpretation,
  sha256: FieldContractSha256
): SourceObservationIdentity {
  const digest = sha256(canonicalJson({
    workspace_id: stored.record.workspace_id,
    root_id: stored.record.identity,
    source_version: stored.record.source_version,
    content_digest: stored.record.content_digest,
    context_id: durable.assertion_binding.context_id,
    outcome: durable.outcome,
    candidates: durable.candidates
  }));
  return Object.freeze({
    evidenceObjectId: uuidFromHex(sha256(`source-observation-evidence:${digest}`)),
    memoryObjectId: uuidFromHex(sha256(`source-observation-memory:${digest}`))
  });
}

export function bindInterpretation(
  durable: SourceLocatedInterpretation,
  stored: StoredSourceRecord,
  evidenceObjectId: string
): BoundSourceInterpretation {
  const span: SourceDeliveredSpan = {
    content_start: durable.assertion_binding.source_span[0],
    content_end: durable.assertion_binding.source_span[1],
    retained_extent: "body",
    content_complete: true,
    original_complete: true
  };
  return BoundSourceInterpretationSchema.parse({
    ...durable,
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

export async function findCompletePublication(
  evidenceService: ObservationEvidencePort,
  memoryService: ObservationMemoryPort,
  workspaceId: string,
  identity: SourceObservationIdentity
): Promise<SourceObservationPublicationResult | null> {
  const memory = await memoryService.findByIdScoped(identity.memoryObjectId, workspaceId);
  const evidence = await evidenceService.findByIdScoped(identity.evidenceObjectId, workspaceId);
  if (memory === null || evidence === null) return null;
  const bound = parseBoundGist(evidence.gist);
  if (bound === null) {
    throw new CoreError("OBLIGATION_VIOLATION", "published observation gist is not a bound interpretation");
  }
  return Object.freeze({ bound, evidence, memory });
}

export async function publicationReservationExists(
  evidenceService: ObservationEvidencePort,
  memoryService: ObservationMemoryPort,
  workspaceId: string,
  identity: SourceObservationIdentity
): Promise<boolean> {
  const memory = await memoryService.findByIdScoped(identity.memoryObjectId, workspaceId);
  const evidence = await evidenceService.findByIdScoped(identity.evidenceObjectId, workspaceId);
  return memory !== null || evidence !== null;
}

export async function persistObservation(
  input: Readonly<{
    readonly evidenceService: ObservationEvidencePort;
    readonly memoryService: ObservationMemoryPort;
    readonly assertSourceCurrent: () => void;
    readonly temporalProjection: ObservationTemporalProjection;
  }>,
  signal: SourceInterpretationSignal,
  sourceEventAnchor: SourceEventAnchor,
  bound: BoundSourceInterpretation,
  identity: SourceObservationIdentity,
  scope: SourceScopeClass
): Promise<SourceObservationPublicationResult> {
  const evidence = await findOrCreateEvidence(
    input.evidenceService, signal, sourceEventAnchor, bound, identity.evidenceObjectId, input.assertSourceCurrent
  );
  try {
    const memory = await findOrCreateMemory(
      input.memoryService, signal, bound, evidence.object_id, identity.memoryObjectId, scope, input.assertSourceCurrent, input.temporalProjection
    );
    return Object.freeze({ bound, evidence, memory });
  } catch (error) {
    throw interruptAfterEvidence(error, evidence.object_id);
  }
}

async function findOrCreateEvidence(
  evidenceService: ObservationEvidencePort,
  signal: SourceInterpretationSignal,
  sourceEventAnchor: SourceEventAnchor,
  bound: BoundSourceInterpretation,
  evidenceObjectId: string,
  assertSourceCurrent: () => void
): Promise<Readonly<EvidenceCapsule>> {
  const existing = await evidenceService.findByIdScoped(evidenceObjectId, signal.workspace_id);
  assertSourceCurrent();
  if (existing !== null) return existing;
  const assertion = bound.assertion_binding.text;
  try {
    return await evidenceService.create({
      object_id: evidenceObjectId,
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
    }, [], undefined, undefined, undefined, assertSourceCurrent);
  } catch (error) {
    const raced = await evidenceService.findByIdScoped(evidenceObjectId, signal.workspace_id);
    assertSourceCurrent();
    if (raced !== null) return raced;
    throw error;
  }
}

async function findOrCreateMemory(
  memoryService: ObservationMemoryPort,
  signal: SourceInterpretationSignal,
  bound: BoundSourceInterpretation,
  evidenceObjectId: string,
  memoryObjectId: string,
  scope: SourceScopeClass,
  assertSourceCurrent: () => void,
  temporalProjection: ObservationTemporalProjection
): Promise<Readonly<MemoryEntry>> {
  const existing = await memoryService.findByIdScoped(memoryObjectId, signal.workspace_id);
  assertSourceCurrent();
  if (existing !== null) return existing;
  try {
    return await memoryService.create({
      event_time_start: temporalProjection.event_time_start,
      event_time_end: temporalProjection.event_time_end,
      valid_from: temporalProjection.valid_from,
      valid_to: temporalProjection.valid_to,
      time_precision: temporalProjection.time_precision,
      time_source: temporalProjection.time_source,
      projection_schema_version: temporalProjection.projection_schema_version,
      object_id: memoryObjectId,
      assertSourceCurrent,
      created_by: signal.source,
      dimension: MemoryDimension.OBSERVATION,
      source_kind: SourceKind.COMPILER,
      formation_kind: FormationKind.EXTRACTED,
      scope_class: scope,
      content: bound.assertion_binding.text,
      domain_tags: signal.domain_tags,
      evidence_refs: [evidenceObjectId],
      workspace_id: signal.workspace_id,
      run_id: signal.run_id,
      surface_id: signal.surface_id
    });
  } catch (error) {
    const raced = await memoryService.findByIdScoped(memoryObjectId, signal.workspace_id);
    assertSourceCurrent();
    if (raced !== null) return raced;
    throw error;
  }
}

function parseBoundGist(gist: string): BoundSourceInterpretation | null {
  try {
    const parsed = BoundSourceInterpretationSchema.safeParse(JSON.parse(gist));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function interruptAfterEvidence(error: unknown, evidenceObjectId: string): CoreError {
  const details = Object.freeze({ evidence_object_id: evidenceObjectId });
  if (error instanceof CoreError) {
    return new CoreError(error.code, error.message, {
      cause: error,
      ...(error.subCode === undefined ? {} : { subCode: error.subCode }),
      details: { ...error.details, ...details }
    });
  }
  return new CoreError(
    "CONFLICT",
    "source observation memory write interrupted after evidence creation",
    { cause: error, details }
  );
}

function uuidFromHex(hex: string): string {
  const digits = hex.replace(/[^0-9a-f]/gi, "").toLowerCase().padEnd(32, "0").slice(0, 32).split("");
  digits[12] = "5";
  digits[16] = ((Number.parseInt(digits[16]!, 16) & 0x3) | 0x8).toString(16);
  const id = digits.join("");
  return `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;
}
