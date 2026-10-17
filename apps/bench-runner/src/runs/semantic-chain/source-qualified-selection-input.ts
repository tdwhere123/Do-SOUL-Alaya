import { z } from "zod";
import { resolve } from "node:path";
import { AlayaError, canonicalJson, SourceSemanticResourceLedger, SourceSemanticQuerySchema, SourceSemanticCorrespondenceSchema } from "@do-soul/alaya-protocol";
import type { SourceSemanticCorrespondenceRequest } from "@do-soul/alaya-soul";
import { QualifiedSourceNomineeSchema, QualifiedSourceSelectionSchema }
  from "../../../../core-daemon/dist/runtime/recall-read-worker/source-semantic-qualified-selection-boundary.js";
import { readVerifiedNativeSourceSnapshot, nativeSourceSnapshotManifestPath } from "../snapshot/source-records/native.js";
import { readSemanticProposalResults } from "../semantic-proposal/fill.js";
import { semanticProposalCacheInputPaths } from "../semantic-proposal/attempt.js";
import { sourceRecordsArtifactInputPaths } from "../snapshot/source-records/contract.js";
import { readVerifiedPersonaSuccessorMembership } from "../snapshot/source-records/persona-successor.js";
import { SemanticProposalWorksetSchema, type SemanticProposalWorkset } from "../semantic-proposal/workset.js";
import { chainIdentity, type SemanticChainConfig } from "./contract.js";

const Digest = z.string().regex(/^[a-f0-9]{64}$/u);
const Artifact = z.object({ key: Digest, cache_identity: Digest.nullable(), historical_production: z.unknown() }).strict();
const Correspondence = z.object({ artifact: Artifact, workset: SemanticProposalWorksetSchema,
  cache_root: z.string().min(1), max_output_tokens: z.number().int().positive().max(65536) }).strict();
const { correspondence_status: _status, ...nomineeShape } = QualifiedSourceNomineeSchema.shape;
export const SourceQualifiedSelectionInputSchema = z.object({
  contract: z.literal("private-qualified-source-selection-v1"), query_as_of: z.null(), snapshot_identity: Digest,
  snapshot_source_count: z.number().int().positive().max(10000), query: Artifact,
  persona_successor: z.object({ snapshot_path: z.string().min(1), parent_snapshot_path: z.string().min(1) }).strict().optional(),
  nominees: z.array(z.object({ ...nomineeShape, correspondence: Correspondence.optional() }).strict()).min(1).max(64)
}).strict().superRefine((value, context) => {
  // The native boundary owns distinctness and fixed-subset capacity; do not copy those rules here.
  const { query: _query, persona_successor: _successor, ...population } = value;
  const admitted = QualifiedSourceSelectionSchema.safeParse({ ...population,
    nominees: value.nominees.map(({ correspondence: _correspondence, ...row }) => ({ ...row, correspondence_status: "not_read" })) });
  if (!admitted.success) for (const issue of admitted.error.issues) context.addIssue({ code: "custom", path: issue.path, message: issue.message });
});
export type SourceQualifiedSelectionInput = z.infer<typeof SourceQualifiedSelectionInputSchema>;
export function qualifiedSelectionInputPaths(config: SemanticChainConfig, input: SourceQualifiedSelectionInput): string[] {
  return [nativeSourceSnapshotManifestPath(config.snapshot_path),
    ...semanticProposalCacheInputPaths(config.query_workset, config.query_cache_root, config.max_output_tokens, true),
    ...input.nominees.flatMap(row => row.correspondence === undefined ? [] : semanticProposalCacheInputPaths(
      row.correspondence.workset, row.correspondence.cache_root, row.correspondence.max_output_tokens, true)),
    ...(input.persona_successor === undefined ? [] : [
      ...sourceRecordsArtifactInputPaths(input.persona_successor.snapshot_path),
      ...sourceRecordsArtifactInputPaths(input.persona_successor.parent_snapshot_path)])];
}

/** Read-only producer readmission. Configured paths and caller JSON never establish readiness.
 * The complete native seal is checked independently of the selected fixed subset. */
