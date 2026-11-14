import {
  SourceSemanticResourceExhausted, canonicalJson, hostOccurrenceIsMessage,
  sourceStatementArtifact, sourceIndexStatementTarget, sourceIndexNativeRootKey,
  type BoundSourceStatement, type FieldContractSha256, type HostOccurrenceInventory, type SourceStatementArtifact,
  type SourceIndexStatementWitnessRead, type SourceIndexTarget, type SourceIndexTemplateRead, type SourceSemanticResourceBudget
} from "@do-soul/alaya-protocol";
import { analyzeSourceIndexLexical, readSourceIndexLexicalAnalysisStatus } from "@do-soul/alaya-cjk-segmentation";
import type { StorageDatabase } from "../../sqlite/db.js";
import { cachedReadStatement } from "../../sqlite/dynamic-prepared-statement-cache.js";
import type { SqliteFieldSourceRecordRepo } from "../field/source-repo.js";
import { RETAINED_SOURCE_CHUNK_BYTES, RETAINED_SOURCE_READ_RESERVATION } from "../field/retained-source-chunks.js";
import { readIntegerField, readRecord, readStringField } from "../shared/parse-row.js";
import { sourceReadCost } from "./native-source.js";
import { QueryReadMeter, targetDecodeReservation } from "./query-read-meter.js";
import { admitSourceIndexQueryCandidate } from "./source-index-query-reader.js";
import { readStatementIndexChunk, readStatementIndexTarget } from "./statement-artifact.js";
import { tokenizeFtsQuery } from "../shared/fts-lane-routing.js";
import { decodeValidEmbeddingBlob } from "../memory/embedding-vector-validity.js";

// Artifact ids have at most 256 Unicode scalar characters. Payload sizes are read before payloads.
const ARTIFACT_ID_BYTES = 1024;
const HEADER_BYTES = ARTIFACT_ID_BYTES + 40;
type ArtifactHeader = Readonly<{ id: string; targetBytes: number; keyBytes: number; gistBytes: number }>;
type CachedMessagePart = Readonly<{ text: string; bytes: number; eventTime: string | null }>;
type ReadContext = Readonly<{
  database: StorageDatabase; records: SqliteFieldSourceRecordRepo; source: SourceIndexTarget;
  meter: QueryReadMeter; sha256: FieldContractSha256;
  messages: Map<string, CachedMessagePart>;
}>;
function listingContext(database: StorageDatabase, records: SqliteFieldSourceRecordRepo, source: SourceIndexTarget,
  meter: QueryReadMeter, sha256: FieldContractSha256): ReadContext {
  return { database, records, source, meter, sha256, messages: new Map() };
}
class TemplateReadUnknown extends Error {}
/** A refusal by a read budget, distinct from an unknown source state. */
class TemplateReadLimited extends TemplateReadUnknown {}

/** Caller owns the admitted root and snapshot. An unfinished enumeration never returns a useful prefix. */
export function readTemplateStatements(database: StorageDatabase, records: SqliteFieldSourceRecordRepo,
  source: SourceIndexTarget, budget: SourceSemanticResourceBudget, sha256: FieldContractSha256): SourceIndexTemplateRead {
  const meter = new QueryReadMeter(budget), context = listingContext(database, records, source, meter, sha256);
  try {
    return { status: "complete", statements: enumerateTemplateStatements(context).statements, resources: meter.resources() };
  } catch (error) {
    return { status: "unknown", reason: error instanceof TemplateReadUnknown ? error.message
      : error instanceof SourceSemanticResourceExhausted ? `source_template_read_budget:${error.phase}`
        : "source_template_read_failed_unknown_additional_cost", resources: meter.resources() };
  }
}

/** Throws on any unfinished enumeration. The host inventory is returned when statement binding loaded it. */
function enumerateTemplateStatements(context: ReadContext) {
  const { database, records, source, meter } = context;
  const admission = admitSourceIndexQueryCandidate(database, records, source, null, meter.ledger.remaining());
  meter.absorbQuery(admission.resources);
  if (admission.status !== "ready") {
    const reason = `source_template_${admission.status}:${admission.reason}`;
    throw admission.status === "resource_limited" ? new TemplateReadLimited(reason) : new TemplateReadUnknown(reason);
  }
  meter.ledger.charge(1, 64, "source template enumeration");
  const statements: { source: SourceIndexTarget; bound: BoundSourceStatement }[] = [];
  let after = "", inventory: HostOccurrenceInventory | undefined;
  if (source.target.root_kind !== "source_record") return { statements, inventory };
  while (true) {
    const header = readArtifactHeader(context, after);
    if (header === null) return { statements, inventory };
    inventory ??= readInventory(context);
    const statement = readArtifact(context, header);
    verifyOwnMessage(context, statement.bound, inventory);
    meter.ledger.retain(statement, "source template statement retention");
    meter.ledger.charge(1, 8, "source template result reference");
    statements.push(statement); after = header.id;
  }
}

/** Keys of one root: role from the host occurrence at the key's message span, tokens from the key text and
 * the raw message bytes (segmented v2 query analysis, lowercased), the key text, and the root's recorded
 * event time. Each message is read once. Reads never initiate segmenter loading; a cold segmenter
 * tokenizes anchors and texts alike with raw query tokens. */
