import { createHash } from "node:crypto";
import {
  SHA256_DIGEST_PATTERN,
  type EvidenceCapsule,
  type SourceEvidenceTarget
} from "@do-soul/alaya-protocol";
import {
  encodeCapsuleCursor,
  parseCapsuleCursor,
  SqliteEvidenceCapsuleRepo
} from "../capsules/evidence-capsule-repo.js";
import {
  encodeRecordCursor,
  parseRecordCursor,
  SqliteFieldSourceRecordRepo
} from "./source-repo.js";
import type { FieldSourceRecordRow } from "./ports.js";

const PAGE_MAX = 512;
const DEFAULT_BYTE_LIMIT = 65_536;
const SHA256_PREFIX = "sha256:";

export type SourceRootKind = "source_record" | "evidence_capsule";

export type SourceRootRow = Readonly<{
  readonly kind: SourceRootKind;
  readonly workspace_id: string;
  readonly root_id: string;
  readonly revision: string;
  readonly digest: string;
  readonly evidence_object_id: string | null;
  readonly event_time: string | null;
  readonly role?: string;
  readonly content?: string;
  readonly content_start: number;
  readonly content_end: number;
  readonly content_complete: boolean;
  readonly original_complete: boolean;
  readonly retained_extent: "body" | "excerpt" | "gist";
}>;

export type SourceRootPage = Readonly<{
  readonly rows: readonly SourceRootRow[];
  readonly nativeVisits: number;
  readonly nativeBytes: number;
  readonly rowsRead: number;
  readonly bytesRead: number;
  readonly truncated: boolean;
  readonly committedThrough: string | null;
  readonly unavailable: boolean;
}>;

export type SourceRootHydratePage = Readonly<{
  readonly row: SourceRootRow | null;
  readonly rowsRead: number;
  readonly bytesRead: number;
  readonly unavailable: boolean;
  readonly resourceLimited?: boolean;
}>;

export type SourceRootPageInput = Readonly<{
  readonly workspaceId: string;
  readonly limit: number;
  readonly nativeLimit: number;
  readonly afterCursor: string | null;
  readonly byteLimit?: number;
}>;

export class SqliteSourceRootRecallReader {
  private readonly records: SqliteFieldSourceRecordRepo;
  private readonly capsules: SqliteEvidenceCapsuleRepo;

  public constructor(
    records: SqliteFieldSourceRecordRepo,
    capsules: SqliteEvidenceCapsuleRepo
  ) {
    this.records = records;
    this.capsules = capsules;
  }

  public page(input: SourceRootPageInput): SourceRootPage {
    const limit = Math.min(input.limit, input.nativeLimit);
    if (!Number.isSafeInteger(input.limit) || input.limit < 0 || input.limit > PAGE_MAX ||
        !Number.isSafeInteger(input.nativeLimit) || input.nativeLimit < 0 || input.nativeLimit > PAGE_MAX) {
      throw new Error("invalid source-root page limit");
    }
    const byteLimit = input.byteLimit ?? DEFAULT_BYTE_LIMIT;
    if (!Number.isSafeInteger(byteLimit) || byteLimit < 1 || byteLimit > DEFAULT_BYTE_LIMIT) {
      throw new Error("invalid source-root byte limit");
    }
    if (limit === 0) {
      return emptyPage(true, input.afterCursor);
    }
    const after = input.afterCursor;
    if (after === null || after.startsWith("r:")) {
      const recordPage = this.pageRecords(input.workspaceId, after, limit, byteLimit);
      if (recordPage.truncated || recordPage.rows.length === limit) return recordPage;
      const remaining = limit - recordPage.rows.length;
      const capsulePage = this.pageCapsules(input.workspaceId, null, remaining, byteLimit);
      return mergePages(recordPage, capsulePage);
    }
    if (after.startsWith("c:")) {
      return this.pageCapsules(input.workspaceId, after, limit, byteLimit);
    }
    return this.pageCapsules(input.workspaceId, null, limit, byteLimit);
  }

  public load(
    workspaceId: string,
    target: SourceEvidenceTarget
  ): SourceRootHydratePage {
    return this.read(workspaceId, target, DEFAULT_BYTE_LIMIT, 0, true);
  }

  public hydrate(
    workspaceId: string,
    target: SourceEvidenceTarget,
    byteLimit = DEFAULT_BYTE_LIMIT,
    offset = 0
  ): SourceRootHydratePage {
    return this.read(workspaceId, target, byteLimit, offset);
  }

