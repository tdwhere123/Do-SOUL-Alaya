import type { SqliteConnection } from "../../sqlite/db.js";
import type { SourceRootPage, SourceRootRow } from "./bounded-source-root-reader.js";

const PAGE_MAX = 512;
const GIST_BYTE_MAX = 65_536;

export type BoundInterpretationHintRow = Readonly<{ object_id: string; gist: string }>;
export type BoundInterpretationHintPage = Readonly<{
  rows: readonly BoundInterpretationHintRow[];
  nativeVisits: number;
  nativeBytes: number;
  nativeWork?: number;
  rowsRead: number;
  bytesRead: number;
  truncated: boolean;
  committedThrough: string | null;
  unavailable: boolean;
  resourceLimited?: boolean;
}>;

/** Mechanical bounded candidates. Core supplies matching; hydration owns eligibility. */
export class SqliteSourceHintReader {
  public constructor(private readonly db: SqliteConnection) {}

  public pageBoundInterpretations(input: Readonly<{
    workspaceId: string; limit: number; nativeLimit: number; afterCursor: string | null;
    matches?: (gist: string) => boolean; nativeByteLimit?: number;
  }>): BoundInterpretationHintPage {
    const limit = boundedLimit(input.limit);
    const nativeLimit = limit === 0 ? 0 : boundedLimit(input.nativeLimit);
    const byteBudget = boundedBytes(input.nativeByteLimit);
    if (byteBudget < 520) return { rows: [], nativeVisits: 0, nativeWork: 0, nativeBytes: 0,
      rowsRead: 0, bytesRead: 0, truncated: true, committedThrough: input.afterCursor,
      unavailable: false, resourceLimited: true };
    const rows: BoundInterpretationHintRow[] = [];
    let visits = 0;
    let bytes = 0;
    let committed = input.afterCursor;
    let oversized = false;
    // Each bounded keyset step uses the remaining byte allowance. Reserving a
    // maximum gist for every possible future row would starve small corpora.
    const candidate = this.db.prepare(`SELECT CASE WHEN octet_length(object_id)<=512 THEN object_id ELSE NULL END AS object_id,
      octet_length(gist) AS gist_bytes,
      CASE WHEN octet_length(gist) <= ? THEN gist ELSE NULL END AS gist
      FROM evidence_capsules WHERE workspace_id=? AND object_id>?
      ORDER BY evidence_capsules.object_id LIMIT 1`);
    while (visits < nativeLimit) {
      if (byteBudget - bytes < 520) { oversized = true; break; }
      const row = candidate.get(Math.min(GIST_BYTE_MAX, byteBudget - bytes - 520),
        input.workspaceId, committed ?? "") as { object_id: string | null; gist: string | null; gist_bytes: number } | undefined;
      if (row === undefined) break;
      visits++;
      bytes += 8;
      if (row.object_id === null) { oversized = true; break; }
      bytes += Buffer.byteLength(row.object_id, "utf8") + Buffer.byteLength(row.gist ?? "", "utf8");
      if (row.gist === null && row.gist_bytes <= GIST_BYTE_MAX) { oversized = true; break; }
      committed = row.object_id;
      if (row.gist === null) { oversized = true; continue; }
      if (input.matches !== undefined && !input.matches(row.gist)) continue;
      rows.push({ object_id: row.object_id, gist: row.gist });
      if (rows.length >= limit) break;
    }
    return { rows, nativeVisits: visits, nativeBytes: 0, nativeWork: visits,
      rowsRead: visits, bytesRead: bytes,
      truncated: oversized || visits === nativeLimit || rows.length === limit,
      committedThrough: committed, unavailable: false,
      ...(oversized ? { resourceLimited: true } : {}) };
  }

  public pageSourceTextHints(input: Readonly<{
    workspaceId: string; phrases: readonly string[]; limit: number;
    nativeLimit: number; afterCursor: string | null; byteLimit?: number; nativeByteLimit?: number;
  }>): SourceRootPage {
    const limit = Math.min(boundedLimit(input.limit), boundedLimit(input.nativeLimit),
      Math.floor(boundedBytes(input.nativeByteLimit) / 2048));
    const candidates = this.db.prepare(`SELECT
      CASE WHEN bytes<=2048 THEN record_id ELSE NULL END AS record_id,
      CASE WHEN bytes<=2048 THEN source_version ELSE NULL END AS source_version,
      CASE WHEN bytes<=2048 THEN content_digest ELSE NULL END AS content_digest,
      CASE WHEN bytes<=2048 THEN evidence_object_id ELSE NULL END AS evidence_object_id
      FROM (SELECT record_id, source_version, content_digest, evidence_object_id,
        octet_length(record_id)+octet_length(source_version)+octet_length(content_digest)
          +coalesce(octet_length(evidence_object_id),0) AS bytes
        FROM source_records WHERE workspace_id=? AND record_id>? ORDER BY record_id LIMIT ?)
      `).all(input.workspaceId, input.afterCursor ?? "", limit) as {
        record_id: string | null; source_version: string; content_digest: string; evidence_object_id: string | null;
      }[];
    const oversized = candidates.some((row) => row.record_id === null);
    const rows: SourceRootRow[] = [];
    for (const row of candidates) {
      if (row.record_id === null) break;
      rows.push({
      kind: "source_record", workspace_id: input.workspaceId, root_id: row.record_id,
      revision: row.source_version, digest: row.content_digest, evidence_object_id: row.evidence_object_id,
      event_time: null, content_start: 0, content_end: 0, content_complete: false,
      original_complete: false, retained_extent: "body"
      });
    }
    const bytes = candidates.reduce((sum, row) => sum + Object.values(row).reduce<number>(
      (size, value) => size + Buffer.byteLength(value ?? "", "utf8"), 0), 0);
    return { rows, nativeVisits: candidates.length, nativeBytes: 0, nativeWork: candidates.length,
      rowsRead: candidates.length, bytesRead: bytes, truncated: oversized || candidates.length === limit,
      committedThrough: rows.at(-1)?.root_id ?? input.afterCursor, unavailable: false,
      ...(oversized || limit === 0 && input.limit > 0 ? { resourceLimited: true } : {}) };
  }
}

function boundedLimit(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit < 0 || limit > PAGE_MAX) {
    throw new Error("invalid source-hint page limit");
  }
  return limit;
}

function boundedBytes(limit: number = PAGE_MAX * (GIST_BYTE_MAX + 512)): number {
  if (!Number.isSafeInteger(limit) || limit < 0) throw new Error("invalid source-hint byte limit");
  return limit;
}
