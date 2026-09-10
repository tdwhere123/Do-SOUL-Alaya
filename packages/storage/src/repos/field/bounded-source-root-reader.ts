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
  SqliteFieldSourceRecordRepo,
  type BoundedSourceRecordRead
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
  readonly evidence_verified?: boolean;
  readonly event_time: string | null;
  readonly role?: string;
  readonly content?: string;
  readonly content_start: number;
  readonly content_end: number;
  readonly content_complete: boolean;
  readonly original_complete: boolean;
  readonly retained_extent: "body" | "excerpt" | "gist";
  readonly scope_class?: string;
  readonly valid_from?: string | null;
  readonly valid_to?: string | null;
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
  readonly query?: string;
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
    // Enumeration stays unqueried: `query` is accepted so mixed-seed callers can
    // pass a needle without a second SQL path. Membership interleave is the observer.
    void input.query;
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
    const pinned = parseContentCursor(after);
    if (pinned !== null) {
      return this.pageFromContentCursor(input.workspaceId, pinned, limit, byteLimit);
    }
    const family = parseFamilyCursor(after) ?? (
      after === null || after.startsWith("r:")
        ? {
          recordsAfter: after,
          capsulesAfter: null,
          recordsDone: false,
          capsulesDone: false
        }
        : null
    );
    if (family !== null) {
      return this.pageFamilies(input.workspaceId, family, limit, byteLimit);
    }
    if (after !== null && after.startsWith("c:")) {
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
      if (unbounded) {
        const row = this.records.findById(workspaceId, target.root_id);
        if (row === null) {
          return { row: null, rowsRead: 0, bytesRead: 0, unavailable: true };
        }
        const mapped = mapRecord(
          row,
          row.source_body !== null ? Math.max(1, Buffer.byteLength(row.source_body, "utf8")) : byteLimit,
          0
        );
        return hydrateMapped(mapped, target, row.source_body === null ? 0 : Buffer.byteLength(row.record_id, "utf8"));
      }
      const bounded = this.records.findByIdBounded(workspaceId, target.root_id, byteLimit, offset);
      if (bounded === null) {
        return { row: null, rowsRead: 0, bytesRead: 0, unavailable: true };
      }
      const mapped = mapBoundedRecord(bounded, offset);
      return hydrateMapped(mapped, target, bounded.prefixBytes);
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

  private pageFromContentCursor(
    workspaceId: string,
    pin: ContentCursor,
    limit: number,
    byteLimit: number
  ): SourceRootPage {
    const continued = this.readPinnedChunk(workspaceId, pin, byteLimit);
    if (continued === null) {
      return pin.kind === "source_record"
        ? this.pageAfterRecord(workspaceId, pin.rootId, limit, byteLimit)
        : this.pageCapsules(workspaceId, null, limit, byteLimit);
    }
    if (limit === 1) {
      return { ...continued.page, truncated: true };
    }
    const rest = pin.kind === "source_record"
      ? this.pageAfterCollection(workspaceId, continued.collectionCursor, limit - 1, byteLimit)
      : this.pageCapsules(workspaceId, continued.collectionCursor, limit - 1, byteLimit);
    return mergePages(continued.page, rest);
  }

  private readPinnedChunk(
    workspaceId: string,
    pin: ContentCursor,
    byteLimit: number
  ): Readonly<{
    readonly page: SourceRootPage;
    readonly collectionCursor: string | null;
  }> | null {
    if (pin.kind === "source_record") {
      const bounded = this.records.findByIdBounded(workspaceId, pin.rootId, byteLimit, pin.offset);
      if (bounded === null) return null;
      const mapped = mapBoundedRecord(bounded, pin.offset);
      if (mapped === null) return null;
      const collectionCursor = encodeRecordCursor({
        afterRecordedAt: bounded.record.recorded_at,
        afterRecordId: bounded.record.record_id
      });
      return { page: singleRowPage(mapped, bounded.prefixBytes, collectionCursor), collectionCursor };
    }
    const capsule = this.capsules.getById(pin.rootId);
    if (capsule === null || capsule.workspace_id !== workspaceId || capsule.lifecycle_state !== "active") {
      return null;
    }
    const mapped = mapCapsule(capsule, byteLimit, pin.offset);
    if (mapped === null) return null;
    const collectionCursor = encodeCapsuleCursor({
      afterCreatedAt: capsule.created_at,
      afterObjectId: capsule.object_id
    });
    return {
      page: singleRowPage(mapped, Buffer.byteLength(mapped.content ?? "", "utf8"), collectionCursor),
      collectionCursor
    };
  }

  private pageAfterRecord(
    workspaceId: string,
    recordId: string,
    limit: number,
    byteLimit: number
  ): SourceRootPage {
    const row = this.records.findById(workspaceId, recordId);
    if (row === null) {
      return this.pageCapsules(workspaceId, null, limit, byteLimit);
    }
    return this.pageAfterCollection(
      workspaceId,
      encodeRecordCursor({ afterRecordedAt: row.recorded_at, afterRecordId: row.record_id }),
      limit,
      byteLimit
    );
  }

  private pageAfterCollection(
    workspaceId: string,
    after: string | null,
    limit: number,
    byteLimit: number
  ): SourceRootPage {
    return this.pageFamilies(workspaceId, {
      recordsAfter: after,
      capsulesAfter: null,
      recordsDone: false,
      capsulesDone: false
    }, limit, byteLimit);
  }

  private pageFamilies(
    workspaceId: string,
    family: FamilyCursor,
    limit: number,
    byteLimit: number
  ): SourceRootPage {
    if (family.recordsDone && family.capsulesDone) {
      return emptyPage(false, encodeFamilyCursor(family));
    }
    if (family.recordsDone) {
      return this.pageCapsules(workspaceId, family.capsulesAfter, limit, byteLimit);
    }
    if (family.capsulesDone) {
      const records = this.pageRecords(workspaceId, family.recordsAfter, limit, byteLimit);
      return continueRecords(records, family);
    }
    // Split the page so a full record share cannot hide capsule-only roots.
    const recordShare = Math.max(1, Math.floor(limit / 2));
    const capsuleShare = Math.max(1, limit - Math.floor(limit / 2));
    let records = this.pageRecords(workspaceId, family.recordsAfter, recordShare, byteLimit);
    let capsules = this.pageCapsules(workspaceId, family.capsulesAfter, capsuleShare, byteLimit);
    if (!records.truncated && records.rows.length < recordShare) {
      const extra = recordShare - records.rows.length;
      capsules = mergePages(
        capsules,
        this.pageCapsules(
          workspaceId,
          capsules.committedThrough ?? family.capsulesAfter,
          extra,
          byteLimit
        )
      );
    } else if (!capsules.truncated && capsules.rows.length < capsuleShare) {
      const extra = capsuleShare - capsules.rows.length;
      records = mergePages(
        records,
        this.pageRecords(
          workspaceId,
          records.committedThrough ?? family.recordsAfter,
          extra,
          byteLimit
        )
      );
    }
    return mergeFamilyPages(records, capsules, family);
  }

  private pageRecords(
    workspaceId: string,
    after: string | null,
    limit: number,
    byteLimit: number
  ): SourceRootPage {
    const cursor = parseRecordCursor(after);
    const page = this.records.listPageBounded(workspaceId, {
      limit,
      afterRecordedAt: cursor.afterRecordedAt,
      afterRecordId: cursor.afterRecordId
    }, byteLimit);
    const rows = page.rows.flatMap((read) => {
      const mapped = mapBoundedRecord(read, 0);
      return mapped === null ? [] : [mapped];
    });
    const bytesRead = page.rows.reduce((sum, read) => sum + read.prefixBytes, 0);
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
    const bytesRead = page.rows.reduce(
      (sum, row) => sum + Buffer.byteLength(row.excerpt ?? row.gist, "utf8"),
      0
    );
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

function mergePages(left: SourceRootPage, right: SourceRootPage): SourceRootPage {
  return {
    rows: [...left.rows, ...right.rows],
    nativeVisits: left.nativeVisits + right.nativeVisits,
    nativeBytes: left.nativeBytes + right.nativeBytes,
    rowsRead: left.rowsRead + right.rowsRead,
    bytesRead: left.bytesRead + right.bytesRead,
    truncated: left.truncated || right.truncated,
    committedThrough: right.committedThrough ?? left.committedThrough,
    unavailable: false
  };
}

function continueRecords(records: SourceRootPage, family: FamilyCursor): SourceRootPage {
  if (!records.truncated) return records;
  return {
    ...records,
    committedThrough: encodeFamilyCursor({
      recordsAfter: records.committedThrough,
      capsulesAfter: family.capsulesAfter,
      recordsDone: false,
      capsulesDone: true
    })
  };
}

function mergeFamilyPages(
  records: SourceRootPage,
  capsules: SourceRootPage,
  prior: FamilyCursor
): SourceRootPage {
  const next: FamilyCursor = {
    recordsAfter: records.committedThrough ?? prior.recordsAfter,
    capsulesAfter: capsules.committedThrough ?? prior.capsulesAfter,
    recordsDone: !records.truncated,
    capsulesDone: !capsules.truncated
  };
  const truncated = !next.recordsDone || !next.capsulesDone;
  return {
    rows: [...records.rows, ...capsules.rows],
    nativeVisits: records.nativeVisits + capsules.nativeVisits,
    nativeBytes: records.nativeBytes + capsules.nativeBytes,
    rowsRead: records.rowsRead + capsules.rowsRead,
    bytesRead: records.bytesRead + capsules.bytesRead,
    truncated,
    committedThrough: familyCommittedThrough(next, truncated),
    unavailable: false
  };
}

function familyCommittedThrough(next: FamilyCursor, truncated: boolean): string | null {
  if (!truncated) return next.capsulesAfter ?? next.recordsAfter;
  // Records-done continues as a capsule cursor so a later `r:` does not restart capsules.
  if (next.recordsDone) return next.capsulesAfter;
  return encodeFamilyCursor(next);
}

function singleRowPage(
  row: SourceRootRow,
  bytesRead: number,
  committedThrough: string | null
): SourceRootPage {
  return {
    rows: [row],
    nativeVisits: 1,
    nativeBytes: bytesRead,
    rowsRead: 1,
    bytesRead,
    truncated: false,
    committedThrough,
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
    ...sourceRecordRoot(row),
    content: chunk.text,
    content_start: chunk.start,
    content_end: chunk.end,
    content_complete: chunk.complete
  };
}

function mapBoundedRecord(read: BoundedSourceRecordRead, offset: number): SourceRootRow | null {
  if (read.invalidOffset || read.record.source_body === null) return null;
  const end = offset + read.prefixBytes;
  return {
    ...sourceRecordRoot(read.record),
    content: read.record.source_body,
    content_start: offset,
    content_end: end,
    content_complete: end === read.bodyBytes
  };
}

function sourceRecordRoot(row: FieldSourceRecordRow): Omit<
  SourceRootRow,
  "content" | "content_start" | "content_end" | "content_complete"
> {
  const role = speakerRole(row.speaker);
  const scopeClass = sourceScopeClass(row.scope_class);
  return {
    kind: "source_record",
    workspace_id: row.workspace_id,
    root_id: row.record_id,
    revision: row.source_version,
    digest: row.content_digest,
    evidence_object_id: row.evidence_object_id,
    ...(verifiedEvidenceBind(row.evidence_object_id) ? { evidence_verified: true } : {}),
    event_time: row.event_time,
    ...(role === undefined ? {} : { role }),
    original_complete: true,
    retained_extent: "body",
    ...(scopeClass === undefined ? {} : { scope_class: scopeClass }),
    valid_from: row.valid_from,
    valid_to: row.valid_to
  };
}

function speakerRole(value: string | null | undefined): "user" | "assistant" | "system" | undefined {
  if (value === "user" || value === "assistant" || value === "system") return value;
  return undefined;
}

function sourceScopeClass(
  value: string | null | undefined
): "project" | "global_domain" | "global_core" | undefined {
  if (value === "project" || value === "global_domain" || value === "global_core") return value;
  return undefined;
}

function verifiedEvidenceBind(evidenceObjectId: string | null): boolean {
  return evidenceObjectId !== null && evidenceObjectId.length > 0;
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
    evidence_verified: true,
    event_time: eventTimeOf(capsule),
    content: chunk.text,
    content_start: chunk.start,
    content_end: chunk.end,
    content_complete: chunk.complete,
    // Capsule gist/excerpt are retained reductions, not the original body.
    original_complete: false,
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

function hydrateMapped(
  mapped: SourceRootRow | null,
  target: SourceEvidenceTarget,
  fallbackBytes: number
): SourceRootHydratePage {
  if (mapped === null || !sameSourceIdentity(mapped, target)) {
    return { row: null, rowsRead: 1, bytesRead: fallbackBytes, unavailable: true };
  }
  return {
    row: mapped,
    rowsRead: 1,
    bytesRead: hydrateBytes(mapped),
    unavailable: false,
    ...(mapped.content_complete ? {} : { resourceLimited: true })
  };
}

export type ContentCursor = Readonly<{
  readonly kind: SourceRootKind;
  readonly rootId: string;
  readonly offset: number;
}>;

export function encodeContentCursor(input: ContentCursor): string {
  return `o:${input.kind}\t${input.rootId}\t${input.offset}`;
}

export function parseContentCursor(cursor: string | null | undefined): ContentCursor | null {
  if (cursor == null || !cursor.startsWith("o:")) return null;
  const payload = cursor.slice(2);
  const first = payload.indexOf("\t");
  const second = first < 0 ? -1 : payload.indexOf("\t", first + 1);
  if (first <= 0 || second <= first) return null;
  const kind = payload.slice(0, first);
  const rootId = payload.slice(first + 1, second);
  const offset = Number(payload.slice(second + 1));
  if (kind !== "source_record" && kind !== "evidence_capsule") return null;
  if (rootId.length === 0 || !Number.isSafeInteger(offset) || offset < 0) return null;
  return { kind, rootId, offset };
}

type FamilyCursor = Readonly<{
  readonly recordsAfter: string | null;
  readonly capsulesAfter: string | null;
  readonly recordsDone: boolean;
  readonly capsulesDone: boolean;
}>;

function encodeFamilyCursor(input: FamilyCursor): string {
  return `f:${input.recordsDone ? "1" : "0"}${input.capsulesDone ? "1" : "0"}\n${input.recordsAfter ?? ""}\n${input.capsulesAfter ?? ""}`;
}

function parseFamilyCursor(cursor: string | null | undefined): FamilyCursor | null {
  if (cursor == null || !cursor.startsWith("f:") || cursor.length < 5) return null;
  const recordsDoneFlag = cursor[2];
  const capsulesDoneFlag = cursor[3];
  if (
    (recordsDoneFlag !== "0" && recordsDoneFlag !== "1")
    || (capsulesDoneFlag !== "0" && capsulesDoneFlag !== "1")
    || cursor[4] !== "\n"
  ) {
    return null;
  }
  const rest = cursor.slice(5);
  const split = rest.indexOf("\n");
  if (split < 0) return null;
  const recordsAfter = rest.slice(0, split);
  const capsulesAfter = rest.slice(split + 1);
  if (capsulesAfter.includes("\n")) return null;
  return {
    recordsAfter: recordsAfter === "" ? null : recordsAfter,
    capsulesAfter: capsulesAfter === "" ? null : capsulesAfter,
    recordsDone: recordsDoneFlag === "1",
    capsulesDone: capsulesDoneFlag === "1"
  };
}

export { encodeRecordCursor, parseRecordCursor, encodeCapsuleCursor, parseCapsuleCursor };
