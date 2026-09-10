import {
  type SourceEvidenceTarget
} from "@do-soul/alaya-protocol";
import type { BoundedCapsuleSource, BoundedCapsuleSourceReader } from "../capsules/reads/bounded-capsule-source-reader.js";
import {
  encodeCapsuleCursor,
  parseCapsuleCursor,
  SqliteEvidenceCapsuleRepo
} from "../capsules/evidence-capsule-repo.js";
import {
  encodeRecordCursor,
  parseRecordCursor,
  SqliteFieldSourceRecordRepo,
  trimUtf8Prefix,
  type BoundedSourceRecordRead
} from "./source-repo.js";
import type { FieldSourceRecordRow } from "./ports.js";
import { RETAINED_SOURCE_READ_RESERVATION } from "./retained-source-chunks.js";

const PAGE_MAX = 512;
const DEFAULT_BYTE_LIMIT = 65_536;

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
  readonly metadataBytes?: number;
  readonly nativeWork?: number;
  readonly truncated: boolean;
  readonly committedThrough: string | null;
  readonly unavailable: boolean;
  readonly resourceLimited?: boolean;
}>;

export type SourceRootHydratePage = Readonly<{
  readonly row: SourceRootRow | null;
  readonly rowsRead: number;
  readonly bytesRead: number;
  readonly metadataBytes?: number;
  readonly nativeWork?: number;
  readonly unavailable: boolean;
  readonly resourceLimited?: boolean;
}>;

export type SourceRootPageInput = Readonly<{
  readonly workspaceId: string;
  readonly query?: string;
  readonly limit: number;
  readonly nativeLimit: number;
  readonly workLimit?: number;
  readonly afterCursor: string | null;
  readonly byteLimit?: number;
  /** Total physical chunk and metadata allowance; logical byteLimit only clips exposed content. */
  readonly nativeByteLimit?: number;
}>;

export class SqliteSourceRootRecallReader {
  private readonly records: SqliteFieldSourceRecordRepo;
  private readonly boundedCapsules: BoundedCapsuleSourceReader;

  public constructor(
    records: SqliteFieldSourceRecordRepo,
    capsules: SqliteEvidenceCapsuleRepo
  ) {
    this.records = records;
    this.boundedCapsules = capsules.boundedSourceReader();
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
    const nativeByteLimit = input.nativeByteLimit ?? byteLimit;
    if (!Number.isSafeInteger(byteLimit) || byteLimit < 1 || byteLimit > DEFAULT_BYTE_LIMIT) {
      throw new Error("invalid source-root byte limit");
    }
    if (limit === 0) {
      return emptyPage(true, input.afterCursor);
    }
    if (!Number.isSafeInteger(nativeByteLimit) || nativeByteLimit < 0) throw new Error("invalid source-root native byte limit");
    if (nativeByteLimit < RETAINED_SOURCE_READ_RESERVATION) {
      return { ...emptyPage(true, input.afterCursor), resourceLimited: true };
    }
    const after = input.afterCursor;
    const pinned = parseContentCursor(after);
    if (pinned !== null) {
      if ((input.workLimit ?? Infinity) < 5) return emptyPage(true, after);
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
      return this.pageFamilies(input.workspaceId, family, limit, byteLimit, input.workLimit, nativeByteLimit);
    }
    if (after !== null && after.startsWith("c:")) {
      return this.pageFamilies(input.workspaceId, { recordsAfter: null, capsulesAfter: after,
        recordsDone: true, capsulesDone: false }, limit, byteLimit, input.workLimit, nativeByteLimit);
    }
    return this.pageFamilies(input.workspaceId, { recordsAfter: null, capsulesAfter: null,
      recordsDone: true, capsulesDone: false }, limit, byteLimit, input.workLimit, nativeByteLimit);
  }

  public load(
    workspaceId: string,
    target: SourceEvidenceTarget
  ): SourceRootHydratePage {
    return this.read(workspaceId, target, DEFAULT_BYTE_LIMIT, 0);
  }

