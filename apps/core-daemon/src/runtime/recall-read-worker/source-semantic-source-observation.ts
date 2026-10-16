import { SourceSemanticResourceExhausted, type SourceRecordIdentity, type SourceSemanticAccessReceipt,
  type SourceSemanticAccessSignal, type SourceSemanticResourceBudget } from "@do-soul/alaya-protocol";
import type { createSourceSemanticAccessPolicy } from "@do-soul/alaya-core";
import { RETAINED_SOURCE_READ_RESERVATION, type SqliteFieldSourceRecordRepo } from "@do-soul/alaya-storage";
import type { SourceSemanticReadBudget } from "../field/source-semantic-read-stores.js";

type Policy = ReturnType<typeof createSourceSemanticAccessPolicy>;
type Observation = SourceSemanticAccessReceipt["source_candidates"][number];
const UNKNOWN: SourceSemanticAccessSignal = { source_text_score: null, interpretation_reading_score: 0 };

/** Same extent reservation used by the native observation, including its deferred scoring/assembly. */
function extentQuote(sourceCost: Policy["sourceCost"], characters: number, chunkBytes: number) {
  const scoring = sourceCost(characters + chunkBytes);
  return { work_units: chunkBytes + 5 + scoring.work_units,
    memory_bytes: RETAINED_SOURCE_READ_RESERVATION + 2 * scoring.memory_bytes + 8 * chunkBytes,
    deferredWork: chunkBytes + scoring.work_units, deferredBytes: 2 * scoring.memory_bytes + 8 * chunkBytes };
}

/** Metadata plus the next bounded native extent, not a whole-source or native CPU promise. */
export function quoteSemanticSourceObservation(sourceCost: Policy["sourceCost"], bytes: number): SourceSemanticResourceBudget {
  const extent = extentQuote(sourceCost, 0, bytes);
  return { work_units: 5 + extent.work_units, memory_bytes: RETAINED_SOURCE_READ_RESERVATION + extent.memory_bytes };
}

export function readSourceText(repo: SqliteFieldSourceRecordRepo, record: SourceRecordIdentity, policy: Policy,
  meter: SourceSemanticReadBudget, sourcePreviewByteExtent?: number,
  afterExtent?: () => void): Pick<Observation, "read_bytes" | "body_bytes" | "complete" | "signal"> & { resourceLimited?: boolean } {
  let offset = 0, bodyBytes: number | null = null, characters = 0, complete = false, resourceLimited = false;
  let extent: ReturnType<SqliteFieldSourceRecordRepo["findByIdBounded"]> | undefined;
  const chunks: string[] = [];
  try {
    meter.reserve(5, RETAINED_SOURCE_READ_RESERVATION, "access source extent metadata");
    extent = repo.findByIdBounded(record.workspace_id, record.identity, 1, 0,
      { workLimit: meter.work, nativeByteLimit: meter.bytes });
    meter.read(5 + (extent?.dependencyWork ?? 0), extent === null ? 0 : extent.nativeBytes + extent.metadataBytes);
    bodyBytes = extent?.bodyBytes ?? null;
    if (extent?.resourceLimited) throw new SourceSemanticResourceExhausted("access source dependencies");
  } catch (error) { if (!(error instanceof SourceSemanticResourceExhausted)) throw error; resourceLimited = true; }
  // Census/completion failures belong to the caller, not the body's partial-read result.
  // Keep this seam on the same read so metadata and final scoring are not repeated.
  afterExtent?.();
  if (resourceLimited || extent?.record?.source_body == null) {
    return { read_bytes: 0, body_bytes: bodyBytes, complete: false, signal: UNKNOWN, resourceLimited };
  }
  try {
    if (bodyBytes === 0) complete = true;
    while (true) {
      const chunkBytes = Math.min(4096, extent.bodyBytes - offset,
        sourcePreviewByteExtent === undefined ? 4096 : sourcePreviewByteExtent - offset);
      if (chunkBytes <= 0) break;
      const quote = extentQuote(policy.sourceCost, characters, chunkBytes);
      meter.reserve(quote.work_units, quote.memory_bytes, "access source extent");
      const page = repo.findByIdBounded(record.workspace_id, record.identity, chunkBytes, offset,
        { workLimit: meter.work - quote.deferredWork, nativeByteLimit: meter.bytes - quote.deferredBytes });
      meter.read(5 + (page?.dependencyWork ?? 0), page === null ? 0 : page.nativeBytes + page.metadataBytes);
      if (page?.resourceLimited) throw new SourceSemanticResourceExhausted("access source dependencies");
      if (page === null) break;
      bodyBytes = page.bodyBytes;
      if (page.record?.source_body == null || page.invalidOffset) break;
      const chunk = page.record.source_body;
      meter.charge(chunk.length, 8 * chunk.length + 32, "access source retention");
      chunks.push(chunk); characters += chunk.length; offset += Buffer.byteLength(chunk);
      if (offset >= bodyBytes) { complete = true; break; }
      if (chunk.length === 0) break;
    }
  } catch (error) { if (!(error instanceof SourceSemanticResourceExhausted)) throw error; resourceLimited = true; }
  meter.charge(0, 4 * characters, "access source assembly");
  const signal = offset === 0 && !complete ? UNKNOWN : policy.source(chunks.join(""), meter);
  return { read_bytes: offset, body_bytes: bodyBytes, complete, signal, resourceLimited };
}
