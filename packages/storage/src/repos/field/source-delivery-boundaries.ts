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
  FROM source_spans INDEXED BY idx_source_spans_workspace_record
  WHERE workspace_id = ? AND record_id = ? AND rowid > ? ORDER BY rowid LIMIT 1`;

type Read = Readonly<{ boundaries: SourceDeliveryBoundaries; nativeWork: number; metadataBytes: number; rowsRead: number }>;

/** Called only after the root reader has validated the pinned readable source.
 * Iterate the record index, not a purpose-filtered scan with hidden row work.
 * A bounded prefix of spans is not a complete boundary set.
 */
export function readSourceDeliveryBoundaries(database: StorageDatabase, sha256: FieldContractSha256,
  workspaceId: string, recordId: string, workLimit: number, byteLimit: number): Read {
  let nativeWork = 0, metadataBytes = 0, cursor = 0, rowsRead = 0;
  const spans: Extract<SourceDeliveryBoundaries, { status: "available" }>["spans"][number][] = [];
  const unavailable = (reason: "unreadable" | "resource_limited"): Read => ({
    boundaries: { status: "unavailable", reason }, nativeWork, metadataBytes, rowsRead });
  if (workLimit < 1 || byteLimit < ROW_BYTES + 16) return unavailable("resource_limited");
  // Preparing an unreadable table is an attempted native lookup too.
  nativeWork++;
  try {
    const statement = database.connection.prepare(select);
    while (nativeWork < workLimit && byteLimit - metadataBytes >= ROW_BYTES + 16) {
      nativeWork++;
      const raw = statement.get(workspaceId, recordId, cursor);
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
      if (typeof nextCursor !== "number" || !Number.isSafeInteger(nextCursor) || nextCursor <= cursor) return unavailable("unreadable");
      cursor = nextCursor;
      const span = fieldSourceSpanParser.parse(fields);
      verifyPersistedSourceSpan(span, sha256);
      spans.push({ purpose: AddressableSourceSpanPurposeSchema.parse(span.purpose), end_offset: span.end_offset });
    }
    return unavailable("resource_limited");
  } catch {
    // A missing/corrupt span table is not an authoritative absence of structure.
    return unavailable("unreadable");
  }
}
