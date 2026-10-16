import { type SourceRecordIdentity, type SourceSemanticAccessReceipt, type SourceSemanticHandleDescriptor,
  type SourceSemanticQuery, type RequestBudget, type SourceSemanticPreviewExtents } from "@do-soul/alaya-protocol";
import { CoreError, authorizeSemanticScope } from "@do-soul/alaya-core";
import { sourceSemanticReadStores, type SourceSemanticReadBudget } from "../field/source-semantic-read-stores.js";
import { loadVerified } from "./source-semantic-discovery.js";
import type { SourceSemanticReadRuntime } from "./runtime.js";
import { accessInputIdentity, bindAccessPoolIdentity, previewExtent, type SourceSemanticAccessPool } from "./source-semantic-candidate-access.js";
import { sourceSemanticAccessReceiptValue } from "./source-semantic-access-receipts.js";

type SourceObservation = SourceSemanticAccessReceipt["source_candidates"][number];
export type ResearchSourceObservation = SourceObservation & Pick<SourceRecordIdentity, "source_version" | "content_digest">;
type InterpretationObservation = SourceSemanticAccessReceipt["interpretation_candidates"][number];

/** A research fixed window is derived package input, never a native observation receipt. */
export function bindResearchFixedSourcePool(runtime: SourceSemanticReadRuntime, workspace: string,
  authorized: readonly string[] | null, meter: SourceSemanticReadBudget,
  original: string, query: SourceSemanticQuery, budget: RequestBudget,
  rows: readonly ResearchSourceObservation[], descriptors: readonly SourceSemanticHandleDescriptor[]): SourceSemanticAccessPool {
  if (rows.length !== 10 || rows.some(row => !row.complete || row.body_bytes === null || row.read_bytes !== row.body_bytes)) {
    throw new CoreError("VALIDATION", "research window requires ten fully read distinct raw roots");
  }
  const records = bindVerifiedResearchSourceRecords(runtime, workspace, authorized, meter, rows);
  const positions = new Map(records.map((record, index) => [record.source_id, index]));
  const verified = descriptors.map(descriptor => {
    const checked = loadVerified(runtime, workspace, descriptor.interpretation_id, authorized, meter);
    const record = checked.stored.record;
    const position = positions.get(record.source_id);
    if (position === undefined || record.identity !== rows[position]!.record_id ||
        record.source_version !== descriptor.source_version || record.content_digest !== descriptor.content_digest ||
        record.source_id !== descriptor.source_id || checked.bound.interpretation_id !== descriptor.interpretation_id) {
      throw new CoreError("CONFLICT", "research interpretation escapes its frozen source tuple");
    }
    return { descriptor, position, record_id: record.identity };
  }).sort((a, b) => a.position - b.position || a.descriptor.interpretation_id.localeCompare(b.descriptor.interpretation_id));
  if (new Set(verified.map(row => row.descriptor.interpretation_id)).size !== verified.length) {
    throw new CoreError("CONFLICT", "research interpretation repeats a descriptor");
  }
  return bindResearchSourceAccessPool(runtime, workspace, authorized, meter, original, query, budget, records, rows,
    verified.map(row => row.descriptor), verified.map(row => ({
      interpretation_id: row.descriptor.interpretation_id, record_id: row.record_id,
      signal: { source_text_score: null, interpretation_reading_score: 0 }
    })));
}

/** Access identity over already verified current records; currentness stays on the binder. */
export function bindResearchSourceAccessPool(runtime: SourceSemanticReadRuntime, workspace: string,
  authorized: readonly string[] | null, meter: SourceSemanticReadBudget, original: string,
  query: SourceSemanticQuery | undefined, budget: RequestBudget, records: readonly SourceRecordIdentity[],
  rows: readonly ResearchSourceObservation[], descriptors: readonly SourceSemanticHandleDescriptor[],
  interpretationRows: readonly InterpretationObservation[], sourcePreviewExtents?: SourceSemanticPreviewExtents): SourceSemanticAccessPool {
  if (records.length !== rows.length) throw new CoreError("CONFLICT", "research access pool records do not match observations");
  const inputId = accessInputIdentity(original, query, budget, "query-conditioned-v1", undefined, sourcePreviewExtents);
  const observations: SourceObservation[] = rows.map(row => ({ source_id: row.source_id,
    record_id: row.record_id, read_bytes: row.read_bytes, body_bytes: row.body_bytes, complete: row.complete, signal: row.signal }));
  const receipt = sourceSemanticAccessReceiptValue(meter, "query-conditioned-v1", inputId,
    observations, interpretationRows, false, false, [], sourcePreviewExtents);
  const access = bindAccessPoolIdentity(runtime, workspace, authorized, receipt, meter);
  meter.retain(access, "research source pool identity");
  return { sources: records, descriptors, access,
    ...(sourcePreviewExtents === undefined ? {} : { sourcePreviewExtents }),
    sourcePages: 1, interpretationPages: interpretationRows.length === 0 ? 0 : 1 };
}

/** Current authorized records for a frozen research pool. Exact-ten completeness belongs to its entry. */
export function bindVerifiedResearchSourceRecords(runtime: SourceSemanticReadRuntime, workspace: string,
  authorized: readonly string[] | null, meter: SourceSemanticReadBudget, rows: readonly ResearchSourceObservation[],
  sourcePreviewExtents?: readonly Readonly<{ source_id: string; source_version: string; record_id: string; byte_extent: number }>[]) {
  if (rows.length === 0 || rows.length > 512 || new Set(rows.map(row => row.record_id)).size !== rows.length
      || new Set(rows.map(row => row.source_id)).size !== rows.length) {
    throw new CoreError("VALIDATION", "research pool requires distinct current source roots within the catalog cap");
  }
  if (sourcePreviewExtents !== undefined && (sourcePreviewExtents.length !== rows.length
      || new Set(sourcePreviewExtents.map(row => row.source_id)).size !== sourcePreviewExtents.length)) {
    throw new CoreError("VALIDATION", "source preview extents do not cover the research source pool", { details: { admission: "bound" } });
  }
  return rows.map(row => {
    const record = sourceSemanticReadStores(runtime.database, workspace, row.source_id, meter, authorized).getCurrentRecord(workspace, row.source_id);
    if (record === null || record.identity !== row.record_id || record.source_version !== row.source_version || record.content_digest !== row.content_digest) {
      throw new CoreError("CONFLICT", "research raw root is not current in the source publication");
    }
    authorizeSemanticScope(record.scope_class, authorized);
    if (sourcePreviewExtents !== undefined) {
      const extent = previewExtent(record, sourcePreviewExtents);
      if (row.read_bytes !== extent || extent < 1 || extent > 4096) {
        throw new CoreError("VALIDATION", "research observation does not match its preview extent", { details: { admission: "bound" } });
      }
    }
    return record;
  });
}
