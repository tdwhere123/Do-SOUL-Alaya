import {
  SourceSemanticResourceExhausted, canonicalJson, hostOccurrenceIsMessage,
  sourceStatementArtifact, sourceIndexStatementTarget, sourceIndexNativeRootKey,
  type BoundSourceStatement, type FieldContractSha256, type HostOccurrenceInventory, type SourceStatementArtifact,
  type SourceIndexTarget, type SourceIndexTemplateRead, type SourceSemanticResourceBudget
} from "@do-soul/alaya-protocol";
import type { StorageDatabase } from "../../sqlite/db.js";
import { cachedReadStatement } from "../../sqlite/dynamic-prepared-statement-cache.js";
import type { SqliteFieldSourceRecordRepo } from "../field/source-repo.js";
import { RETAINED_SOURCE_CHUNK_BYTES, RETAINED_SOURCE_READ_RESERVATION } from "../field/retained-source-chunks.js";
import { readIntegerField, readRecord, readStringField } from "../shared/parse-row.js";
import { sourceReadCost } from "./native-source.js";
import { QueryReadMeter, targetDecodeReservation } from "./query-read-meter.js";
import { admitSourceIndexQueryCandidate } from "./source-index-query-reader.js";
import { readStatementIndexTarget } from "./statement-artifact.js";

// Artifact ids have at most 256 Unicode scalar characters. Payload sizes are read before payloads.
const ARTIFACT_ID_BYTES = 1024;
const HEADER_BYTES = ARTIFACT_ID_BYTES + 40;
type ArtifactHeader = Readonly<{ id: string; targetBytes: number; keyBytes: number; gistBytes: number }>;
type ReadContext = Readonly<{
  database: StorageDatabase; records: SqliteFieldSourceRecordRepo; source: SourceIndexTarget;
  meter: QueryReadMeter; sha256: FieldContractSha256;
}>;
class TemplateReadUnknown extends Error {}

/** Caller owns the admitted root and snapshot. An unfinished enumeration never returns a useful prefix. */
export function readTemplateStatements(database: StorageDatabase, records: SqliteFieldSourceRecordRepo,
  source: SourceIndexTarget, budget: SourceSemanticResourceBudget, sha256: FieldContractSha256): SourceIndexTemplateRead {
  const meter = new QueryReadMeter(budget), context: ReadContext = { database, records, source, meter, sha256 };
  try {
    const admission = admitSourceIndexQueryCandidate(database, records, source, null, meter.ledger.remaining());
    meter.absorbQuery(admission.resources);
    if (admission.status !== "ready") throw new TemplateReadUnknown(`source_template_${admission.status}:${admission.reason}`);
    meter.ledger.charge(1, 64, "source template enumeration");
    const statements: { source: SourceIndexTarget; bound: BoundSourceStatement }[] = [];
    if (source.target.root_kind !== "source_record") return { status: "complete", statements, resources: meter.resources() };
    let after = "", inventory: HostOccurrenceInventory | undefined;
    while (true) {
      const header = readArtifactHeader(context, after);
      if (header === null) return { status: "complete", statements, resources: meter.resources() };
      inventory ??= readInventory(context);
      const statement = readArtifact(context, header);
      verifyOwnMessage(context, statement.bound, inventory);
      meter.ledger.retain(statement, "source template statement retention");
      meter.ledger.charge(1, 8, "source template result reference");
      statements.push(statement); after = header.id;
    }
  } catch (error) {
    return { status: "unknown", reason: error instanceof TemplateReadUnknown ? error.message
      : error instanceof SourceSemanticResourceExhausted ? `source_template_read_budget:${error.phase}`
        : "source_template_read_failed_unknown_additional_cost", resources: meter.resources() };
  }
}

function readArtifactHeader({ database, source, meter }: ReadContext, after: string): ArtifactHeader | null {
  meter.ledger.reserve(1, HEADER_BYTES, "source template artifact header");
  meter.read(1, 0);
  const raw = cachedReadStatement(database, `SELECT
    CASE WHEN octet_length(a.artifact_id)<=? THEN a.artifact_id END AS artifact_id,
    octet_length(a.artifact_id) AS id_bytes, octet_length(a.target_json) AS target_bytes,
    octet_length(a.key_text) AS key_bytes, octet_length(e.gist) AS gist_bytes,
    e.lifecycle_state='active' AS active
    FROM source_statement_artifacts a LEFT JOIN evidence_capsules e
      ON e.workspace_id=a.workspace_id AND e.object_id=a.artifact_id
    WHERE a.workspace_id=? AND a.record_id=? AND a.source_id=? AND a.artifact_id>?
    ORDER BY a.artifact_id LIMIT 1`).get(ARTIFACT_ID_BYTES, source.target.workspace_id,
    source.target.root_id, source.source_id, after);
  if (raw === undefined) return null;
  const row = readRecord(raw, "source statement artifact header");
  meter.read(0, 40 + (typeof row.artifact_id === "string" ? Buffer.byteLength(row.artifact_id) : 0));
  if (row.active !== 1 || typeof row.gist_bytes !== "number") throw new TemplateReadUnknown("source_template_artifact_unavailable");
  const header = { id: readStringField(row, "artifact_id"), targetBytes: readIntegerField(row, "target_bytes"),
    keyBytes: readIntegerField(row, "key_bytes"), gistBytes: readIntegerField(row, "gist_bytes") };
  if (header.id <= after || header.targetBytes < 1 || header.keyBytes < 1 || header.gistBytes < 1) {
    throw new TemplateReadUnknown("source_template_artifact_invalid");
  }
  return header;
}