  private read(
    workspaceId: string,
    target: SourceEvidenceTarget,
    byteLimit: number,
    offset: number,
    unbounded = false
  ): SourceRootHydratePage {
    if (!unbounded && (
      !Number.isSafeInteger(byteLimit) || byteLimit < 1 || byteLimit > DEFAULT_BYTE_LIMIT
    )) {
      throw new Error("invalid source-root byte limit");
    }
    if (target.workspace_id !== workspaceId) {
      return { row: null, rowsRead: 0, bytesRead: 0, unavailable: true };
    }
    if (target.root_kind === "source_record") {
      const row = this.records.findById(workspaceId, target.root_id);
      if (row === null) {
        return { row: null, rowsRead: 0, bytesRead: 0, unavailable: true };
      }
      const mapped = mapRecord(
        row,
        unbounded && row.source_body !== null ? Math.max(1, Buffer.byteLength(row.source_body, "utf8")) : byteLimit,
        unbounded ? 0 : offset
      );
      if (mapped === null || !sameSourceIdentity(mapped, target)) {
        return {
          row: null,
          rowsRead: 1,
          bytesRead: Buffer.byteLength(row.record_id, "utf8"),
          unavailable: true
        };
      }
      return {
        row: mapped,
        rowsRead: 1,
        bytesRead: hydrateBytes(mapped),
        unavailable: false,
        ...(mapped.content_complete ? {} : { resourceLimited: true })
      };
    }
    const capsule = this.capsules.getById(target.root_id);
    if (capsule === null || capsule.workspace_id !== workspaceId) {
      return { row: null, rowsRead: 0, bytesRead: 0, unavailable: true };
    }
    if (capsule.lifecycle_state !== "active") {
      return { row: null, rowsRead: 1, bytesRead: 0, unavailable: true };
    }
    const body = capsule.excerpt ?? capsule.gist;
    const mapped = mapCapsule(
      capsule,
      unbounded ? Math.max(1, Buffer.byteLength(body, "utf8")) : byteLimit,
      unbounded ? 0 : offset
    );
    if (mapped === null || !sameSourceIdentity(mapped, target)) {
      return { row: null, rowsRead: 1, bytesRead: 0, unavailable: true };
    }
    return {
      row: mapped,
      rowsRead: 1,
      bytesRead: hydrateBytes(mapped),
      unavailable: false,
      ...(mapped.content_complete ? {} : { resourceLimited: true })
    };
  }

  private pageRecords(
    workspaceId: string,
    after: string | null,
    limit: number,
    byteLimit: number
  ): SourceRootPage {
    const cursor = parseRecordCursor(after);
    const page = this.records.listPage(workspaceId, {
      limit,
      afterRecordedAt: cursor.afterRecordedAt,
      afterRecordId: cursor.afterRecordId
    });
    const rows = page.rows.flatMap((row) => {
      const mapped = mapRecord(row, byteLimit, 0);
      return mapped === null ? [] : [mapped];
    });
    const bytesRead = Buffer.byteLength(JSON.stringify(page.rows), "utf8");
    return {
      rows,
      nativeVisits: page.rows.length,
      nativeBytes: bytesRead,
      rowsRead: page.rows.length,
      bytesRead,
      truncated: page.truncated,
      committedThrough: page.committedThrough,
      unavailable: false
    };
  }

  private pageCapsules(
    workspaceId: string,
    after: string | null,
    limit: number,
    byteLimit: number
  ): SourceRootPage {
    const cursor = parseCapsuleCursor(after);
    const page = this.capsules.pageCapsuleOnlyRoots(workspaceId, {
      limit,
      afterCreatedAt: cursor.afterCreatedAt,
      afterObjectId: cursor.afterObjectId
    });
    const rows = page.rows.flatMap((row) => {
      const mapped = mapCapsule(row, byteLimit, 0);
      return mapped === null ? [] : [mapped];
    });
    const bytesRead = Buffer.byteLength(JSON.stringify(page.rows.map((row) => row.object_id)), "utf8");
    return {
      rows,
      nativeVisits: page.rows.length,
      nativeBytes: bytesRead,
      rowsRead: page.rows.length,
      bytesRead,
      truncated: page.truncated,
      committedThrough: page.committedThrough,
      unavailable: false
    };
  }
}