  public hydrate(
    workspaceId: string,
    target: SourceEvidenceTarget,
    byteLimit = DEFAULT_BYTE_LIMIT,
    offset = 0,
    nativeByteLimit = byteLimit
  ): SourceRootHydratePage {
    if (!Number.isSafeInteger(nativeByteLimit) || nativeByteLimit < 0) throw new Error("invalid source-root native byte limit");
    if (nativeByteLimit < RETAINED_SOURCE_READ_RESERVATION) return {
      row: null, rowsRead: 0, bytesRead: 0, unavailable: false, resourceLimited: true };
    return this.read(workspaceId, target, byteLimit, offset);
  }

  private read(
    workspaceId: string,
    target: SourceEvidenceTarget,
    byteLimit: number,
    offset: number
  ): SourceRootHydratePage {
    if (
      !Number.isSafeInteger(byteLimit) || byteLimit < 1 || byteLimit > DEFAULT_BYTE_LIMIT
    ) {
      throw new Error("invalid source-root byte limit");
    }
    if (target.workspace_id !== workspaceId) {
      return { row: null, rowsRead: 0, bytesRead: 0, unavailable: true };
    }
    if (target.root_kind === "source_record") {
      const bounded = this.records.findByIdBounded(workspaceId, target.root_id, byteLimit, offset);
      if (bounded === null) {
        return { row: null, rowsRead: 0, bytesRead: 0, unavailable: true };
      }
      const mapped = mapBoundedRecord(bounded, offset);
      return { ...hydrateMapped(mapped, target, bounded.nativeBytes), metadataBytes: bounded.metadataBytes,
        nativeWork: 5 };
    }
    const capsule = this.boundedCapsules.read(workspaceId, target.root_id, byteLimit, offset);
    if (capsule === null) {
      return { row: null, rowsRead: 0, bytesRead: 0, unavailable: true };
    }
    const mapped = mapBoundedCapsule(capsule, byteLimit, offset);
    if (mapped === null || !sameSourceIdentity(mapped, target)) {
      return { row: null, rowsRead: 1, bytesRead: capsule.nativeBytes,
        metadataBytes: capsuleMetadataBytes(capsule), nativeWork: 2, unavailable: true };
    }
    return {
      row: mapped,
      rowsRead: 1,
      bytesRead: capsule.nativeBytes,
      metadataBytes: capsuleMetadataBytes(capsule),
      nativeWork: 2,
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
    void limit;
    if (continued === null) return { ...emptyPage(true, encodeContentCursor(pin)), unavailable: true };
    return { ...continued.page, truncated: true,
      committedThrough: pin.afterCursor ?? continued.collectionCursor };
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
      if (bounded === null || bounded.record === null) return null;
      const mapped = mapBoundedRecord(bounded, pin.offset);
      if (mapped === null) return null;
      const collectionCursor = encodeRecordCursor({
        afterRecordedAt: bounded.record.recorded_at,
        afterRecordId: bounded.record.record_id
      });
      return { page: { ...singleRowPage(mapped, bounded.nativeBytes, collectionCursor), metadataBytes: bounded.metadataBytes,
        nativeWork: 5 }, collectionCursor };
    }
    const capsule = this.boundedCapsules.read(workspaceId, pin.rootId, byteLimit, pin.offset);
    if (capsule === null) {
      return null;
    }
    const mapped = mapBoundedCapsule(capsule, byteLimit, pin.offset);
    if (mapped === null) return null;
    const collectionCursor = encodeCapsuleCursor({
      afterCreatedAt: capsule.created_at,
      afterObjectId: capsule.object_id
    });
    return {
      page: { ...singleRowPage(mapped, capsule.nativeBytes, collectionCursor),
        metadataBytes: capsuleMetadataBytes(capsule), nativeWork: 2 },
      collectionCursor
    };
  }

