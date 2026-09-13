import { z } from "zod";
import { isDeepStrictEqual } from "node:util";
import { IsoDatetimeStringSchema, SourceRecordIdentitySchema, AddressableSourceSpanSchema,
  verifySourceRecordIdentity, verifyAddressableSourceSpan } from "@do-soul/alaya-protocol";
import { fieldContractSha256 } from "@do-soul/alaya-core";
import { readRegularFileNoFollow, hashRegularFileNoFollow, sha256Buffer } from "../bound-file.js";
import { atomicWriteJson } from "../materialize.js";
import { buildLongMemEvalQuestionRuntimeIdentity } from "../../selection/question-runtime-identity.js";

const Digest = z.string().regex(/^[a-f0-9]{64}$/u);
const MAX_SHARD_BYTES = 8 * 1024 * 1024;
const MAX_INDEX_BYTES = 16 * 1024 * 1024;
export const SourceRecordsDatasetSchema = z.object({
  variant: z.literal("longmemeval_s"), sha256: Digest,
  offset: z.number().int().nonnegative(), limit: z.number().int().positive(),
  question_ids: z.array(z.string().min(1)).min(1)
}).strict().superRefine((dataset, context) => {
  if (dataset.question_ids.length !== dataset.limit || new Set(dataset.question_ids).size !== dataset.limit) {
    context.addIssue({ code: "custom", message: "source_records question identities must be a complete unique window" });
  }
});
const HeaderSchema = z.object({
  schema_version: z.literal(2), artifact_domain: z.literal("source_records"),
  dataset: SourceRecordsDatasetSchema, recorded_at: IsoDatetimeStringSchema,
  questions: z.array(z.object({ question_id: z.string().min(1), interpretation_clock: IsoDatetimeStringSchema }).strict())
}).strict();
const MessageSchema = z.object({
  question_id: z.string().min(1), session_id: z.string().min(1),
  session_index: z.number().int().nonnegative(), round_index: z.number().int().nonnegative(),
  message_id: z.string().min(1), message_index: z.number().int().nonnegative(),
  source_observed_at: IsoDatetimeStringSchema,
  role: z.enum(["user", "assistant"]), content_state: z.enum(["empty", "retained"]),
  record: SourceRecordIdentitySchema, spans: z.array(AddressableSourceSpanSchema).readonly()
}).strict();
const ShardSchema = z.object({ sha256: Digest, message_count: z.number().int().positive(),
  byte_length: z.number().int().positive().max(MAX_SHARD_BYTES) }).strict();
const SidecarIndexSchema = HeaderSchema.extend({
  message_count: z.number().int().nonnegative(), shards: z.array(ShardSchema)
}).strict();
const ManifestBody = z.object({
  schema_version: z.literal(2), artifact_domain: z.literal("source_records"),
  dataset: SourceRecordsDatasetSchema, recorded_at: IsoDatetimeStringSchema,
  message_count: z.number().int().nonnegative(), db_sha256: Digest,
  sidecar_sha256: Digest, producer_commit: z.string().regex(/^[a-f0-9]{40}$/u)
}).strict();
export const SourceRecordsManifestSchema = ManifestBody.extend({ manifest_sha256: Digest }).strict();
export type SourceRecordsManifest = z.infer<typeof SourceRecordsManifestSchema>;
export type SourceRecordsSidecar = z.infer<typeof SidecarIndexSchema>;
export type SourceRecordsMessage = z.infer<typeof MessageSchema>;
export type SourceRecordsDataset = z.infer<typeof SourceRecordsDatasetSchema>;
export const sourceRecordsManifestPath = (path: string): string => `${path}.manifest.json`;
export const sourceRecordsSidecarPath = (path: string): string => `${path}.sources.json`;
export const sourceRecordsShardPath = (path: string, digest: string): string => `${path}.sources.${Digest.parse(digest)}.json`;

export function sealSourceRecordsManifest(body: z.infer<typeof ManifestBody>): SourceRecordsManifest {
  const parsed = ManifestBody.parse(body);
  return SourceRecordsManifestSchema.parse({ ...parsed,
    manifest_sha256: sha256Buffer(Buffer.from(JSON.stringify(parsed), "utf8")) });
}

