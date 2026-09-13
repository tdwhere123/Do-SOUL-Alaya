import { z } from "zod";
import { isDeepStrictEqual } from "node:util";
import { IsoDatetimeStringSchema, SourceRecordIdentitySchema, AddressableSourceSpanSchema,
  verifySourceRecordIdentity, verifyAddressableSourceSpan } from "@do-soul/alaya-protocol";
import { fieldContractSha256 } from "@do-soul/alaya-core";
import { readRegularFileNoFollow, hashRegularFileNoFollow, sha256Buffer } from "../bound-file.js";
import { buildLongMemEvalQuestionRuntimeIdentity } from "../../selection/question-runtime-identity.js";

const Digest = z.string().regex(/^[a-f0-9]{64}$/u);
export const SourceRecordsDatasetSchema = z.object({
  variant: z.literal("longmemeval_s"), sha256: Digest,
  offset: z.number().int().nonnegative(), limit: z.number().int().positive(),
  question_ids: z.array(z.string().min(1)).min(1)
}).strict().superRefine((dataset, context) => {
  if (dataset.question_ids.length !== dataset.limit || new Set(dataset.question_ids).size !== dataset.limit) {
    context.addIssue({ code: "custom", message: "source_records question identities must be a complete unique window" });
  }
});
export const SourceRecordsSidecarSchema = z.object({
  schema_version: z.literal(1), artifact_domain: z.literal("source_records"),
  dataset: SourceRecordsDatasetSchema, recorded_at: IsoDatetimeStringSchema,
  questions: z.array(z.object({ question_id: z.string().min(1), interpretation_clock: IsoDatetimeStringSchema }).strict()),
  messages: z.array(z.object({
    question_id: z.string().min(1), session_id: z.string().min(1),
    session_index: z.number().int().nonnegative(), round_index: z.number().int().nonnegative(),
    message_id: z.string().min(1), message_index: z.number().int().nonnegative(),
    source_observed_at: IsoDatetimeStringSchema,
    role: z.enum(["user", "assistant"]), content_state: z.enum(["empty", "retained"]),
    record: SourceRecordIdentitySchema, spans: z.array(AddressableSourceSpanSchema).readonly()
  }).strict())
}).strict();
const ManifestBody = z.object({
  schema_version: z.literal(1), artifact_domain: z.literal("source_records"),
  dataset: SourceRecordsDatasetSchema, recorded_at: IsoDatetimeStringSchema,
  message_count: z.number().int().nonnegative(), db_sha256: Digest,
  sidecar_sha256: Digest, producer_commit: z.string().regex(/^[a-f0-9]{40}$/u)
}).strict();
export const SourceRecordsManifestSchema = ManifestBody.extend({ manifest_sha256: Digest }).strict();
export type SourceRecordsManifest = z.infer<typeof SourceRecordsManifestSchema>;
export type SourceRecordsSidecar = z.infer<typeof SourceRecordsSidecarSchema>;
export type SourceRecordsDataset = z.infer<typeof SourceRecordsDatasetSchema>;
export const sourceRecordsManifestPath = (path: string): string => `${path}.manifest.json`;
export const sourceRecordsSidecarPath = (path: string): string => `${path}.sources.json`;

export function sealSourceRecordsManifest(body: z.infer<typeof ManifestBody>): SourceRecordsManifest {
  const parsed = ManifestBody.parse(body);
  return SourceRecordsManifestSchema.parse({ ...parsed,
    manifest_sha256: sha256Buffer(Buffer.from(JSON.stringify(parsed), "utf8")) });
}

export function inspectSourceRecordsArtifact(snapshotPath: string): Readonly<{
  manifest: SourceRecordsManifest; sidecar: SourceRecordsSidecar;
}> {
  const manifest = SourceRecordsManifestSchema.parse(JSON.parse(readRegularFileNoFollow(
    sourceRecordsManifestPath(snapshotPath), 1024 * 1024).toString("utf8")));
  const { manifest_sha256, ...body } = manifest;
  if (sealSourceRecordsManifest(body).manifest_sha256 !== manifest_sha256) throw new Error("source_records manifest digest mismatch");
  const bytes = readRegularFileNoFollow(sourceRecordsSidecarPath(snapshotPath), 256 * 1024 * 1024);
  if (sha256Buffer(bytes) !== manifest.sidecar_sha256) throw new Error("source_records sidecar digest mismatch");
  const sidecar = validateSourceRecordsSidecar(JSON.parse(bytes.toString("utf8")));
  if (!isDeepStrictEqual(sidecar.dataset, manifest.dataset) ||
      sidecar.recorded_at !== manifest.recorded_at || sidecar.messages.length !== manifest.message_count) {
    throw new Error("source_records sidecar binding mismatch");
  }
  if (hashRegularFileNoFollow(snapshotPath) !== manifest.db_sha256) throw new Error("source_records DB digest mismatch");
  return { manifest, sidecar };
}

export function validateSourceRecordsSidecar(input: unknown): SourceRecordsSidecar {
  const sidecar = SourceRecordsSidecarSchema.parse(input);
  const questions = new Set(sidecar.dataset.question_ids);
  if (!isDeepStrictEqual(sidecar.questions.map((q) => q.question_id), sidecar.dataset.question_ids)) {
    throw new Error("source_records question clock binding mismatch");
  }
  const messages = new Set<string>();
  for (const message of sidecar.messages) {
    const { record } = message;
    const occurrence = JSON.stringify([message.question_id, message.session_index, message.message_index]);
    if (!questions.has(message.question_id) || messages.has(occurrence) ||
        record.workspace_id !== buildLongMemEvalQuestionRuntimeIdentity(message.question_id).workspaceId ||
        record.source_id !== message.message_id || record.source_version !== sidecar.dataset.sha256 ||
        record.recorded_at !== sidecar.recorded_at || record.speaker !== message.role || record.scope_class !== "project" ||
        record.evidence_object_id !== null || record.event_time !== null || record.valid_from !== null || record.valid_to !== null ||
        (message.content_state === "empty" && message.spans.length !== 0)) {
      throw new Error("source_records message binding mismatch");
    }
    messages.add(occurrence);
    verifySourceRecordIdentity(record, fieldContractSha256);
    for (const span of message.spans) {
      verifyAddressableSourceSpan(span, fieldContractSha256);
      if (span.record_id !== record.identity || span.workspace_id !== record.workspace_id || span.recorded_at !== record.recorded_at) {
        throw new Error("source_records span binding mismatch");
      }
    }
  }
  return sidecar;
}
