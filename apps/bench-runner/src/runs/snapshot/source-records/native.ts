import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { AlayaError, SourceRecordIdentitySchema, verifySourceRecordIdentity } from "@do-soul/alaya-protocol";
import { deriveAddressableSpanViews, fieldContractSha256 } from "@do-soul/alaya-core";
import { openReadOnlyDatabase, sourceRecordFromRow, SqliteFieldSourceRecordRepo } from "@do-soul/alaya-storage";
import { startBenchDaemon } from "../../../harness/daemon.js";
import { readRegularFileNoFollow, hashRegularFileNoFollow } from "../bound-file.js";
import { checkpointAndCopyBenchDb } from "../freeze/db-copy.js";
import { withSnapshotPublishLock } from "../freeze/publish-lock.js";
import { atomicWriteJson, BENCH_DAEMON_DB_FILENAME } from "../materialize.js";

const Digest = z.string().regex(/^[a-f0-9]{64}$/u);
// This is a source-population capacity; the connected qualification window has its own cap of ten.
const NATIVE_SOURCE_POPULATION_MAX = 10_000;
const NATIVE_SOURCE_BODY_MAX = 1024 * 1024;
const NativeSourceInputSchema = z.object({
  source_id: z.string().min(1), source_version: z.string().min(1), title: z.string().min(1),
  content_bytes: z.string().refine(value => Buffer.byteLength(value, "utf8") <= NATIVE_SOURCE_BODY_MAX),
  source_observed_at: z.string().datetime(),
  recorded_at: z.string().datetime()
}).strict();
const NativeSourceMemberSchema = NativeSourceInputSchema.omit({ content_bytes: true }).extend({
  record: SourceRecordIdentitySchema, content_sha256: Digest
}).strict();
const NativeSourceSnapshotBodySchema = z.object({
  contract: z.literal("native-source-records-snapshot-v1"), snapshot_path: z.string().min(1),
  workspace_id: z.string().min(1), run_id: z.string().min(1), db_sha256: Digest,
  producer_commit: z.string().regex(/^[a-f0-9]{40}$/u),
  sources: z.array(NativeSourceMemberSchema).min(1).max(NATIVE_SOURCE_POPULATION_MAX)
}).strict();
const NativeSourceSnapshotSchema = NativeSourceSnapshotBodySchema.extend({ identity: Digest }).strict();
export type NativeSourceSnapshot = z.infer<typeof NativeSourceSnapshotSchema>;
export type NativeSourceInput = z.infer<typeof NativeSourceInputSchema>;
export const nativeSourceSnapshotManifestPath = (path: string): string => `${path}.native-sources.json`;