function mergePages(records: SourceRootPage, capsules: SourceRootPage): SourceRootPage {
  const rows = [...records.rows, ...capsules.rows];
  return {
    rows,
    nativeVisits: records.nativeVisits + capsules.nativeVisits,
    nativeBytes: records.nativeBytes + capsules.nativeBytes,
    rowsRead: records.rowsRead + capsules.rowsRead,
    bytesRead: records.bytesRead + capsules.bytesRead,
    truncated: capsules.truncated,
    committedThrough: capsules.committedThrough ?? records.committedThrough ?? encodeCapsuleCursor({}),
    unavailable: false
  };
}

function emptyPage(truncated: boolean, committedThrough: string | null): SourceRootPage {
  return {
    rows: [],
    nativeVisits: 0,
    nativeBytes: 0,
    rowsRead: 0,
    bytesRead: 0,
    truncated,
    committedThrough,
    unavailable: false
  };
}

function mapRecord(
  row: FieldSourceRecordRow,
  byteLimit: number,
  offset: number
): SourceRootRow | null {
  if (row.source_body === null) return null;
  const chunk = chunkUtf8(row.source_body, offset, byteLimit);
  if (chunk === null) return null;
  return {
    kind: "source_record",
    workspace_id: row.workspace_id,
    root_id: row.record_id,
    revision: row.source_version,
    digest: row.content_digest,
    evidence_object_id: row.evidence_object_id,
    event_time: row.event_time,
    content: chunk.text,
    content_start: chunk.start,
    content_end: chunk.end,
    content_complete: chunk.complete,
    original_complete: true,
    retained_extent: "body"
  };
}

function mapCapsule(
  capsule: EvidenceCapsule,
  byteLimit: number,
  offset: number
): SourceRootRow | null {
  const excerpt = capsule.excerpt;
  const retainedExtent = excerpt !== null ? "excerpt" : "gist";
  const body = excerpt ?? capsule.gist;
  const chunk = chunkUtf8(body, offset, byteLimit);
  if (chunk === null) return null;
  return {
    kind: "evidence_capsule",
    workspace_id: capsule.workspace_id,
    root_id: capsule.object_id,
    revision: capsule.updated_at,
    digest: contentDigest(body, capsule.source_hash),
    evidence_object_id: capsule.object_id,
    event_time: eventTimeOf(capsule),
    content: chunk.text,
    content_start: chunk.start,
    content_end: chunk.end,
    content_complete: chunk.complete,
    original_complete: excerpt !== null,
    retained_extent: retainedExtent
  };
}

function sameSourceIdentity(row: SourceRootRow, target: SourceEvidenceTarget): boolean {
  return row.kind === target.root_kind
    && row.root_id === target.root_id
    && row.revision === target.source_version
    && row.digest === target.content_digest
    && row.evidence_object_id === target.evidence_object_id;
}

function eventTimeOf(capsule: EvidenceCapsule): string | null {
  return capsule.event_anchor?.occurred_at ?? null;
}

function contentDigest(body: string, sourceHash: string | null): string {
  if (sourceHash !== null && SHA256_DIGEST_PATTERN.test(sourceHash)) return sourceHash;
  return `${SHA256_PREFIX}${createHash("sha256").update(body, "utf8").digest("hex")}`;
}

export function chunkUtf8(
  content: string,
  offset: number,
  byteLimit: number
): Readonly<{
  readonly text: string;
  readonly start: number;
  readonly end: number;
  readonly complete: boolean;
}> | null {
  const bytes = Buffer.from(content, "utf8");
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > bytes.length) return null;
  if (!isUtf8Boundary(bytes, offset)) return null;
  if (offset === bytes.length) {
    return { text: "", start: offset, end: offset, complete: true };
  }
  let end = Math.min(bytes.length, offset + byteLimit);
  while (end > offset && !isUtf8Boundary(bytes, end)) end -= 1;
  if (end === offset) {
    const width = utf8Width(bytes[offset]!);
    end = Math.min(bytes.length, offset + width);
  }
  return {
    text: bytes.subarray(offset, end).toString("utf8"),
    start: offset,
    end,
    complete: end === bytes.length
  };
}

function isUtf8Boundary(bytes: Buffer, offset: number): boolean {
  return offset === 0 || offset === bytes.length || (bytes[offset]! & 0xc0) !== 0x80;
}

function utf8Width(lead: number): number {
  if (lead < 0x80) return 1;
  if (lead < 0xe0) return 2;
  if (lead < 0xf0) return 3;
  return 4;
}

function hydrateBytes(row: SourceRootRow): number {
  return Buffer.byteLength(row.content ?? "", "utf8");
}

export { encodeRecordCursor, parseRecordCursor, encodeCapsuleCursor, parseCapsuleCursor };