/** Each append retains at most one bounded shard; native identities remain the validation authority. */
export function createSourceRecordsSidecarWriter(snapshotPath: string, input: z.infer<typeof HeaderSchema>) {
  const header = validateHeader(input);
  const validate = messageValidator(header);
  const shards: SourceRecordsSidecar["shards"] = [];
  let messages: SourceRecordsMessage[] = [];
  let bytes = 3; // Array delimiters and trailing newline.
  let count = 0;
  let finished = false;
  function flush(): void {
    if (messages.length === 0) return;
    const encoded = Buffer.from(`${JSON.stringify(messages)}\n`, "utf8");
    const sha256 = sha256Buffer(encoded);
    atomicWriteJson(sourceRecordsShardPath(snapshotPath, sha256), messages, 0);
    shards.push({ sha256, message_count: messages.length, byte_length: encoded.byteLength });
    messages = []; bytes = 3;
  }
  return {
    append(input: unknown): void {
      if (finished) throw new Error("source_records sidecar is already finished");
      const message = validate(input);
      const size = Buffer.byteLength(JSON.stringify(message), "utf8");
      if (size + 3 > MAX_SHARD_BYTES) throw new Error("source_records message exceeds shard size budget");
      if (bytes + size + (messages.length > 0 ? 1 : 0) > MAX_SHARD_BYTES) flush();
      bytes += size + (messages.length > 0 ? 1 : 0);
      messages.push(message); count++;
    },
    finish(): SourceRecordsSidecar {
      if (finished) throw new Error("source_records sidecar is already finished");
      flush(); finished = true;
      const index = SidecarIndexSchema.parse({ ...header, message_count: count, shards });
      if (Buffer.byteLength(JSON.stringify(index), "utf8") + 1 > MAX_INDEX_BYTES) {
        throw new Error("source_records sidecar index exceeds size budget");
      }
      atomicWriteJson(sourceRecordsSidecarPath(snapshotPath), index, 0);
      return index;
    }
  };
}

/** A visitor may see a validated prefix; only successful return certifies the complete artifact. */
export function inspectSourceRecordsArtifact(snapshotPath: string, onMessage?: (message: SourceRecordsMessage) => void): Readonly<{
  manifest: SourceRecordsManifest; sidecar: SourceRecordsSidecar;
}> {
  const manifest = SourceRecordsManifestSchema.parse(JSON.parse(readRegularFileNoFollow(
    sourceRecordsManifestPath(snapshotPath), 1024 * 1024).toString("utf8")));
  const { manifest_sha256, ...body } = manifest;
  if (sealSourceRecordsManifest(body).manifest_sha256 !== manifest_sha256) throw new Error("source_records manifest digest mismatch");
  const bytes = readRegularFileNoFollow(sourceRecordsSidecarPath(snapshotPath), MAX_INDEX_BYTES);
  if (sha256Buffer(bytes) !== manifest.sidecar_sha256) throw new Error("source_records sidecar digest mismatch");
  const sidecar = SidecarIndexSchema.parse(JSON.parse(bytes.toString("utf8")));
  const { shards, message_count, ...header } = sidecar;
  validateHeader(header);
  if (!isDeepStrictEqual(sidecar.dataset, manifest.dataset) || sidecar.recorded_at !== manifest.recorded_at ||
      message_count !== manifest.message_count || new Set(shards.map((shard) => shard.sha256)).size !== shards.length) {
    throw new Error("source_records sidecar binding mismatch");
  }
  const validate = messageValidator(header);
  let count = 0;
  for (const shard of shards) {
    const bytes = readRegularFileNoFollow(sourceRecordsShardPath(snapshotPath, shard.sha256), MAX_SHARD_BYTES);
    if (bytes.byteLength !== shard.byte_length || sha256Buffer(bytes) !== shard.sha256) {
      throw new Error("source_records shard digest or length mismatch");
    }
    const messages = z.array(z.unknown()).parse(JSON.parse(bytes.toString("utf8")));
    if (messages.length !== shard.message_count) throw new Error("source_records shard message count mismatch");
    for (const input of messages) { const message = validate(input); onMessage?.(message); count++; }
  }
  if (count !== message_count) throw new Error("source_records total message count mismatch");
  if (hashRegularFileNoFollow(snapshotPath) !== manifest.db_sha256) throw new Error("source_records DB digest mismatch");
  return { manifest, sidecar };
}

function validateHeader(input: unknown): z.infer<typeof HeaderSchema> {
  const header = HeaderSchema.parse(input);
  if (!isDeepStrictEqual(header.questions.map((q) => q.question_id), header.dataset.question_ids)) {
    throw new Error("source_records question clock binding mismatch");
  }
  return header;
}

function messageValidator(header: z.infer<typeof HeaderSchema>): (input: unknown) => SourceRecordsMessage {
  const questions = new Set(header.dataset.question_ids);
  const occurrences = new Set<string>();
  return (input) => {
    const message = MessageSchema.parse(input);
    const { record } = message;
    const occurrence = JSON.stringify([message.question_id, message.session_index, message.message_index]);
    if (!questions.has(message.question_id) || occurrences.has(occurrence) ||
        record.workspace_id !== buildLongMemEvalQuestionRuntimeIdentity(message.question_id).workspaceId ||
        record.source_id !== message.message_id || record.source_version !== header.dataset.sha256 ||
        record.recorded_at !== header.recorded_at || record.speaker !== message.role || record.scope_class !== "project" ||
        record.evidence_object_id !== null || record.event_time !== null || record.valid_from !== null || record.valid_to !== null ||
        (message.content_state === "empty" && message.spans.length !== 0)) {
      throw new Error("source_records message binding mismatch");
    }
    occurrences.add(occurrence);
    verifySourceRecordIdentity(record, fieldContractSha256);
    for (const span of message.spans) {
      verifyAddressableSourceSpan(span, fieldContractSha256);
      if (span.record_id !== record.identity || span.workspace_id !== record.workspace_id || span.recorded_at !== record.recorded_at) {
        throw new Error("source_records span binding mismatch");
      }
    }
    return message;
  };
}