  private pageFamilies(
    workspaceId: string,
    family: FamilyCursor,
    limit: number,
    byteLimit: number,
    workLimit = Number.MAX_SAFE_INTEGER,
    nativeByteLimit = DEFAULT_BYTE_LIMIT
  ): SourceRootPage {
    let next = family;
    let result = emptyPage(true, encodeFamilyCursor(family));
    while (result.nativeVisits < limit && (!next.recordsDone || !next.capsulesDone)) {
      const takeCapsule = next.recordsDone || !next.capsulesDone && next.nextFamily === "capsule";
      const minimum = 5;
      if (workLimit - (result.nativeWork ?? 0) < minimum) break;
      if (nativeByteLimit - result.bytesRead - (result.metadataBytes ?? 0) < RETAINED_SOURCE_READ_RESERVATION) {
        result = { ...result, resourceLimited: true };
        break;
      }
      const page = takeCapsule ? this.pageCapsules(workspaceId, next.capsulesAfter, 1, byteLimit)
        : this.pageRecords(workspaceId, next.recordsAfter, 1, byteLimit);
      result = mergePages(result, page);
      next = { ...next, nextFamily: takeCapsule ? "record" : "capsule",
        ...(takeCapsule ? { capsulesAfter: page.committedThrough, capsulesDone: !page.truncated }
          : { recordsAfter: page.committedThrough, recordsDone: !page.truncated }) };
      if (page.unavailable) break;
    }
    return { ...result, committedThrough: encodeFamilyCursor(next), truncated: !next.recordsDone || !next.capsulesDone };
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
    const bytesRead = page.rows.reduce((sum, read) => sum + read.nativeBytes, 0);
    return {
      rows,
      nativeVisits: page.rows.length,
      nativeBytes: bytesRead,
      rowsRead: page.rows.length,
      bytesRead,
      metadataBytes: page.rows.reduce((sum, row) => sum + row.metadataBytes, 0),
      nativeWork: Math.max(1, page.rows.length * 5),
      truncated: page.truncated,
      committedThrough: page.committedThrough,
      unavailable: page.unavailable === true
    };
  }