export function readStatementWitnesses(database: StorageDatabase, records: SqliteFieldSourceRecordRepo,
  source: SourceIndexTarget, keys: readonly SourceIndexTarget[], anchors: readonly string[], budget: SourceSemanticResourceBudget,
  sha256: FieldContractSha256): SourceIndexStatementWitnessRead {
  const meter = new QueryReadMeter(budget);
  try {
    const root = source;
    if (keys.some(key => key.auxiliary === undefined || key.source_id === null || key.target.root_kind !== "source_record"
      || key.source_id !== root.source_id || canonicalJson(key.target) !== canonicalJson(root.target))) {
      throw new TemplateReadUnknown("statement_witness_key_root_mismatch");
    }
    const context = listingContext(database, records, root, meter, sha256);
    const inventoryRead = readInventoryResult(context);
    if (inventoryRead.status !== "captured" || inventoryRead.inventory === undefined) {
      if (keys.length > 0) throw new TemplateReadUnknown(`source_template_host_${inventoryRead.status}`);
      return { status: "ready", session_time: null, inventory: { status: inventoryRead.status === "captured" ? "invalid" : inventoryRead.status },
        witnesses: [], resources: meter.resources() };
    }
    const inventory = inventoryRead.inventory;
    if (keys.length === 0) return { status: "ready", session_time: null, inventory: { status: "captured", inventory },
      witnesses: [], resources: meter.resources() };
    const segmented = readSourceIndexLexicalAnalysisStatus() === "ready";
    const tokens = (text: string) => {
      meter.ledger.charge(4 * text.length, 16 * text.length + 64, "statement witness tokenization");
      return (segmented ? analyzeSourceIndexLexical(text, "query", "v2") : tokenizeFtsQuery(text, { initializeCjk: false }))
        .map(token => token.toLowerCase());
    };
    const required = anchors.map(tokens), messages = new Map<string, Readonly<{ role: string | null; tokens: readonly string[] }>>();
    let session: string | null | undefined;
    const witnesses = keys.map(key => {
      const [start, end] = key.auxiliary!.source_span, span = `${start}:${end}`;
      let message = messages.get(span);
      if (message === undefined) {
        meter.ledger.charge(inventory.occurrences.length, 0, "statement witness host occurrence binding");
        const occurrence = inventory.occurrences.find(row => row.utf8_span[0] === start && row.utf8_span[1] === end);
        if (occurrence === undefined || !hostOccurrenceIsMessage(occurrence)) throw new TemplateReadUnknown("statement_witness_message_binding");
        let text = "", offset = start;
        while (offset < end) {
          const part = readMessagePart(context, offset, end);
          text += part.text; offset += part.bytes; session ??= part.eventTime;
        }
        message = { role: occurrence.role, tokens: tokens(text) };
        messages.set(span, message);
      }
      meter.ledger.reserve(1, 2 * key.body_bytes + 64, "statement witness key text");
      const chunk = readStatementIndexChunk(database, key, key.body_bytes, 0);
      meter.read(chunk.resources.work, chunk.resources.native_bytes);
      if (chunk.row === null || chunk.row.content_end !== key.body_bytes) throw new TemplateReadUnknown("statement_witness_key_changed");
      const present = new Set([...message.tokens, ...tokens(chunk.row.content)]);
      meter.ledger.charge(anchors.length, 8 * anchors.length + 64, "statement witness anchor test");
      return { role: message.role, anchors: required.map(need => need.length > 0 && need.every(token => present.has(token))),
        statement: chunk.row.content };
    });
    return { status: "ready", session_time: session ?? null, inventory: { status: "captured", inventory }, witnesses, resources: meter.resources() };
  } catch (error) {
    return { status: "unknown", reason: error instanceof TemplateReadUnknown ? error.message
      : error instanceof SourceSemanticResourceExhausted ? `statement_witness_read_budget:${error.phase}`
        : "statement_witness_read_failed_unknown_additional_cost", resources: meter.resources() };
  }
}

/** Listing material for one admitted member: its owned statements (stored leading key-window vector of the bound
 * generation when valid, else null), the recorded event time, and its first host message. Admission, erase and
 * statement binding and host inventory are the template reader's; a failed read is unknown and a budget refusal is
 * resource_limited, never an empty listing. */