function readInventory({ records, source, meter }: ReadContext): HostOccurrenceInventory {
  const read = records.readHostInventory({ workspaceId: source.target.workspace_id, recordId: source.target.root_id,
    sourceVersion: source.target.source_version, contentDigest: source.target.content_digest, authorizedScopes: null,
    workLimit: meter.ledger.work, nativeByteLimit: meter.ledger.bytes, memoryLimit: meter.ledger.bytes });
  meter.absorbQuery({ work: read.work, native_bytes: read.nativeBytes, memory_bytes: read.memory, sql_internal_work: "unknown" });
  if (read.status !== "captured" || read.inventory === undefined) throw new TemplateReadUnknown(`source_template_host_${read.status}`);
  return read.inventory;
}

function readArtifact(context: ReadContext, header: ArtifactHeader) {
  const { database, source, meter, sha256 } = context;
  // The existing target reader owns artifact/dependency admission. Fund its decoded object as well as native reads.
  const decode = targetDecodeReservation(header.targetBytes);
  meter.ledger.charge(decode.work_units, decode.memory_bytes, "source template target decoding");
  const target = readStatementIndexTarget(database, source.target.workspace_id, header.id, meter.remaining());
  meter.absorb(target.resources);
  if (target.status !== "ready") throw new TemplateReadUnknown(`source_template_artifact_${target.status}`);
  const bytes = header.gistBytes + header.keyBytes;
  // JSON/schema copies, canonical identity material, key construction and hashing are paid before allocation.
  meter.ledger.reserve(1 + 4 * bytes, 4096 + 9 * bytes, "source template artifact payload");
  meter.ledger.charge(4 * bytes, 4096 + 8 * bytes, "source template artifact decoding and identity");
  meter.read(1, bytes);
  const raw = cachedReadStatement(database, `SELECT
    CASE WHEN octet_length(e.gist)=? THEN e.gist END AS gist,
    CASE WHEN octet_length(a.key_text)=? THEN a.key_text END AS key_text
    FROM source_statement_artifacts a JOIN evidence_capsules e
      ON e.workspace_id=a.workspace_id AND e.object_id=a.artifact_id AND e.lifecycle_state='active'
    WHERE a.workspace_id=? AND a.record_id=? AND a.source_id=? AND a.artifact_id=?`)
    .get(header.gistBytes, header.keyBytes, source.target.workspace_id, source.target.root_id, source.source_id, header.id);
  if (raw === undefined) throw new TemplateReadUnknown("source_template_artifact_changed");
  const row = readRecord(raw, "source statement artifact payload");
  let artifact: SourceStatementArtifact;
  try { artifact = sourceStatementArtifact(JSON.parse(readStringField(row, "gist")) as BoundSourceStatement, header.id, sha256); }
  catch { throw new TemplateReadUnknown("source_template_artifact_invalid"); }
  const expected = sourceIndexStatementTarget(artifact, source.source_id!);
  if (canonicalJson(expected) !== canonicalJson(target.source) || sourceIndexNativeRootKey(expected) !== sourceIndexNativeRootKey(source)
    || artifact.key_text !== readStringField(row, "key_text")) throw new TemplateReadUnknown("source_template_artifact_binding");
  return { source: target.source, bound: artifact.bound };
}

function verifyOwnMessage(context: ReadContext, bound: BoundSourceStatement, inventory: HostOccurrenceInventory): void {
  const { source, meter } = context, [start, end] = bound.source_span;
  meter.ledger.charge(inventory.occurrences.length, 0, "source template host occurrence binding");
  const occurrence = inventory.occurrences.find(row => row.utf8_span[0] === start && row.utf8_span[1] === end);
  if (occurrence === undefined || !hostOccurrenceIsMessage(occurrence)
    || occurrence.occurrence_id !== bound.message.message_id || occurrence.role !== bound.message.role
    || bound.artifact_key !== source.source_id || `sha256:${bound.source_corpus_digest}` !== source.target.content_digest) {
    throw new TemplateReadUnknown("source_template_message_binding");
  }
  let byteOffset = start, textOffset = 0;
  while (byteOffset < end) {
    const part = readMessagePart(context, byteOffset, end);
    if (!bound.message.text.startsWith(part.text, textOffset)) throw new TemplateReadUnknown("source_template_message_changed");
    byteOffset += part.bytes; textOffset += part.text.length;
  }
  if (textOffset !== bound.message.text.length) throw new TemplateReadUnknown("source_template_message_changed");
}

function readMessagePart({ records, source, meter }: ReadContext, offset: number, end: number) {
  const size = Math.min(RETAINED_SOURCE_CHUNK_BYTES, end - offset);
  meter.ledger.reserve(size + 5, 2 * size + RETAINED_SOURCE_READ_RESERVATION, "source template raw message");
  meter.ledger.charge(size, 2 * size, "source template raw message decode and comparison");
  const read = records.findByIdBounded(source.target.workspace_id, source.target.root_id, size, offset,
    { workLimit: meter.ledger.work, nativeByteLimit: meter.ledger.bytes });
  if (read === null) { meter.read(1, 0); throw new TemplateReadUnknown("source_template_source_missing"); }
  meter.absorb(sourceReadCost(read));
  if (read.resourceLimited) throw new TemplateReadUnknown("source_template_source_read_budget");
  if (read.invalidOffset || read.record?.source_body == null || read.prefixBytes === 0 || offset + read.prefixBytes > end) {
    throw new TemplateReadUnknown("source_template_source_incomplete");
  }
  return { text: read.record.source_body, bytes: read.prefixBytes };
}
