import { SourceIndexOperationError, SourceSemanticResourceExhausted, type SourceIndexTarget, type SourceIndexTaskObservationRead,
  type SourceSemanticResourceBudget } from "@do-soul/alaya-protocol";
import type { StorageDatabase } from "../../sqlite/db.js";
import type { SqliteFieldSourceRecordRepo } from "../field/source-repo.js";
import { RETAINED_SOURCE_READ_RESERVATION } from "../field/retained-source-chunks.js";
import { sourceReadCost } from "./native-source.js";
import { QueryReadMeter } from "./query-read-meter.js";
import { admitSourceIndexQueryCandidate } from "./source-index-query-reader.js";

/** SourceIndex admission owns currentness, erasure and dependencies; only a complete literal read is returned. */
export function readTaskObservation(database: StorageDatabase, records: SqliteFieldSourceRecordRepo,
  source: SourceIndexTarget, span: Readonly<{ start_byte: number; end_byte: number }>,
  budget: SourceSemanticResourceBudget): SourceIndexTaskObservationRead {
  const meter = new QueryReadMeter(budget);
  try {
    if (source.target.root_kind !== "source_record" ||
        !Number.isSafeInteger(span.start_byte) || !Number.isSafeInteger(span.end_byte) || span.start_byte < 0 ||
        span.end_byte <= span.start_byte || (source.auxiliary === undefined && span.end_byte > source.body_bytes) ||
        span.end_byte - span.start_byte > 4096) {
      return { status: "unknown", reason: "source_task_invalid_span", resources: meter.resources() };
    }
    let admission;
    try { admission = admitSourceIndexQueryCandidate(database, records, source, null, meter.ledger.remaining()); }
    catch (error) {
      if (error instanceof SourceIndexOperationError) meter.absorb(error.resources);
      throw error;
    }
    meter.absorbQuery(admission.resources);
    if (admission.status !== "ready") return { status: "unknown",
      reason: `source_task_${admission.status}`, resources: meter.resources() };
    const bytes = span.end_byte - span.start_byte;
    meter.ledger.reserve(bytes + 5, bytes * 2 + RETAINED_SOURCE_READ_RESERVATION, "source task excerpt");
    meter.ledger.charge(bytes, bytes * 2, "source task excerpt decoding");
    const read = records.findByIdBounded(source.target.workspace_id, source.target.root_id, bytes, span.start_byte,
      { workLimit: meter.ledger.work, nativeByteLimit: meter.ledger.bytes });
    if (read === null) { meter.read(1, 0); return { status: "unknown", reason: "source_task_missing", resources: meter.resources() }; }
    meter.absorb(sourceReadCost(read));
    // An auxiliary target's body_bytes describes statement key text, not raw source coordinates.
    if (read.resourceLimited || read.invalidOffset || span.end_byte > read.bodyBytes ||
        read.prefixBytes !== bytes || read.record?.source_body == null) {
      return { status: "unknown", reason: read.resourceLimited ? "source_task_read_budget" : "source_task_incomplete",
        resources: meter.resources() };
    }
    return { status: "ready", text: read.record.source_body, source_observed_at: read.record.event_time,
      resources: meter.resources() };
  } catch (error) {
    return { status: "unknown", reason: error instanceof SourceSemanticResourceExhausted
      ? `source_task_read_budget:${error.phase}` : "source_task_read_failed_unknown_additional_cost", resources: meter.resources() };
  }
}
