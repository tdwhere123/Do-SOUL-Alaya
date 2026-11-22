import { z } from "zod";
import type { EventLogEntry } from "../events/event-log.js";
import { MemoryEntrySchema, type MemoryEntry } from "./memory-entry.js";
import { SynthesisCapsuleSchema } from "./synthesis-capsule.js";
import { EvidenceCapsuleSchema } from "../evidence/evidence-capsule.js";
import { SourceStatementArtifactSchema, SourceStatementContextSourceSchema, sourceStatementArtifact } from "../garden/source-statements.js";
import { BoundedIdSchema, IsoDatetimeStringSchema } from "../shared/schema-primitives.js";
import { canonicalJson } from "../recall/selection/capture/canonical-json.js";
import { FieldContractDigestSchema, hashContentDigest, type FieldContractSha256 } from "../recall/field-contract/canonical-identity.js";

const DependencySchema = z.object({ root_id: FieldContractDigestSchema, source_id: BoundedIdSchema }).strict().readonly();
/** Native facts captured before validation. These are not a caller-issued authorization. */
export const HistoricalMemoryCaptureCandidateSchema = z.object({
  member: MemoryEntrySchema,
  capsule: SynthesisCapsuleSchema,
  capsule_revision: z.number().int().nonnegative(),
  evidence: EvidenceCapsuleSchema,
  artifact: SourceStatementArtifactSchema,
  binding_artifact_id: BoundedIdSchema,
  dependencies: z.array(DependencySchema).min(1).readonly(),
  source_records: z.array(z.object({
    reference: SourceStatementContextSourceSchema,
    scope_class: z.string().nullable(),
    dependencies: z.array(FieldContractDigestSchema).readonly()
  }).strict().readonly()).min(1).readonly()
}).strict().readonly();
export type HistoricalMemoryCaptureCandidate = z.infer<typeof HistoricalMemoryCaptureCandidateSchema>;

const HistoricalMemoryCaptureMaterialSchema = z.object({
  kind: z.literal("historical_memory_capture"), schema_version: z.literal(1),
  workspace_id: BoundedIdSchema, capsule_id: BoundedIdSchema,
  capsule_revision: z.number().int().nonnegative(), capsule_digest: FieldContractDigestSchema,
  member: MemoryEntrySchema,
  evidence_id: BoundedIdSchema, evidence_digest: FieldContractDigestSchema, artifact_digest: FieldContractDigestSchema,
  source_roots: z.array(SourceStatementContextSourceSchema).min(1).readonly(),
  terminal_updated_at: IsoDatetimeStringSchema
}).strict().readonly();
export const HistoricalMemoryCaptureSchema = HistoricalMemoryCaptureMaterialSchema.unwrap().extend({
  capture_id: FieldContractDigestSchema
}).strict().readonly();
export type HistoricalMemoryCapture = z.infer<typeof HistoricalMemoryCaptureSchema>;

/** Capturing is an audited operation; only non-preserving transitions support legacy void callbacks. */
type AutonomousTombstoneBase = Readonly<{ objectId: string; updatedAt: string }>;
export type AutonomousTombstoneArguments =
  | [input: AutonomousTombstoneBase & Readonly<{ disposition: "compressed"; dispositionRef: string;
      preservation: HistoricalMemoryCapture }>, options: Readonly<{ onTransition: () => EventLogEntry }>]
  | [input: AutonomousTombstoneBase & Readonly<{ disposition: "judged_useless"; dispositionRef: null;
      preservation?: never }>, options?: Readonly<{ onTransition?: () => void }>];

/** No material is copied into EventLog. This optional commitment is an additive minor contract. */
export const HistoricalMemoryCaptureCommitmentSchema = z.object({
  schema_version: z.literal(1), capture_id: FieldContractDigestSchema, capsule_id: BoundedIdSchema
}).strict().readonly();

export const HistoricalMemoryReadResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("ready"), history: HistoricalMemoryCaptureSchema }).strict(),
  z.object({ status: z.enum(["missing", "unavailable", "invalidated", "erased"]) }).strict()
]).readonly();
export type HistoricalMemoryReadResult = z.infer<typeof HistoricalMemoryReadResultSchema>;
export type HistoricalMemoryCaptureNomination = Readonly<
  { status: "ready"; candidate: HistoricalMemoryCaptureCandidate } |
  { status: "ineligible"; reason: string }
>;