export function readMemberListing(database: StorageDatabase, records: SqliteFieldSourceRecordRepo, source: SourceIndexTarget,
  vectors: Readonly<{ generation_id: string; dimensions: number }> | null, budget: SourceSemanticResourceBudget,
  sha256: FieldContractSha256) {
  const meter = new QueryReadMeter(budget), context = listingContext(database, records, source, meter, sha256);
  try {
    const template = enumerateTemplateStatements(context);
    const statements = template.statements.map(row => ({ source: row.source, text: row.bound.statement.text,
      role: row.bound.message.role, message_id: row.bound.message.message_id,
      embedding: vectors === null ? null : readStatementVector(context, row.source, vectors) }));
    const inventory = template.inventory ?? (source.target.root_kind === "source_record" ? readInventory(context) : undefined);
    const first = inventory?.occurrences.find(row => hostOccurrenceIsMessage(row));
    if (first === undefined) return { status: "ready" as const, statements, event_time: null, first_message: null,
      resources: meter.resources() };
    const part = readMessagePart(context, first.utf8_span[0], first.utf8_span[1]);
    return { status: "ready" as const, statements, event_time: part.eventTime, first_message: part.text.trim(),
      resources: meter.resources() };
  } catch (error) {
    if (error instanceof TemplateReadLimited || error instanceof SourceSemanticResourceExhausted) {
      return { status: "resource_limited" as const, reason: error instanceof TemplateReadLimited ? error.message
        : `member_listing_read_budget:${error.phase}`, resources: meter.resources() };
    }
    return { status: "unknown" as const, reason: error instanceof TemplateReadUnknown ? error.message
      : "member_listing_read_failed_unknown_additional_cost", resources: meter.resources() };
  }
}

/** A statement key is scored by its leading window; later windows of a long key are not read. */
function readStatementVector({ database, source, meter }: ReadContext, key: SourceIndexTarget,
  vectors: Readonly<{ generation_id: string; dimensions: number }>): Float32Array | null {
  meter.ledger.reserve(1, 4 * vectors.dimensions + 64, "member statement key vector");
  const row = cachedReadStatement(database, `SELECT v.embedding_blob AS blob FROM source_index_windows w
    JOIN source_index_vectors v ON v.workspace_id = w.workspace_id AND v.generation_id = w.generation_id
      AND v.window_id = w.window_id
    WHERE w.workspace_id = ? AND w.generation_id = ? AND w.root_key = ? ORDER BY w.ordinal LIMIT 1`)
    .get(source.target.workspace_id, vectors.generation_id, key.root_key) as { blob: Uint8Array } | undefined;
  meter.read(1, row?.blob.byteLength ?? 0);
  return row === undefined ? null : decodeValidEmbeddingBlob(row.blob, vectors.dimensions);
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
  const read = readInventoryResult({ records, source, meter });
  if (read.status === "resource_limited") throw new TemplateReadLimited("source_template_host_resource_limited");
  if (read.status !== "captured" || read.inventory === undefined) throw new TemplateReadUnknown(`source_template_host_${read.status}`);
  return read.inventory;
}

function readInventoryResult({ records, source, meter }: Pick<ReadContext, "records" | "source" | "meter">) {
  const read = records.readHostInventory({ workspaceId: source.target.workspace_id, recordId: source.target.root_id,
    sourceVersion: source.target.source_version, contentDigest: source.target.content_digest, authorizedScopes: null,
    workLimit: meter.ledger.work, nativeByteLimit: meter.ledger.bytes, memoryLimit: meter.ledger.bytes });
  meter.absorbQuery({ work: read.work, native_bytes: read.nativeBytes, memory_bytes: read.memory, sql_internal_work: "unknown" });
  return read;
}

function readArtifact(context: ReadContext, header: ArtifactHeader) {
  const { database, source, meter, sha256 } = context;
  // The existing target reader owns artifact/dependency admission. Fund its decoded object as well as native reads.
  const decode = targetDecodeReservation(header.targetBytes);
  meter.ledger.charge(decode.work_units, decode.memory_bytes, "source template target decoding");
  const target = readStatementIndexTarget(database, source.target.workspace_id, header.id, meter.remaining());
  meter.absorb(target.resources);
  if (target.status === "resource_limited") throw new TemplateReadLimited("source_template_artifact_resource_limited");
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

function readMessagePart(context: ReadContext, offset: number, end: number) {
  const { records, source, meter, messages } = context, key = `${offset}:${end}`;
  const size = Math.min(RETAINED_SOURCE_CHUNK_BYTES, end - offset);
  const cached = messages.get(key);
  if (cached !== undefined) {
    // verifyOwnMessage still compares these bytes; skip only the saved native read/decode/memory.
    meter.ledger.charge(size, 0, "source template raw message comparison");
    return cached;
  }
  meter.ledger.reserve(size + 5, 2 * size + RETAINED_SOURCE_READ_RESERVATION, "source template raw message");
  meter.ledger.charge(size, 2 * size, "source template raw message decode and comparison");
  const read = records.findByIdBounded(source.target.workspace_id, source.target.root_id, size, offset,
    { workLimit: meter.ledger.work, nativeByteLimit: meter.ledger.bytes });
  if (read === null) { meter.read(1, 0); throw new TemplateReadUnknown("source_template_source_missing"); }
  meter.absorb(sourceReadCost(read));
  if (read.resourceLimited) throw new TemplateReadLimited("source_template_source_read_budget");
  if (read.invalidOffset || read.record?.source_body == null || read.prefixBytes === 0 || offset + read.prefixBytes > end) {
    throw new TemplateReadUnknown("source_template_source_incomplete");
  }
  const part = { text: read.record.source_body, bytes: read.prefixBytes, eventTime: read.record.event_time };
  messages.set(key, part);
  return part;
}
