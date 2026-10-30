import {
  BoundSourceStatementSchema, canonicalJson, sourceRecallTarget,
  type BoundSourceStatement, type EvidenceCapsule, type FieldContractSha256,
  type MemoryEntry, type SourceStatementSignal, type LocatedSourceStatement, type SourceScopeClass
} from "@do-soul/alaya-protocol";
import { CoreError } from "../../shared/errors.js";
import { SOURCE_PROVENANCE_CAPSULE } from "./create-evidence.js";
import type { EvidenceService } from "../evidence-service.js";
import type { MemoryService } from "../memory-service.js";
import type { StoredSourceRecord } from "./field-stores.js";

export type ObservationEvidencePort = Pick<EvidenceService, "create" | "findByIdScoped">;
export type ObservationMemoryPort = Pick<MemoryService, "create" | "findByIdScoped">;
export type ObservationTemporalProjection = Partial<Pick<Parameters<ObservationMemoryPort["create"]>[0],
  "event_time_start" | "event_time_end" | "valid_from" | "valid_to" | "time_precision" | "time_source" | "projection_schema_version">>;
export type SourceObservationIdentity = Readonly<{ evidenceObjectId: string; memoryObjectId: string }>;
type SourceEventAnchor = Readonly<{ event_type: "soul.signal.emitted"; event_id: string; occurred_at: string }> | null;
type Publication = Readonly<{ bound: BoundSourceStatement; evidence: Readonly<EvidenceCapsule>; memory: Readonly<MemoryEntry> }>;

export function publicationIdentity(stored: StoredSourceRecord, located: LocatedSourceStatement,
  sha256: FieldContractSha256): SourceObservationIdentity {
  const digest = sha256(canonicalJson({ workspace_id: stored.record.workspace_id,
    root_id: stored.record.identity, source_version: stored.record.source_version,
    content_digest: stored.record.content_digest, statement: located }));
  return { evidenceObjectId: uuidFromHex(sha256(`source-statement-evidence:${digest}`)),
    memoryObjectId: uuidFromHex(sha256(`source-statement-memory:${digest}`)) };
}
export function bindInterpretation(located: LocatedSourceStatement, stored: StoredSourceRecord): BoundSourceStatement {
  return BoundSourceStatementSchema.parse({ ...located, source_target: sourceRecallTarget({
    workspace_id: stored.record.workspace_id, root_kind: "source_record", root_id: stored.record.identity,
    source_version: stored.record.source_version, content_digest: stored.record.content_digest,
    evidence_object_id: stored.record.evidence_object_id,
    span: { content_start: located.source_span[0], content_end: located.source_span[1], retained_extent: "body",
      content_complete: true, original_complete: false }
  }) });
}
export function assertPublicationBinding(actual: BoundSourceStatement, expected: BoundSourceStatement): void {
  if (canonicalJson(actual) !== canonicalJson(expected)) throw new CoreError("VALIDATION", "stored statement differs from publication");
}
export async function findCompletePublication(evidenceService: ObservationEvidencePort, memoryService: ObservationMemoryPort,
  workspaceId: string, identity: SourceObservationIdentity): Promise<Publication | null> {
  const memory = await memoryService.findByIdScoped(identity.memoryObjectId, workspaceId);
  const evidence = await evidenceService.findByIdScoped(identity.evidenceObjectId, workspaceId);
  if (memory === null || evidence === null) return null;
  if (evidence.lifecycle_state !== "active") throw new CoreError("CONFLICT", "statement evidence is unavailable");
  const bound = parseBoundGist(evidence.gist);
  if (bound === null) throw new CoreError("OBLIGATION_VIOLATION", "published observation is not a bound statement");
  return { bound, evidence, memory };
}