  private pageCapsules(
    workspaceId: string,
    after: string | null,
    limit: number,
    byteLimit: number
  ): SourceRootPage {
    const cursor = parseCapsuleCursor(after);
    const candidates = this.boundedCapsules.page(workspaceId, cursor, limit, byteLimit);
    const rows = candidates.flatMap((row) => {
      const mapped = row.linked === 1 ? null : mapBoundedCapsule(row, byteLimit, 0);
      return mapped === null ? [] : [mapped];
    });
    const bytesRead = candidates.reduce(
      (sum, row) => sum + row.nativeBytes,
      0
    );
    return {
      rows,
      nativeVisits: candidates.length,
      nativeBytes: bytesRead,
      rowsRead: candidates.length,
      bytesRead,
      metadataBytes: candidates.reduce((sum, row) => sum + capsuleMetadataBytes(row), 0),
      nativeWork: Math.max(1, candidates.length * 5),
      truncated: candidates.length === limit,
      committedThrough: candidates.length === 0 ? after : encodeCapsuleCursor({
        afterCreatedAt: candidates.at(-1)!.created_at, afterObjectId: candidates.at(-1)!.object_id
      }),
      unavailable: candidates.some((row) => row.linked === 0 && (row.digest === null || row.prefix === null))
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
    metadataBytes: (left.metadataBytes ?? 0) + (right.metadataBytes ?? 0),
    nativeWork: (left.nativeWork ?? left.nativeVisits) + (right.nativeWork ?? right.nativeVisits),
    truncated: left.truncated || right.truncated,
    committedThrough: right.committedThrough ?? left.committedThrough,
    unavailable: left.unavailable || right.unavailable
  };
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

function mapBoundedRecord(read: BoundedSourceRecordRead, offset: number): SourceRootRow | null {
  if (read.invalidOffset || read.record === null || read.record.source_body === null) return null;
  const end = offset + read.prefixBytes;
  return {
    ...sourceRecordRoot(read.record, read.evidenceVerified),
    content: read.record.source_body,
    content_start: offset,
    content_end: end,
    content_complete: end === read.bodyBytes
  };
}

function sourceRecordRoot(row: FieldSourceRecordRow, evidenceVerified: boolean): Omit<
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
    evidence_object_id: evidenceVerified ? row.evidence_object_id : null,
    ...(evidenceVerified ? { evidence_verified: true } : {}),
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

function mapBoundedCapsule(
  capsule: BoundedCapsuleSource,
  byteLimit: number,
  offset: number
): SourceRootRow | null {
  if (capsule.prefix === null || capsule.digest === null || capsule.body_bytes === null
    || offset > capsule.body_bytes || (capsule.prefix.length > 0 && (capsule.prefix[0]! & 0xc0) === 0x80)) return null;
  const text = trimUtf8Prefix(capsule.prefix, byteLimit).toString("utf8");
  return {
    kind: "evidence_capsule",
    workspace_id: capsule.workspace_id,
    root_id: capsule.object_id,
    revision: capsule.updated_at,
    digest: capsule.digest,
    evidence_object_id: capsule.object_id,
    evidence_verified: true,
    event_time: capsule.event_time,
    content: text,
    content_start: offset,
    content_end: offset + Buffer.byteLength(text, "utf8"),
    content_complete: offset + Buffer.byteLength(text, "utf8") === capsule.body_bytes,
    // Capsule gist/excerpt are retained reductions, not the original body.
    original_complete: false,
    retained_extent: capsule.retained_extent
  };
}

function capsuleMetadataBytes(row: BoundedCapsuleSource): number {
  return Object.entries(row).reduce((sum, [key, value]) =>
    sum + (key !== "prefix" && typeof value === "string" ? Buffer.byteLength(value, "utf8") : 0), row.metadataBytes ?? 0);
}

function sameSourceIdentity(row: SourceRootRow, target: SourceEvidenceTarget): boolean {
  return row.kind === target.root_kind
    && row.root_id === target.root_id
    && row.revision === target.source_version
    && row.digest === target.content_digest
    && row.evidence_object_id === target.evidence_object_id;
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
    bytesRead: fallbackBytes,
    unavailable: false,
    ...(mapped.content_complete ? {} : { resourceLimited: true })
  };
}

export type ContentCursor = Readonly<{
  readonly kind: SourceRootKind;
  readonly rootId: string;
  readonly offset: number;
  readonly afterCursor?: string;
}>;

export function encodeContentCursor(input: ContentCursor): string {
  if (input.afterCursor !== undefined) return `o:${JSON.stringify(input)}`;
  return `o:${input.kind}\t${input.rootId}\t${input.offset}`;
}

export function parseContentCursor(cursor: string | null | undefined): ContentCursor | null {
  if (cursor == null || !cursor.startsWith("o:")) return null;
  if (cursor.startsWith("o:{")) {
    try {
      const value = JSON.parse(cursor.slice(2)) as Partial<ContentCursor>;
      if ((value.kind !== "source_record" && value.kind !== "evidence_capsule")
        || typeof value.rootId !== "string" || !Number.isSafeInteger(value.offset) || value.offset! < 0) return null;
      return { kind: value.kind, rootId: value.rootId, offset: value.offset!,
        ...(typeof value.afterCursor === "string" ? { afterCursor: value.afterCursor } : {}) };
    } catch { return null; }
  }
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
  readonly nextFamily?: "record" | "capsule";
}>;

function encodeFamilyCursor(input: FamilyCursor): string {
  return `f:${JSON.stringify(input)}`;
}

function parseFamilyCursor(cursor: string | null | undefined): FamilyCursor | null {
  if (cursor?.startsWith("f:{")) {
    try {
      const value = JSON.parse(cursor.slice(2)) as FamilyCursor;
      if ((value.recordsAfter !== null && typeof value.recordsAfter !== "string")
        || (value.capsulesAfter !== null && typeof value.capsulesAfter !== "string")
        || typeof value.recordsDone !== "boolean" || typeof value.capsulesDone !== "boolean") return null;
      return value;
    } catch { return null; }
  }
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