export async function prepareNativeSourceRecordsSnapshot(input: Readonly<{
  snapshotPath: string; dataDirRoot: string; workspaceId: string; runId: string;
  producerCommit: string; sources: readonly NativeSourceInput[];
}>): Promise<NativeSourceSnapshot> {
  const snapshotPath = resolve(input.snapshotPath);
  const dataDirRoot = resolve(input.dataDirRoot);
  if (snapshotPath === join(dataDirRoot, BENCH_DAEMON_DB_FILENAME) ||
      existsSync(snapshotPath) || existsSync(nativeSourceSnapshotManifestPath(snapshotPath)) ||
      existsSync(join(dataDirRoot, BENCH_DAEMON_DB_FILENAME))) {
    throw new AlayaError("CONFLICT", "native source preparation requires a fresh isolated snapshot");
  }
  const sources = z.array(NativeSourceInputSchema).min(1).max(NATIVE_SOURCE_POPULATION_MAX).parse(input.sources);
  if (new Set(sources.map(row => row.source_id)).size !== sources.length) {
    throw new AlayaError("CONFLICT", "native source snapshot repeats a source identity");
  }
  NativeSourceSnapshotBodySchema.shape.producer_commit.parse(input.producerCommit);
  return withSnapshotPublishLock(snapshotPath, async () => {
    mkdirSync(dataDirRoot, { recursive: true });
    const daemon = await startBenchDaemon({ dataDirRoot, workspaceId: input.workspaceId, runId: input.runId,
      embeddingMode: "disabled", fieldProjectionAdmissionMode: "explicit_checkpoint" });
    const members: z.infer<typeof NativeSourceMemberSchema>[] = [];
    try {
      for (const source of sources) {
        const admitted = await daemon.importSourceRecord({ source_id: source.source_id,
          source_version: source.source_version, content_bytes: source.content_bytes,
          recorded_at: source.recorded_at, event_time: source.source_observed_at,
          valid_from: null, valid_to: null, scope_class: "project",
          spans: deriveAddressableSpanViews(source.content_bytes) });
        members.push(NativeSourceMemberSchema.parse({
          source_id: source.source_id, source_version: source.source_version, title: source.title,
          source_observed_at: source.source_observed_at, recorded_at: source.recorded_at,
          content_sha256: fieldContractSha256(source.content_bytes), record: admitted.record
        }));
      }
      await daemon.checkpointFieldProjection();
    } finally { await daemon.shutdown(); }
    checkpointAndCopyBenchDb(join(dataDirRoot, BENCH_DAEMON_DB_FILENAME), snapshotPath);
    const body = NativeSourceSnapshotBodySchema.parse({
      contract: "native-source-records-snapshot-v1", snapshot_path: snapshotPath,
      workspace_id: input.workspaceId, run_id: input.runId, producer_commit: input.producerCommit,
      db_sha256: hashRegularFileNoFollow(snapshotPath), sources: members
    });
    const manifest = NativeSourceSnapshotSchema.parse({ ...body, identity: fieldContractSha256(JSON.stringify(body)) });
    atomicWriteJson(nativeSourceSnapshotManifestPath(snapshotPath), manifest);
    readVerifiedNativeSourceSnapshot(snapshotPath);
    return manifest;
  });
}

/** Seal a published SQLite copy with unchanged native source membership and clocks.
 * Existing interpretations stay in the SQLite and are verified by native readers at use. */
export function sealNativeSourceRecordsSnapshotCopy(sourceSnapshotPathInput: string,
  copiedSnapshotPathInput: string): NativeSourceSnapshot {
  const source = readVerifiedNativeSourceSnapshot(sourceSnapshotPathInput);
  const copiedSnapshotPath = resolve(copiedSnapshotPathInput);
  if (copiedSnapshotPath === resolve(sourceSnapshotPathInput) ||
      existsSync(nativeSourceSnapshotManifestPath(copiedSnapshotPath))) {
    throw new AlayaError("CONFLICT", "native source copy requires a distinct unsealed snapshot");
  }
  const { identity: _oldIdentity, ...sourceBody } = source.manifest;
  const body = NativeSourceSnapshotBodySchema.parse({ ...sourceBody,
    snapshot_path: copiedSnapshotPath, db_sha256: hashRegularFileNoFollow(copiedSnapshotPath) });
  const manifest = NativeSourceSnapshotSchema.parse({ ...body, identity: fieldContractSha256(JSON.stringify(body)) });
  atomicWriteJson(nativeSourceSnapshotManifestPath(copiedSnapshotPath), manifest);
  readVerifiedNativeSourceSnapshot(copiedSnapshotPath);
  return manifest;
}

