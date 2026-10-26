import { AddressableSourceSpanPurposeSchema, type FieldContractSha256, type SourceDeliveryBoundaries } from "@do-soul/alaya-protocol";
import type { StorageDatabase } from "../../sqlite/db.js";
import { fieldSourceSpanParser } from "./mappers/mappers.js";
import { verifyPersistedSourceSpan } from "./identity.js";
import { readRecord } from "../shared/parse-row.js";

/** The SQL caps each metadata row before materializing it. This is a reservation,
 * not spend; actual returned metadata and every attempted native step are charged.
 */
const ROW_BYTES = 1024;
const columns = ["span_id", "record_id", "start_offset", "end_offset", "purpose", "producer_version",
  "workspace_id", "recorded_at"] as const;
const size = columns.map(column => `COALESCE(octet_length(${column}), 0)`).join(" + ");
const select = `SELECT rowid AS cursor, (${size}) AS metadata_bytes,
  ${columns.map(column => `CASE WHEN (${size}) <= ${ROW_BYTES} THEN ${column} ELSE NULL END AS ${column}`).join(", ")}
  FROM source_spans INDEXED BY idx_source_spans_record_purpose_end
  WHERE workspace_id = ? AND record_id = ? AND purpose = ? AND end_offset <= ?
    AND (end_offset > ? OR (end_offset = ? AND rowid > ?))
  ORDER BY end_offset, rowid LIMIT 1`;
const messageProbe = `SELECT 1 AS found FROM source_spans INDEXED BY idx_source_spans_record_purpose_end
  WHERE workspace_id = ? AND record_id = ? AND purpose = 'message' LIMIT 1`;

type Read = Readonly<{ boundaries: SourceDeliveryBoundaries; nativeWork: number; metadataBytes: number; rowsRead: number }>;

/** Called only after the root reader has validated the pinned readable source.
 * Delivery uses one unit (message if the root records any, else line) and only
 * ends inside the hydrated window, so only those rows are read.
 * A bounded prefix of that window is not a complete boundary set.
 */
export function readSourceDeliveryBoundaries(database: StorageDatabase, sha256: FieldContractSha256,
  workspaceId: string, recordId: string, window: Readonly<{ start: number; end: number }>,
  workLimit: number, byteLimit: number): Read {
  // The first row only needs end > window.start; (end, rowid) is the keyset after it.
  let nativeWork = 0, metadataBytes = 0, rowsRead = 0, afterEnd = window.start, afterRow = Number.MAX_SAFE_INTEGER;
  const spans: Extract<SourceDeliveryBoundaries, { status: "available" }>["spans"][number][] = [];
  const unavailable = (reason: "unreadable" | "resource_limited"): Read => ({
    boundaries: { status: "unavailable", reason }, nativeWork, metadataBytes, rowsRead });
  if (workLimit < 2 || byteLimit < ROW_BYTES + 16) return unavailable("resource_limited");
  // Preparing an unreadable table is an attempted native lookup too.
  nativeWork += 2;
  try {
    const purpose = database.connection.prepare(messageProbe).get(workspaceId, recordId) === undefined ? "line" : "message";
    metadataBytes += 16;
    const statement = database.connection.prepare(select);
    while (nativeWork < workLimit && byteLimit - metadataBytes >= ROW_BYTES + 16) {
      nativeWork++;
      const raw = statement.get(workspaceId, recordId, purpose, window.end, afterEnd, afterEnd, afterRow);
      if (raw === undefined) return { boundaries: { status: "available", spans }, nativeWork, metadataBytes, rowsRead };
      rowsRead++;
      const row = readRecord(raw, "source delivery boundary");
      const bytes = row.metadata_bytes;
      if (typeof bytes !== "number" || bytes > ROW_BYTES || bytes < 0) {
        metadataBytes += 16;
        return unavailable("unreadable");
      }
      metadataBytes += bytes + 16;
      const { cursor: nextCursor, metadata_bytes: _size, ...fields } = row;
      if (typeof nextCursor !== "number" || !Number.isSafeInteger(nextCursor)) return unavailable("unreadable");
      const span = fieldSourceSpanParser.parse(fields);
      verifyPersistedSourceSpan(span, sha256);
      const advanced = span.end_offset > afterEnd || (span.end_offset === afterEnd && nextCursor > afterRow);
      if (span.purpose !== purpose || span.end_offset > window.end || !advanced) return unavailable("unreadable");
      afterEnd = span.end_offset;
      afterRow = nextCursor;
      spans.push({ purpose: AddressableSourceSpanPurposeSchema.parse(span.purpose), end_offset: span.end_offset });
    }
    return unavailable("resource_limited");
  } catch {
    // A missing/corrupt span table is not an authoritative absence of structure.
    return unavailable("unreadable");
  }
}
