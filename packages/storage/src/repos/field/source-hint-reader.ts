import { AlayaError } from "@do-soul/alaya-protocol";
import type { SqliteConnection } from "../../sqlite/db.js";
import type { SourceRootPage, SourceRootRow } from "./bounded-source-root-reader.js";
import { buildWorkspaceScopedFtsMatch, splitFtsLanes, tokenizeFtsQuery } from "../shared/fts-lane-routing.js";
import { readRecord } from "../shared/parse-row.js";

const PAGE_MAX = 512;
const GIST_BYTE_MAX = 65_536;

type BoundInterpretationHintRow = Readonly<{ object_id: string; gist: string; cursor: string }>;
type BoundInterpretationHeader = Readonly<{
  object_id: string; source_hash: string | null; lifecycle_state: string; cursor: string;
}>;
type TextHintCursor = {
  workspace: string; query: string; rowids: [string | null, string | null];
  done: [boolean, boolean]; turn: 0 | 1;
};
const ROWID_READ_BYTES = 24;
const HEADER_READ_BYTES = 784;
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

  /** Indexed lexical candidates; exact scope/lifecycle rejection still consumes a candidate. */
  public pageInterpretationTextHints(input: Readonly<{
    workspaceId: string; query: string; limit: number; nativeLimit: number;
    nativeByteLimit: number; afterCursor: string | null;
  }>) {
    const limit = boundedLimit(input.limit), nativeLimit = boundedLimit(input.nativeLimit);
    const allowance = boundedBytes(input.nativeByteLimit);
    const tokens = splitFtsLanes(tokenizeFtsQuery(input.query));
    const lanes = [tokens.porterTokens, tokens.trigramTokens] as const;
    const cursor = textHintCursor(input, lanes.map((lane) => lane.length === 0));
    const rows: BoundInterpretationHeader[] = [];
    let nativeVisits = 0, bytesRead = 0, inspectedCandidates = 0, resourceLimited = false, unavailable = false;
    try {
      const tables = ["evidence_capsule_fts", "evidence_capsule_fts_trigram"] as const;
      const seeks = tables.map((table) => ({
        first: this.db.prepare(`SELECT rowid FROM ${table} WHERE ${table} MATCH ? ORDER BY rowid LIMIT 1`).safeIntegers(),
        next: this.db.prepare(`SELECT rowid FROM ${table} WHERE ${table} MATCH ? AND rowid>? ORDER BY rowid LIMIT 1`).safeIntegers()
      }));
      const matches = lanes.map((lane) => buildWorkspaceScopedFtsMatch(input.workspaceId, lane));
      const metadata = this.db.prepare(`SELECT
        CASE WHEN octet_length(object_id)<=512 THEN object_id ELSE NULL END AS object_id,
        CASE WHEN octet_length(lifecycle_state)<=64 THEN lifecycle_state ELSE NULL END AS lifecycle_state,
        CASE WHEN octet_length(source_hash)<=128 THEN source_hash ELSE NULL END AS source_hash
        FROM evidence_capsules WHERE rowid=? AND workspace_id=? LIMIT 1`);
      while (inspectedCandidates < limit && !cursor.done.every(Boolean)) {
        // Reserve both indexed operations before observing an identity that needs metadata.
        if (nativeLimit - nativeVisits < 2 || allowance - bytesRead < ROWID_READ_BYTES + HEADER_READ_BYTES) {
          resourceLimited = true; break;
        }
        const lane = cursor.done[cursor.turn] ? (1 - cursor.turn) as 0 | 1 : cursor.turn;
        const after = cursor.rowids[lane], statement = seeks[lane]!;
        nativeVisits++; bytesRead += ROWID_READ_BYTES;
        const found = (after === null ? statement.first.get(matches[lane]!)
          : statement.next.get(matches[lane]!, BigInt(after))) as { rowid: bigint } | undefined;
        cursor.turn = (1 - lane) as 0 | 1;
        if (found === undefined) { cursor.done[lane] = true; continue; }
        inspectedCandidates++; cursor.rowids[lane] = found.rowid.toString();
        nativeVisits++; bytesRead += 16;
        const row = metadata.get(found.rowid, input.workspaceId) as {
          object_id: string | null; lifecycle_state: string | null; source_hash: string | null;
        } | undefined;
        if (row === undefined) continue;
        bytesRead += Object.values(row).reduce((sum, value) => sum + Buffer.byteLength(value ?? ""), 0);
        if (row.object_id === null || row.lifecycle_state === null) { unavailable = true; continue; }
        if (row.lifecycle_state !== "active") continue;
        rows.push({ ...row, object_id: row.object_id, lifecycle_state: row.lifecycle_state, cursor: JSON.stringify(cursor) });
      }
    } catch { unavailable = true; }
    return { rows, nativeVisits, bytesRead, inspectedCandidates, committedThrough: JSON.stringify(cursor),
      truncated: !cursor.done.every(Boolean) || unavailable, resourceLimited, unavailable };
  }

  /** Every cursor row is charged, including inactive capsules; no body or JSON projection is read. */
  public pageBoundInterpretationHeaders(input: Readonly<{
    workspaceId: string; limit: number; afterCursor: string | null; nativeByteLimit: number;
  }>) {
    const limit = boundedLimit(input.limit), allowance = boundedBytes(input.nativeByteLimit);
    const rows: BoundInterpretationHeader[] = [];
    let cursor = input.afterCursor, visits = 0, bytes = 0, exhausted = false, resourceLimited = false;
    let seek: readonly [string, string] = cursor === null ? ["", ""] : JSON.parse(cursor);
    if (!Array.isArray(seek) || seek.length !== 2 || !seek.every((value) => typeof value === "string")) {
      throw new AlayaError("VALIDATION", "invalid source-hint cursor");
    }
    const statement = this.db.prepare(`SELECT
      CASE WHEN octet_length(object_id)<=512 THEN object_id ELSE NULL END AS object_id,
      CASE WHEN octet_length(created_at)<=64 THEN created_at ELSE NULL END AS created_at,
      CASE WHEN octet_length(lifecycle_state)<=64 THEN lifecycle_state ELSE NULL END AS lifecycle_state,
      CASE WHEN octet_length(source_hash)<=128 THEN source_hash ELSE NULL END AS source_hash
      FROM evidence_capsules INDEXED BY idx_evidence_capsules_source_cursor
      WHERE workspace_id=? AND (created_at,object_id)>(?,?)
      ORDER BY evidence_capsules.created_at,evidence_capsules.object_id LIMIT 1`);
    while (visits < limit) {
      if (allowance - bytes < 784) { resourceLimited = true; break; }
      visits++;
      const row = statement.get(input.workspaceId, ...seek) as {
        object_id: string | null; created_at: string | null; lifecycle_state: string | null; source_hash: string | null;
      } | undefined;
      bytes += 16;
      if (row === undefined) { exhausted = true; break; }
      bytes += Object.values(row).reduce((sum, value) => sum + Buffer.byteLength(value ?? ""), 0);
      if (row.object_id === null || row.created_at === null || row.lifecycle_state === null) { resourceLimited = true; break; }
      seek = [row.created_at, row.object_id]; cursor = JSON.stringify(seek);
      // An absent or oversized hash remains an unknown navigation hint, never a filter.
      rows.push({ object_id: row.object_id, source_hash: row.source_hash, lifecycle_state: row.lifecycle_state, cursor });
    }
    return { rows, nativeVisits: visits, bytesRead: bytes, committedThrough: cursor,
      truncated: !exhausted, resourceLimited };
  }

  /** Read-only legacy-key adapter; remove when workspace-free interpretation keys are explicitly retired.
   * Every candidate is looked up within the caller's workspace. Multiple bindings fail closed.
   */
  public readBoundInterpretationCompatible(workspaceId: string, objectIds: readonly string[], byteLimit: number, metadataOnly = false) {
    const allowance = boundedBytes(byteLimit);
    if (!workspaceId.trim() || objectIds.length !== 2 || new Set(objectIds).size !== 2) {
      throw new AlayaError("VALIDATION", "compatibility lookup requires a workspace and two distinct keys");
    }
    if (allowance < 48) return { gist: null, bytesRead: 0, nativeVisits: 0, status: "resource_limited" as const };
    const present = this.db.prepare(`SELECT CASE object_id WHEN ? THEN 0 ELSE 1 END AS candidate FROM evidence_capsules
      WHERE workspace_id=? AND object_id IN (?,?) LIMIT 2`).all(objectIds[0], workspaceId, ...objectIds) as { candidate: number }[];
    if (present.length > 1) return { gist: null, bytesRead: 32, nativeVisits: 2, status: "ambiguous" as const };
    if (present.length === 0) return { gist: null, bytesRead: 32, nativeVisits: 2, status: "absent" as const };
    const objectId = objectIds[present[0]!.candidate]!;
    if (metadataOnly) return { gist: null, objectId, bytesRead: 32, nativeVisits: 2, status: "complete" as const };
    const result = this.readBoundInterpretation(workspaceId, objectId, allowance - 32);
    return { ...result, objectId, bytesRead: result.bytesRead + 32, nativeVisits: result.nativeVisits + 2 };
  }

  /** One active packet by identity; a refused body is distinct from absence. */
  public readBoundInterpretation(workspaceId: string, objectId: string, byteLimit: number) {
    const allowance = boundedBytes(byteLimit);
    if (allowance < 16) return { gist: null, bytesRead: 0, nativeVisits: 0, status: "resource_limited" as const };
    const row = this.db.prepare(`SELECT octet_length(gist) AS bytes,
      CASE WHEN octet_length(gist) <= ? THEN gist ELSE NULL END AS gist
      FROM evidence_capsules WHERE workspace_id=? AND object_id=? AND lifecycle_state='active' LIMIT 1`
    ).get(allowance - 16, workspaceId, objectId) as { bytes: number; gist: string | null } | undefined;
    return { gist: row?.gist ?? null, bytesRead: 16 + Buffer.byteLength(row?.gist ?? ""), nativeVisits: 1,
      status: row === undefined ? "absent" as const : row.gist === null ? "resource_limited" as const : "complete" as const };
  }

  public pageBoundInterpretations(input: Readonly<{
    workspaceId: string; limit: number; nativeLimit: number; afterCursor: string | null;
    matches?: (gist: string) => boolean; nativeByteLimit?: number;
    activeOnly?: boolean; maxGistBytes?: number;
  }>): BoundInterpretationHintPage {
    const limit = boundedLimit(input.limit);
    const nativeLimit = limit === 0 ? 0 : boundedLimit(input.nativeLimit);
    const byteBudget = boundedBytes(input.nativeByteLimit);
    const gistMax = input.maxGistBytes ?? GIST_BYTE_MAX;
    if (!Number.isSafeInteger(gistMax) || gistMax < 1 || gistMax > 1_000_000) throw new AlayaError("VALIDATION", "invalid interpretation gist limit");
    if (byteBudget < 520) return { rows: [], nativeVisits: 0, nativeWork: 0, nativeBytes: 0,
      rowsRead: 0, bytesRead: 0, truncated: true, committedThrough: input.afterCursor,
      unavailable: false, resourceLimited: true };
    const rows: BoundInterpretationHintRow[] = [];
    let visits = 0;
    let rowsRead = 0;
    let bytes = 0;
    let committed = input.afterCursor;
    let oversized = false;
    let exhausted = false;
    let seek: readonly [string, string] = input.afterCursor === null ? ["", ""] : JSON.parse(input.afterCursor);
    if (!Array.isArray(seek) || seek.length !== 2 || !seek.every((value) => typeof value === "string")) {
      throw new Error("invalid source-hint cursor");
    }
    // Each bounded keyset step uses the remaining byte allowance. Reserving a
    // maximum gist for every possible future row would starve small corpora.
    const candidate = this.db.prepare(`SELECT CASE WHEN octet_length(object_id)<=512 THEN object_id ELSE NULL END AS object_id,
      CASE WHEN octet_length(created_at)<=64 THEN created_at ELSE NULL END AS created_at,
      octet_length(gist) AS gist_bytes,
      CASE WHEN octet_length(gist) <= ? THEN gist ELSE NULL END AS gist
      FROM evidence_capsules INDEXED BY idx_evidence_capsules_source_cursor
      WHERE workspace_id=? AND (?=0 OR lifecycle_state='active') AND (created_at,object_id)>(?,?)
      ORDER BY evidence_capsules.created_at,evidence_capsules.object_id LIMIT 1`);
    while (visits < nativeLimit) {
      if (byteBudget - bytes < 584) { oversized = true; break; }
      visits++;
      const row = candidate.get(Math.min(gistMax, byteBudget - bytes - 584),
        input.workspaceId, input.activeOnly === true ? 1 : 0, ...seek) as { object_id: string | null; created_at: string | null; gist: string | null; gist_bytes: number } | undefined;
      if (row === undefined) { exhausted = true; break; }
      rowsRead++;
      bytes += 8;
      if (row.object_id === null || row.created_at === null) { oversized = true; break; }
      bytes += Buffer.byteLength(row.object_id, "utf8") + Buffer.byteLength(row.created_at, "utf8") + Buffer.byteLength(row.gist ?? "", "utf8");
      if (row.gist === null && row.gist_bytes <= gistMax) { oversized = true; break; }
      seek = [row.created_at, row.object_id];
      committed = JSON.stringify(seek);
      if (row.gist === null) { oversized = true; continue; }
      if (input.matches !== undefined && !input.matches(row.gist)) continue;
      rows.push({ object_id: row.object_id, gist: row.gist, cursor: committed });
      if (rows.length >= limit) break;
    }
    return { rows, nativeVisits: visits, nativeBytes: 0, nativeWork: visits,
      rowsRead, bytesRead: bytes,
      truncated: oversized || !exhausted && (visits === nativeLimit || rows.length === limit),
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

function textHintCursor(input: { workspaceId: string; query: string; afterCursor: string | null },
  emptyLanes: readonly boolean[]): TextHintCursor {
  if (input.afterCursor === null) return { workspace: input.workspaceId, query: input.query,
    rowids: [null, null], done: [emptyLanes[0]!, emptyLanes[1]!], turn: 0 };
  const value = readRecord(JSON.parse(input.afterCursor), "interpretation text cursor");
  if (value.workspace !== input.workspaceId || value.query !== input.query
    || !Array.isArray(value.rowids) || value.rowids.length !== 2
    || !Array.isArray(value.done) || value.done.length !== 2
    || typeof value.done[0] !== "boolean" || typeof value.done[1] !== "boolean"
    || emptyLanes[0] && value.done[0] !== true || emptyLanes[1] && value.done[1] !== true
    || value.turn !== 0 && value.turn !== 1) throw new AlayaError("VALIDATION", "invalid interpretation text cursor");
  return { workspace: input.workspaceId, query: input.query,
    rowids: [cursorRowid(value.rowids[0]), cursorRowid(value.rowids[1])],
    done: [value.done[0], value.done[1]], turn: value.turn };
}

function cursorRowid(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !/^(?:0|-[1-9][0-9]{0,18}|[1-9][0-9]{0,18})$/u.test(value)
    || BigInt(value) < -9223372036854775808n || BigInt(value) > 9223372036854775807n) {
    throw new AlayaError("VALIDATION", "invalid interpretation text rowid");
  }
  return value;
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
