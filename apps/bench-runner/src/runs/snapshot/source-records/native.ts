import { existsSync, mkdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { AlayaError, bindUtteranceAttribution, canonicalJson, hashContentDigest,
  SourceRecordIdentitySchema, verifySourceRecordIdentity } from "@do-soul/alaya-protocol";
import { authorizeSemanticScope, deriveAddressableSpanViews, fieldContractSha256 } from "@do-soul/alaya-core";
import { openReadOnlyDatabase, sourceRecordFromRow, SqliteFieldSourceRecordRepo } from "@do-soul/alaya-storage";
import { SourceSemanticSourceRoleSchema } from "@do-soul/alaya-soul";
import { startBenchDaemon } from "../../../harness/daemon.js";
import { readRegularFileNoFollow, hashRegularFileNoFollow } from "../bound-file.js";
import { checkpointAndCopyBenchDb, cloneCachedSealedSnapshot } from "../freeze/db-copy.js";
import { snapshotPublishLockPath, withSnapshotPublishLock } from "../freeze/publish-lock.js";
import { atomicWriteJson, BENCH_DAEMON_DB_FILENAME } from "../materialize.js";
import { canonicalPath, canonicalPathsOverlap } from "../../fs/opened-contained-path.js";
import { boundedArtifactEntryExists, readBoundedStableRegularFile } from "../../extraction/cache-audit/bounded-artifact-reader.js";

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
const RetainedNativeSourceMemberSchema = z.object({ record: SourceRecordIdentitySchema,
  content_sha256: Digest, title: z.string().min(1).optional() }).strict();
const RetainedNativeSourceSnapshotBodySchema = NativeSourceSnapshotBodySchema.extend({
  contract: z.literal("native-source-records-snapshot-v2"),
  origin: z.object({ snapshot_path: z.string().min(1), db_sha256: Digest }).strict(),
  sources: z.array(RetainedNativeSourceMemberSchema).min(1).max(NATIVE_SOURCE_POPULATION_MAX)
}).strict();
const RetainedNativeSourceSnapshotSchema = RetainedNativeSourceSnapshotBodySchema.extend({ identity: Digest }).strict();
const AnyNativeSourceSnapshotSchema = z.discriminatedUnion("contract", [
  NativeSourceSnapshotSchema, RetainedNativeSourceSnapshotSchema
]);
export type NativeSourceSnapshot = z.infer<typeof AnyNativeSourceSnapshotSchema>;
export type NativeSourceInput = z.infer<typeof NativeSourceInputSchema>;
export const nativeSourceSnapshotManifestPath = (path: string): string => `${path}.native-sources.json`;

export async function prepareNativeSourceRecordsSnapshot(input: Readonly<{
  snapshotPath: string; dataDirRoot: string; workspaceId: string; runId: string;
  producerCommit: string; sources: readonly NativeSourceInput[];
}>): Promise<z.infer<typeof NativeSourceSnapshotSchema>> {
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

/** Admit existing records by copying a quiescent SQLite file; never reopen the retained original. */
export async function admitRetainedNativeSourceSnapshot(input: Readonly<{
  retainedPath: string; expectedSha256: string; snapshotPath: string;
  workspaceId: string; runId: string; producerCommit: string;
}>): Promise<z.infer<typeof RetainedNativeSourceSnapshotSchema>> {
  const retainedPath = resolve(input.retainedPath), snapshotPath = resolve(input.snapshotPath);
  Digest.parse(input.expectedSha256);
  NativeSourceSnapshotBodySchema.shape.producer_commit.parse(input.producerCommit);
  const protectedPaths = [retainedPath, ...["-wal", "-shm", "-journal"].map(suffix => retainedPath + suffix)]
    .map(canonicalPath);
  const protectedFiles = protectedPaths.filter(boundedArtifactEntryExists).map(path => statSync(path));
  const outputs = [snapshotPath, nativeSourceSnapshotManifestPath(snapshotPath),
    ...["-wal", "-shm", "-journal"].map(suffix => snapshotPath + suffix)];
  const lockPath = snapshotPublishLockPath(snapshotPath);
  const lockFiles = [lockPath, ...["-wal", "-shm", "-journal"].map(suffix => lockPath + suffix)];
  if ([...outputs, ...lockFiles].some(path => {
    if (protectedPaths.some(protectedPath => canonicalPathsOverlap(canonicalPath(path), protectedPath))) return true;
    if (!boundedArtifactEntryExists(path)) return false;
    const file = statSync(path);
    return protectedFiles.some(original => file.dev === original.dev && file.ino === original.ino);
  })) {
    throw new AlayaError("CONFLICT", "retained source admission output overlaps its original");
  }
  return withSnapshotPublishLock(snapshotPath, async () => {
    if (outputs.some(boundedArtifactEntryExists)) {
      throw new AlayaError("CONFLICT", "retained source admission requires a fresh unsealed output");
    }
    const sidecars = retainedSidecars(retainedPath);
    cloneCachedSealedSnapshot({ sourcePath: retainedPath, targetPath: snapshotPath,
      expectedSha256: input.expectedSha256 });
    const inventory = readNativeInventory(snapshotPath, input.workspaceId, NATIVE_SOURCE_POPULATION_MAX);
    const members = inventory.map(source => {
      assertRetainedSourceAdmissible(source);
      const { record, content_bytes } = source;
      return RetainedNativeSourceMemberSchema.parse({ record, content_sha256: fieldContractSha256(content_bytes) });
    });
    if (canonicalJson(retainedSidecars(retainedPath)) !== canonicalJson(sidecars) ||
        hashRegularFileNoFollow(retainedPath) !== input.expectedSha256 ||
        hashRegularFileNoFollow(snapshotPath) !== input.expectedSha256) {
      throw new AlayaError("CONFLICT", "retained source changed during admission");
    }
    const body = RetainedNativeSourceSnapshotBodySchema.parse({
      contract: "native-source-records-snapshot-v2", snapshot_path: snapshotPath,
      workspace_id: input.workspaceId, run_id: input.runId, producer_commit: input.producerCommit,
      db_sha256: input.expectedSha256, origin: { snapshot_path: retainedPath, db_sha256: input.expectedSha256 },
      sources: members
    });
    const manifest = RetainedNativeSourceSnapshotSchema.parse({ ...body, identity: fieldContractSha256(JSON.stringify(body)) });
    if (Buffer.byteLength(JSON.stringify(manifest, null, 2), "utf8") + 1 > 1024 * 1024) {
      throw new AlayaError("CONFLICT", "retained source manifest exceeds its byte bound");
    }
    // A failed admission leaves only an unsealed copy. The manifest is the final admission effect.
    atomicWriteJson(nativeSourceSnapshotManifestPath(snapshotPath), manifest);
    return manifest;
  });
}

function retainedSidecars(path: string) {
  return ["-wal", "-shm", "-journal"].map(suffix => {
    const sidecar = path + suffix;
    if (!boundedArtifactEntryExists(sidecar)) return null;
    const retained = readBoundedStableRegularFile({ path: sidecar,
      maxBytes: suffix === "-shm" ? 1024 * 1024 : 1, label: "retained SQLite sidecar" });
    if (suffix !== "-shm" && retained.bytes.length !== 0) {
      throw new AlayaError("CONFLICT", "retained source requires an empty or absent SQLite journal");
    }
    return retained.identity;
  });
}

function assertRetainedSourceAdmissible(source: ReturnType<typeof readNativeInventory>[number]) {
  authorizeSemanticScope(source.record.scope_class, ["project"]);
  if (source.record.attribution_context == null) {
    throw new AlayaError("CONFLICT", "retained source attribution is unavailable");
  }
  bindUtteranceAttribution(source.record.attribution_context, source.content_bytes);
  const role = SourceSemanticSourceRoleSchema.safeParse(source.record.speaker);
  if (!role.success) throw new AlayaError("CONFLICT", "retained source speaker is unavailable or unsupported for source semantics");
  return role.data;
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
  const bodySchema = source.manifest.contract === "native-source-records-snapshot-v1"
    ? NativeSourceSnapshotBodySchema : RetainedNativeSourceSnapshotBodySchema;
  const body = bodySchema.parse({ ...sourceBody,
    snapshot_path: copiedSnapshotPath, db_sha256: hashRegularFileNoFollow(copiedSnapshotPath) });
  const manifest = AnyNativeSourceSnapshotSchema.parse({ ...body, identity: fieldContractSha256(JSON.stringify(body)) });
  atomicWriteJson(nativeSourceSnapshotManifestPath(copiedSnapshotPath), manifest);
  readVerifiedNativeSourceSnapshot(copiedSnapshotPath);
  return manifest;
}

/** A complete population comes from a sealed native DB, with no replacement body from its caller. */
export function readVerifiedNativeSourceSnapshot(snapshotPathInput: string) {
  const snapshotPath = resolve(snapshotPathInput);
  const manifest = AnyNativeSourceSnapshotSchema.parse(JSON.parse(readRegularFileNoFollow(
    nativeSourceSnapshotManifestPath(snapshotPath), 1024 * 1024).toString("utf8")));
  const { identity, ...body } = manifest;
  if (manifest.snapshot_path !== snapshotPath || fieldContractSha256(JSON.stringify(body)) !== identity ||
      hashRegularFileNoFollow(snapshotPath) !== manifest.db_sha256) {
    throw new AlayaError("CONFLICT", "native source snapshot seal changed");
  }
  if (new Set(manifest.sources.map(row => row.record.source_id)).size !== manifest.sources.length ||
      new Set(manifest.sources.map(row => row.record.identity)).size !== manifest.sources.length) {
    throw new AlayaError("CONFLICT", "native source snapshot repeats a sealed member");
  }
  if (manifest.contract === "native-source-records-snapshot-v2") retainedSidecars(snapshotPath);
  const inventory = readNativeInventory(snapshotPath, manifest.workspace_id, manifest.sources.length);
  if (inventory.length !== manifest.sources.length) {
    throw new AlayaError("CONFLICT", "native source snapshot has omitted or extra records");
  }
  const byIdentity = new Map(inventory.map(row => [row.record.identity, row]));
  const verified = manifest.sources.map(member => {
    const current = byIdentity.get(member.record.identity);
    if (current === undefined || canonicalJson(current.record) !== canonicalJson(member.record) ||
        fieldContractSha256(current.content_bytes) !== member.content_sha256 ||
        "source_id" in member && (member.source_id !== current.record.source_id ||
          member.source_version !== current.record.source_version || member.recorded_at !== current.record.recorded_at ||
          member.source_observed_at !== current.record.event_time)) {
      throw new AlayaError("CONFLICT", "native source snapshot record differs from sealed original");
    }
    const sourceRole = manifest.contract === "native-source-records-snapshot-v2" ? assertRetainedSourceAdmissible(current) : undefined;
    return { ...member, ...current, source_id: current.record.source_id, source_version: current.record.source_version,
      ...(sourceRole === undefined ? {} : { source_role: sourceRole }),
      source_observed_at: current.record.event_time, recorded_at: current.record.recorded_at };
  });
  if (hashRegularFileNoFollow(snapshotPath) !== manifest.db_sha256) {
    throw new AlayaError("CONFLICT", "native source snapshot changed during verification");
  }
  if (manifest.contract === "native-source-records-snapshot-v2") retainedSidecars(snapshotPath);
  return { manifest, records: verified };
}

/** One bounded inventory owns membership, currentness, original bytes and record validation. */
function readNativeInventory(snapshotPath: string, workspaceId: string, maximumRecords: number) {
  const database = openReadOnlyDatabase(snapshotPath);
  try {
    const records = new SqliteFieldSourceRecordRepo(database, fieldContractSha256);
    const headers = new Map<string, NonNullable<ReturnType<typeof records.findByIdBounded>>>();
    let afterRecordedAt: string | undefined;
    let afterRecordId: string | undefined;
    for (;;) {
      const limit = Math.min(512, maximumRecords + 1 - headers.size);
      const page = records.listPageBounded(workspaceId, { limit,
        ...(afterRecordedAt === undefined ? {} : { afterRecordedAt, afterRecordId }) }, 1);
      if (page.rows.some(item => item.record?.source_body == null || item.invalidOffset || item.bodyBytes > NATIVE_SOURCE_BODY_MAX)) {
        throw new AlayaError("CONFLICT", "native source snapshot contains unavailable or oversized record");
      }
      for (const item of page.rows) {
        const record = item.record!;
        if (headers.has(record.record_id)) throw new AlayaError("CONFLICT", "native source snapshot repeats a current record");
        headers.set(record.record_id, item);
      }
      if (headers.size > maximumRecords) throw new AlayaError("CONFLICT", "native source snapshot has omitted or extra records");
      if (page.rows.length < limit) break;
      const last = page.rows.at(-1)!.record!;
      afterRecordedAt = last.recorded_at; afterRecordId = last.record_id;
    }
    return [...headers.values()].map(header => {
      const row = header.record!;
      if (records.findCurrentBounded(workspaceId, row.source_id, 1)?.record?.record_id !== row.record_id) {
        throw new AlayaError("CONFLICT", "native source snapshot contains a noncurrent record");
      }
      let offset = 0;
      const pieces: string[] = [];
      while (offset < header.bodyBytes) {
        const chunk = records.findByIdBounded(workspaceId, row.record_id,
          Math.min(65_536, header.bodyBytes - offset), offset);
        if (chunk?.record?.source_body == null || chunk.invalidOffset || chunk.prefixBytes === 0 ||
            chunk.bodyBytes !== header.bodyBytes || chunk.record.record_id !== row.record_id) {
          throw new AlayaError("CONFLICT", "native source snapshot body is unavailable or changed");
        }
        pieces.push(chunk.record.source_body); offset += chunk.prefixBytes;
      }
      const content_bytes = pieces.join("");
      const record = verifySourceRecordIdentity(sourceRecordFromRow(row), fieldContractSha256);
      if (offset !== header.bodyBytes || hashContentDigest(content_bytes, fieldContractSha256) !== record.content_digest) {
        throw new AlayaError("CONFLICT", "native source snapshot bytes differ from sealed original");
      }
      return { record, content_bytes };
    });
  } finally { database.close({ optimize: false }); }
}