/** One canonical authority for both adoption and subsequent verification. No eligibility flag or summary substitutes for material. */
export function createHistoricalMemoryCapture(input: HistoricalMemoryCaptureCandidate, terminalUpdatedAt: string,
  sha256: FieldContractSha256): HistoricalMemoryCapture | null {
  const captured = HistoricalMemoryCaptureCandidateSchema.parse(input);
  const { member, capsule, evidence, artifact } = captured;
  if (member.lifecycle_state !== "dormant" || member.dimension !== "observation" || member.source_kind !== "compiler" ||
      member.formation_kind !== "extracted" || member.content !== artifact.bound.statement.text ||
      member.evidence_refs.length !== 1 || member.evidence_refs[0] !== evidence.object_id ||
      captured.binding_artifact_id !== evidence.object_id || artifact.artifact_id !== evidence.object_id ||
      evidence.workspace_id !== member.workspace_id || evidence.lifecycle_state !== "active" ||
      capsule.workspace_id !== member.workspace_id || capsule.lifecycle_state === "tombstone" ||
      capsule.synthesis_status === "archived" || !capsule.source_memory_refs.includes(member.object_id)) return null;
  const recomputedArtifact = sourceStatementArtifact(artifact.bound, evidence.object_id, sha256);
  if (canonicalJson(recomputedArtifact) !== canonicalJson(artifact) ||
      canonicalJson(JSON.parse(evidence.gist)) !== canonicalJson(artifact.bound)) return null;
  const target = artifact.bound.source_target;
  if (target.workspace_id !== member.workspace_id || target.root_kind !== "source_record") return null;
  const roots = [{ workspace_id: target.workspace_id, root_id: target.root_id,
    source_id: artifact.bound.artifact_key, source_version: target.source_version,
    content_digest: target.content_digest }, ...artifact.bound.source_context];
  if (roots.some(root => root.workspace_id !== member.workspace_id)) return null;
  const byId = new Map(roots.map(root => [root.root_id, root]));
  if (roots.some(root => canonicalJson(root) !== canonicalJson(byId.get(root.root_id)))) return null;
  const order = <T extends { root_id: string }>(values: readonly T[]) => [...values].sort((a, b) => a.root_id.localeCompare(b.root_id));
  if (canonicalJson(order(captured.dependencies)) !== canonicalJson(order([...byId.values()])
    .map(({ root_id, source_id }) => ({ root_id, source_id })))) return null;
  const records = new Map(captured.source_records.map(record => [record.reference.root_id, record]));
  if (records.size !== captured.source_records.length) return null;
  const visited = new Set<string>(), visiting = new Set<string>();
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return false;
    if (visited.has(id)) return true;
    const record = records.get(id);
    if (record === undefined || record.reference.workspace_id !== member.workspace_id ||
        (record.scope_class ?? "project") !== member.scope_class) return false;
    const bound = byId.get(id);
    if (bound !== undefined && canonicalJson(bound) !== canonicalJson(record.reference)) return false;
    visiting.add(id);
    if (!record.dependencies.every(visit)) return false;
    visiting.delete(id); visited.add(id);
    return true;
  };
  if (![...byId.keys()].every(visit) || visited.size !== records.size) return null;
  const ordered = order([...records.values()].map(record => record.reference));
  const material = HistoricalMemoryCaptureMaterialSchema.parse({ kind: "historical_memory_capture", schema_version: 1,
    workspace_id: member.workspace_id, capsule_id: capsule.object_id, capsule_revision: captured.capsule_revision,
    capsule_digest: hashContentDigest(canonicalJson(capsule), sha256), member,
    evidence_id: evidence.object_id, evidence_digest: hashContentDigest(canonicalJson(evidence), sha256),
    artifact_digest: artifact.artifact_digest, source_roots: ordered, terminal_updated_at: terminalUpdatedAt });
  return HistoricalMemoryCaptureSchema.parse({ ...material, capture_id: hashContentDigest(canonicalJson(material), sha256) });
}

export function verifyHistoricalMemoryCapture(input: HistoricalMemoryCapture, sha256: FieldContractSha256): boolean {
  const { capture_id, ...material } = HistoricalMemoryCaptureSchema.parse(input);
  return capture_id === hashContentDigest(canonicalJson(material), sha256);
}

/** Only the five fields owned by the terminal transition may differ from the captured revision. */
export function historicalCaptureTerminalMember(capture: HistoricalMemoryCapture): MemoryEntry {
  return MemoryEntrySchema.parse({ ...capture.member, lifecycle_state: "tombstone", retention_state: "tombstoned",
    forget_disposition: "compressed", forget_disposition_ref: capture.capsule_id, updated_at: capture.terminal_updated_at });
}
