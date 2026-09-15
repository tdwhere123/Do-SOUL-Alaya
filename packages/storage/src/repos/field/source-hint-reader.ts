import type { SqliteConnection } from "../../sqlite/db.js";
import type { SourceRootPage, SourceRootRow } from "./bounded-source-root-reader.js";

const PAGE_MAX = 512;

export type BoundInterpretationHintRow = Readonly<{
  readonly object_id: string;
  readonly gist: string;
}>;

export type BoundInterpretationHintPage = Readonly<{
  readonly rows: readonly BoundInterpretationHintRow[];
  readonly nativeVisits: number;
  readonly nativeBytes: number;
  readonly rowsRead: number;
  readonly bytesRead: number;
  readonly truncated: boolean;
  readonly committedThrough: string | null;
  readonly unavailable: boolean;
  readonly resourceLimited?: boolean;
}>;

export class SqliteSourceHintReader {
  public constructor(private readonly db: SqliteConnection) {}

  public pageBoundInterpretations(input: Readonly<{
    readonly workspaceId: string;
    readonly limit: number;
    readonly nativeLimit: number;
    readonly afterCursor: string | null;
  }>): BoundInterpretationHintPage {
    const limit = boundedLimit(input.limit, input.nativeLimit);
    if (limit === 0) return emptyBoundPage(true, input.afterCursor);
    const take = limit + 1;
    const rows = this.db.prepare(`
      SELECT object_id, gist FROM evidence_capsules
      WHERE workspace_id = ?
        AND json_valid(gist)
        AND json_extract(gist, '$.contract') = 'source-interpretation-v1'
        AND object_id > ?
      ORDER BY object_id
      LIMIT ?
    `).all(input.workspaceId, input.afterCursor ?? "", take) as BoundInterpretationHintRow[];
    const truncated = rows.length > limit;
    const page = truncated ? rows.slice(0, limit) : rows;
    const bytes = page.reduce((sum, row) => sum + Buffer.byteLength(row.gist, "utf8"), 0);
    return {
      rows: page,
      nativeVisits: page.length,
      nativeBytes: bytes,
      rowsRead: page.length,
      bytesRead: bytes,
      truncated,
      committedThrough: page.at(-1)?.object_id ?? input.afterCursor,
      unavailable: false
    };
  }

  public pageSourceTextHints(input: Readonly<{
    readonly workspaceId: string;
    readonly phrases: readonly string[];
    readonly limit: number;
    readonly nativeLimit: number;
    readonly afterCursor: string | null;
    readonly byteLimit?: number;
  }>): SourceRootPage {
    const limit = boundedLimit(input.limit, input.nativeLimit);
    if (limit === 0) return emptySourcePage(true, input.afterCursor);
    const phrases = input.phrases.filter((phrase) => phrase.length > 0).slice(0, 8);
    if (phrases.length === 0) return emptySourcePage(false, input.afterCursor);
    const filters = phrases.map(() => "instr(lower(COALESCE(source_body, '')), ?) > 0").join(" AND ");
    const take = limit + 1;
    const rows = this.db.prepare(`
      SELECT record_id, source_version, content_digest, evidence_object_id, event_time,
        source_body, speaker, scope_class
      FROM source_records
      WHERE workspace_id = ? AND record_id > ? AND ${filters}
      ORDER BY record_id
      LIMIT ?
    `).all(input.workspaceId, input.afterCursor ?? "", ...phrases.map((phrase) => phrase.toLowerCase()), take) as SourceTextRow[];
    const truncated = rows.length > limit;
    const page = truncated ? rows.slice(0, limit) : rows;
    const mapped = page.map((row) => mapHintRow(input.workspaceId, row, input.byteLimit ?? 65_536));
    const bytes = mapped.reduce((sum, row) => sum + Buffer.byteLength(row.content ?? "", "utf8"), 0);
    return {
      rows: mapped,
      nativeVisits: mapped.length,
      nativeBytes: bytes,
      rowsRead: mapped.length,
      bytesRead: bytes,
      nativeWork: Math.max(1, mapped.length * 5),
      truncated,
      committedThrough: mapped.at(-1)?.root_id ?? input.afterCursor,
      unavailable: false
    };
  }
}

type SourceTextRow = Readonly<{
  readonly record_id: string;
  readonly source_version: string;
  readonly content_digest: string;
  readonly evidence_object_id: string | null;
  readonly event_time: string | null;
  readonly source_body: string | null;
  readonly speaker: string | null;
  readonly scope_class: string | null;
}>;

function mapHintRow(workspaceId: string, row: SourceTextRow, byteLimit: number): SourceRootRow {
  const content = (row.source_body ?? "").slice(0, byteLimit);
  return {
    kind: "source_record",
    workspace_id: workspaceId,
    root_id: row.record_id,
    revision: row.source_version,
    digest: row.content_digest,
    evidence_object_id: row.evidence_object_id,
    event_time: row.event_time,
    ...(row.speaker === null ? {} : { role: row.speaker }),
    content,
    content_start: 0,
    content_end: Buffer.byteLength(content, "utf8"),
    content_complete: content.length === (row.source_body ?? "").length,
    original_complete: true,
    retained_extent: "body",
    ...(row.scope_class === null ? {} : { scope_class: row.scope_class })
  };
}

function boundedLimit(limit: number, nativeLimit: number): number {
  if (!Number.isSafeInteger(limit) || limit < 0 || limit > PAGE_MAX
    || !Number.isSafeInteger(nativeLimit) || nativeLimit < 0 || nativeLimit > PAGE_MAX) {
    throw new Error("invalid source-hint page limit");
  }
  return Math.min(limit, nativeLimit);
}

function emptyBoundPage(truncated: boolean, after: string | null): BoundInterpretationHintPage {
  return {
    rows: [], nativeVisits: 0, nativeBytes: 0, rowsRead: 0, bytesRead: 0,
    truncated, committedThrough: after, unavailable: false
  };
}

function emptySourcePage(truncated: boolean, after: string | null): SourceRootPage {
  return {
    rows: [], nativeVisits: 0, nativeBytes: 0, rowsRead: 0, bytesRead: 0,
    nativeWork: 0, truncated, committedThrough: after, unavailable: false
  };
}