/** A complete population comes from a sealed native DB, with no replacement body from its caller. */
export function readVerifiedNativeSourceSnapshot(snapshotPathInput: string) {
  const snapshotPath = resolve(snapshotPathInput);
  const manifest = NativeSourceSnapshotSchema.parse(JSON.parse(readRegularFileNoFollow(
    nativeSourceSnapshotManifestPath(snapshotPath), 1024 * 1024).toString("utf8")));
  const { identity, ...body } = manifest;
  if (manifest.snapshot_path !== snapshotPath || fieldContractSha256(JSON.stringify(body)) !== identity ||
      hashRegularFileNoFollow(snapshotPath) !== manifest.db_sha256) {
    throw new AlayaError("CONFLICT", "native source snapshot seal changed");
  }
  if (new Set(manifest.sources.map(row => row.source_id)).size !== manifest.sources.length ||
      new Set(manifest.sources.map(row => row.record.identity)).size !== manifest.sources.length) {
    throw new AlayaError("CONFLICT", "native source snapshot repeats a sealed member");
  }
  const database = openReadOnlyDatabase(snapshotPath);
  try {
    const records = new SqliteFieldSourceRecordRepo(database, fieldContractSha256);
    const headers = new Map<string, NonNullable<ReturnType<typeof records.findByIdBounded>>>();
    let afterRecordedAt: string | undefined;
    let afterRecordId: string | undefined;
    for (;;) {
      const limit = Math.min(512, manifest.sources.length + 1 - headers.size);
      const page = records.listPageBounded(manifest.workspace_id, { limit,
        ...(afterRecordedAt === undefined ? {} : { afterRecordedAt, afterRecordId }) }, 1);
      if (page.rows.some(item => item.record === null || item.invalidOffset || item.bodyBytes > NATIVE_SOURCE_BODY_MAX)) {
        throw new AlayaError("CONFLICT", "native source snapshot contains unavailable or oversized record");
      }
      for (const item of page.rows) {
        const record = item.record!;
        if (headers.has(record.record_id)) throw new AlayaError("CONFLICT", "native source snapshot repeats a current record");
        headers.set(record.record_id, item);
      }
      if (headers.size > manifest.sources.length || page.rows.length < limit) break;
      const last = page.rows.at(-1)!.record!;
      afterRecordedAt = last.recorded_at; afterRecordId = last.record_id;
    }
    if (headers.size !== manifest.sources.length) {
      throw new AlayaError("CONFLICT", "native source snapshot has omitted or extra records");
    }
    const verified = manifest.sources.map(member => {
      const header = headers.get(member.record.identity);
      const row = header?.record;
      if (header === undefined || row === null || row === undefined ||
          records.findCurrentBounded(manifest.workspace_id, member.source_id, 1)?.record?.record_id !== row.record_id ||
          row.source_id !== member.source_id ||
          JSON.stringify(sourceRecordFromRow(row)) !== JSON.stringify(member.record) ||
          row.event_time !== member.source_observed_at || row.recorded_at !== member.recorded_at ||
          row.source_version !== member.source_version) {
        throw new AlayaError("CONFLICT", "native source snapshot record differs from sealed original");
      }
      let offset = 0;
      const pieces: string[] = [];
      while (offset < header.bodyBytes) {
        const chunk = records.findByIdBounded(manifest.workspace_id, row.record_id,
          Math.min(65_536, header.bodyBytes - offset), offset);
        if (chunk?.record?.source_body == null || chunk.invalidOffset || chunk.prefixBytes === 0 ||
            chunk.bodyBytes !== header.bodyBytes || chunk.record.record_id !== row.record_id) {
          throw new AlayaError("CONFLICT", "native source snapshot body is unavailable or changed");
        }
        pieces.push(chunk.record.source_body); offset += chunk.prefixBytes;
      }
      const content_bytes = pieces.join("");
      if (offset !== header.bodyBytes || fieldContractSha256(content_bytes) !== member.content_sha256) {
        throw new AlayaError("CONFLICT", "native source snapshot bytes differ from sealed original");
      }
      verifySourceRecordIdentity(member.record, fieldContractSha256);
      return { ...member, content_bytes };
    });
    if (hashRegularFileNoFollow(snapshotPath) !== manifest.db_sha256) {
      throw new AlayaError("CONFLICT", "native source snapshot changed during verification");
    }
    return { manifest, records: verified };
  } finally { database.close({ optimize: false }); }
}