/** Evidence persists before memory. Notification failure cannot compensate a committed source write. */
export async function persistObservation(input: Readonly<{
  evidenceService: ObservationEvidencePort; memoryService: ObservationMemoryPort;
  assertSourceCurrent: () => void; temporalProjection: ObservationTemporalProjection;
  persistArtifact: (evidence: Readonly<EvidenceCapsule>) => void;
  persistMemoryBinding: (inMemoryTransaction?: boolean) => void;
}>, signal: SourceStatementSignal, anchor: SourceEventAnchor, bound: BoundSourceStatement,
identity: SourceObservationIdentity, scope: SourceScopeClass): Promise<Publication> {
  const evidence = await createEvidence(input, signal, anchor, bound, identity.evidenceObjectId);
  try {
    input.persistArtifact(evidence);
    const existing = await input.memoryService.findByIdScoped(identity.memoryObjectId, signal.workspace_id);
    input.assertSourceCurrent();
    if (existing !== null) { input.persistMemoryBinding(); return { bound, evidence, memory: existing }; }
    try {
      const memory = await input.memoryService.create({ ...input.temporalProjection, object_id: identity.memoryObjectId,
        assertSourceCurrent: input.assertSourceCurrent, persistSourceStatementDependency: () => input.persistMemoryBinding(true),
        created_by: signal.source, dimension: "observation",
        source_kind: "compiler", formation_kind: "extracted", scope_class: scope, content: bound.statement.text,
        domain_tags: [], evidence_refs: [evidence.object_id], workspace_id: signal.workspace_id,
        run_id: signal.run_id, surface_id: signal.surface_id });
      return { bound, evidence, memory };
    } catch (error) {
      const raced = await input.memoryService.findByIdScoped(identity.memoryObjectId, signal.workspace_id);
      input.assertSourceCurrent();
      if (raced !== null) { input.persistMemoryBinding(); return { bound, evidence, memory: raced }; }
      throw error;
    }
  } catch (cause) {
    throw new CoreError(cause instanceof CoreError ? cause.code : "CONFLICT",
      "source statement memory write interrupted after evidence creation", { cause,
        details: { evidence_object_id: evidence.object_id } });
  }
}

async function createEvidence(input: Readonly<{ evidenceService: ObservationEvidencePort; assertSourceCurrent: () => void }>,
  signal: SourceStatementSignal, anchor: SourceEventAnchor, bound: BoundSourceStatement, objectId: string): Promise<Readonly<EvidenceCapsule>> {
  const check = (evidence: Readonly<EvidenceCapsule>) => {
    input.assertSourceCurrent();
    if (evidence.lifecycle_state !== "active") throw new CoreError("CONFLICT", "statement evidence is unavailable");
    const actual = parseBoundGist(evidence.gist);
    if (actual === null) throw new CoreError("OBLIGATION_VIOLATION", "stored observation is not a bound statement");
    assertPublicationBinding(actual, bound); return evidence;
  };
  const existing = await input.evidenceService.findByIdScoped(objectId, signal.workspace_id);
  if (existing !== null) return check(existing);
  input.assertSourceCurrent();
  try {
    return await input.evidenceService.create({ object_id: objectId, created_by: signal.source,
      evidence_kind: "conversation_excerpt", evidence_health_state: "questionable",
      semantic_anchor: { topic: bound.statement.relation, keywords: [], summary: bound.statement.text },
      event_anchor: anchor === null ? null : { event_type: anchor.event_type, event_id: anchor.event_id, occurred_at: anchor.occurred_at },
      physical_anchor: { file_path: null, line_range: null, symbol_name: null, artifact_ref: null },
      gist: JSON.stringify(bound), excerpt: bound.message.text, source_hash: bound.source_target.content_digest,
      run_id: signal.run_id, workspace_id: signal.workspace_id, surface_id: signal.surface_id
    }, [], undefined, undefined, undefined, input.assertSourceCurrent, SOURCE_PROVENANCE_CAPSULE);
  } catch (error) {
    const raced = await input.evidenceService.findByIdScoped(objectId, signal.workspace_id);
    if (raced !== null) return check(raced);
    throw error;
  }
}
function parseBoundGist(gist: string): BoundSourceStatement | null {
  try { const parsed = BoundSourceStatementSchema.safeParse(JSON.parse(gist)); return parsed.success ? parsed.data : null; }
  catch { return null; }
}
export function uuidFromHex(hex: string): string {
  const digits = hex.replace(/[^0-9a-f]/gi, "").toLowerCase().padEnd(32, "0").slice(0, 32).split("");
  digits[12] = "5"; digits[16] = ((Number.parseInt(digits[16]!, 16) & 0x3) | 0x8).toString(16);
  const id = digits.join("");
  return `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;
}