export function admitSourceQualifiedSelection(config: SemanticChainConfig, input: SourceQualifiedSelectionInput) {
  const meter = new SourceSemanticResourceLedger(config.budget);
  meter.retain(input, "qualified producer admission");
  const full = readVerifiedNativeSourceSnapshot(config.snapshot_path);
  if (full.manifest.identity !== input.snapshot_identity || full.manifest.workspace_id !== config.workspace_id ||
      full.records.length !== input.snapshot_source_count || full.manifest.db_sha256 !== config.snapshot_sha256) {
    throw new AlayaError("CONFLICT", "qualified consumer full source snapshot identity changed");
  }
  const successor = input.persona_successor === undefined ? undefined : readVerifiedPersonaSuccessorMembership(
    input.persona_successor.snapshot_path, input.persona_successor.parent_snapshot_path, config.workspace_id);
  if (successor !== undefined && (full.manifest.contract !== "native-source-records-snapshot-v2" ||
      resolve(full.manifest.origin.snapshot_path) !== resolve(input.persona_successor!.snapshot_path) ||
      full.manifest.origin.db_sha256 !== successor.manifest.db_sha256 || successor.messages.length !== full.records.length ||
      successor.messages.some(row => !full.records.some(member => canonicalJson(member.record) === canonicalJson(row.record))))) {
    throw new AlayaError("CONFLICT", "qualified persona successor differs from the sealed native origin");
  }
  for (const row of input.nominees) {
    const member = full.records.find(member => member.record.identity === row.current.record_id);
    if (member === undefined || member.record.source_id !== row.current.source_id ||
        member.record.source_version !== row.current.source_version || member.record.content_digest !== row.current.content_digest ||
        Buffer.byteLength(member.content_bytes) !== row.body_bytes) {
      throw new AlayaError("CONFLICT", "qualified nominee differs from its complete sealed source snapshot");
    }
    if (canonicalJson(row.nominee) !== canonicalJson(row.current)) {
      const predecessor = successor?.messages.find(message => message.record.identity === row.current.record_id)?.predecessor;
      if (predecessor === undefined || predecessor.identity !== row.nominee.record_id ||
          predecessor.source_id !== row.nominee.source_id || predecessor.source_version !== row.nominee.source_version ||
          predecessor.content_digest !== row.nominee.content_digest) {
        throw new AlayaError("CONFLICT", "qualified nominee lacks its verified persona predecessor membership");
      }
    }
  }
  const read = (workset: SemanticProposalWorkset, root: string, cap: number, artifact: z.infer<typeof Artifact>) => {
    if (workset.items.length !== 1) throw new AlayaError("VALIDATION", "qualified consumer requires one exact producer request per artifact");
    const row = readSemanticProposalResults(workset, root, cap, meter)[0]!;
    if (row.line.key !== artifact.key || (row.shard === undefined ? null : chainIdentity(row.shard)) !== artifact.cache_identity ||
        canonicalJson(artifact.historical_production) !== canonicalJson(row.shard?.usage === undefined
          ? { status: "unknown" } : { status: "reported", usage: row.shard.usage })) {
      throw new AlayaError("CONFLICT", "qualified producer key, shard or historical usage changed");
    }
    return row;
  };
  const q = read(config.query_workset, config.query_cache_root, config.max_output_tokens, input.query);
  const population = QualifiedSourceSelectionSchema.parse({ contract: input.contract, query_as_of: input.query_as_of,
    snapshot_identity: input.snapshot_identity, snapshot_source_count: input.snapshot_source_count,
    nominees: input.nominees.map(({ correspondence, ...source }) => ({ ...source,
      correspondence_status: correspondence === undefined ? "not_supplied" : "not_read" })) });
  const provenance: { kind: "query" | "semantic_correspondence"; key: string; status: string; cache_identity: string | null;
    historical_production: unknown }[] = [{ kind: "query", ...input.query, status: q.status }];
  const query_semantics = q.received !== undefined && "query" in q.received ? q.received.query : undefined;
  if (q.status !== "interpreted" || query_semantics === undefined) return { status: "unavailable" as const,
    reason: `query_${q.status}`, population, provenance, new_dispatches: 0 as const,
    snapshot_verification_work: "unmeasured" as const,
    work: { work_units: meter.spentWork, memory_bytes: meter.spentBytes } };
  const admittedQuery = SourceSemanticQuerySchema.parse(query_semantics);
  meter.retain(admittedQuery, "qualified received Q capture");
  const semantic_correspondences = [];
  for (const [index, row] of input.nominees.entries()) {
    const c = row.correspondence;
    if (c === undefined) continue;
    if (c.workset.kind !== "semantic_correspondence") throw new AlayaError("VALIDATION", "qualified C artifact has wrong producer kind");
    const result = read(c.workset, c.cache_root, c.max_output_tokens, c.artifact);
    const request = result.line.request as SourceSemanticCorrespondenceRequest, h = request.source_interpretation_descriptors[0];
    if (request.original_query !== q.line.original_query || canonicalJson(request.admitted_query_semantics) !== canonicalJson(query_semantics) ||
        row.interpretation?.interpretation === undefined || h?.source_interpretation_id !== row.interpretation.interpretation_id ||
        canonicalJson(h.interpretation) !== canonicalJson(row.interpretation.interpretation)) {
      throw new AlayaError("CONFLICT", "qualified C producer request differs from its exact Q/H binding");
    }
    population.nominees[index]!.correspondence_status = result.status;
    provenance.push({ kind: "semantic_correspondence", ...c.artifact, status: result.status });
    if (result.status === "interpreted" && result.received !== undefined && "semantic_correspondence" in result.received) {
      const correspondence = SourceSemanticCorrespondenceSchema.parse(result.received.semantic_correspondence);
      meter.retain(correspondence, "qualified received C capture");
      semantic_correspondences.push(correspondence);
    }
  }
  return { status: "ready" as const, population, query_semantics: admittedQuery, semantic_correspondences, provenance,
    new_dispatches: 0 as const, snapshot_verification_work: "unmeasured" as const,
    work: { work_units: meter.spentWork, memory_bytes: meter.spentBytes } };
}
