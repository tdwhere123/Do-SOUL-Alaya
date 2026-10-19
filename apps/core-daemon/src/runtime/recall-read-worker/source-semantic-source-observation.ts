import { SourceSemanticResourceExhausted, type SourceRecordIdentity, type SourceSemanticAccessReceipt,
  type SourceSemanticAccessSignal, type SourceSemanticResourceBudget } from "@do-soul/alaya-protocol";
import { CoreError, type createSourceSemanticAccessPolicy } from "@do-soul/alaya-core";
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

type SourceTextResult = Pick<Observation, "read_bytes" | "body_bytes" | "complete" | "signal"> & { resourceLimited?: boolean };
type SourceTextRead = Generator<(() => void) | undefined, SourceTextResult | undefined, void>;

/** One read state across metadata, the guaranteed first native extent, and census-promoted completion. */
function* sourceTextRead(repo: SqliteFieldSourceRecordRepo, record: SourceRecordIdentity, policy: Policy,
  meter: SourceSemanticReadBudget, sourcePreviewByteExtent?: number, prefetch = false): SourceTextRead {
  let offset = 0, bodyBytes: number | null = null, characters = 0, complete = false, resourceLimited = false, settled = false;
  let extent: ReturnType<SqliteFieldSourceRecordRepo["findByIdBounded"]> | undefined;
  let releaseDeferred: (() => void) | undefined;
  let completionCost: SourceSemanticResourceBudget = { work_units: 0, memory_bytes: 0 };
  const chunks: string[] = [];
  try {
    try {
      meter.reserve(5, RETAINED_SOURCE_READ_RESERVATION, "access source extent metadata");
      extent = repo.findByIdBounded(record.workspace_id, record.identity, 1, 0,
        { workLimit: meter.work, nativeByteLimit: meter.bytes });
      meter.read(5 + (extent?.dependencyWork ?? 0), extent === null ? 0 : extent.nativeBytes + extent.metadataBytes);
      meter.observer?.event("source_read", meter.phase, () => ({ purpose: "observation_metadata", record_id: record.identity,
        source_id: record.source_id, start: 0, end: Buffer.byteLength(extent?.record?.source_body ?? ""),
        native_bytes: extent === null ? 0 : extent!.nativeBytes + extent!.metadataBytes, resource_limited: extent?.resourceLimited ?? false }));
      bodyBytes = extent?.bodyBytes ?? null;
      if (extent?.resourceLimited) throw new SourceSemanticResourceExhausted("access source dependencies");
    } catch (error) { if (!(error instanceof SourceSemanticResourceExhausted)) throw error; resourceLimited = true; }
    yield;
    if (resourceLimited || extent?.record?.source_body == null) {
      settled = true;
      return { read_bytes: 0, body_bytes: bodyBytes, complete: false, signal: UNKNOWN, resourceLimited };
    }
    if (bodyBytes === 0) complete = true;
    let firstExtent = prefetch;
    while (true) {
      let advance = false;
      try {
        const chunkBytes = Math.min(4096, extent.bodyBytes - offset,
          sourcePreviewByteExtent === undefined ? 4096 : sourcePreviewByteExtent - offset);
        if (chunkBytes > 0) {
          const quote = extentQuote(policy.sourceCost, characters, chunkBytes);
          meter.observer?.event("source_read_attempt", meter.phase, () => ({ purpose: "observation", record_id: record.identity,
            source_id: record.source_id, start: offset, requested_end: offset + chunkBytes }));
          meter.reserve(quote.work_units, quote.memory_bytes, "access source extent");
          const page = repo.findByIdBounded(record.workspace_id, record.identity, chunkBytes, offset,
            { workLimit: meter.work - quote.deferredWork, nativeByteLimit: meter.bytes - quote.deferredBytes });
          meter.read(5 + (page?.dependencyWork ?? 0), page === null ? 0 : page.nativeBytes + page.metadataBytes);
          meter.observer?.event("source_read", meter.phase, () => ({ purpose: "observation", record_id: record.identity,
            source_id: record.source_id, start: offset, end: offset + Buffer.byteLength(page?.record?.source_body ?? ""),
            requested_end: offset + chunkBytes, native_bytes: page === null ? 0 : page.nativeBytes + page.metadataBytes,
            resource_limited: page?.resourceLimited ?? false, available: page?.record?.source_body != null && !page.invalidOffset }));
          if (page?.resourceLimited) throw new SourceSemanticResourceExhausted("access source dependencies");
          if (page !== null) {
            bodyBytes = page.bodyBytes;
            if (page.record?.source_body != null && !page.invalidOffset) {
              const chunk = page.record.source_body;
              meter.charge(chunk.length, 8 * chunk.length + 32, "access source retention");
              chunks.push(chunk); characters += chunk.length; offset += Buffer.byteLength(chunk);
              complete = offset >= bodyBytes;
              advance = !complete && chunk.length > 0;
            }
          }
        }
      } catch (error) { if (!(error instanceof SourceSemanticResourceExhausted)) throw error; resourceLimited = true; }
      const scoring = offset === 0 && !complete ? { work_units: 0, memory_bytes: 0 } : policy.sourceCost(characters);
      completionCost = { work_units: scoring.work_units, memory_bytes: scoring.memory_bytes + 4 * characters };
      if (firstExtent) {
        // Reads and retention (including their fixed overhead) have executed. Only the
        // retained prefix's scoring and assembly remain; later extents reserve themselves.
        try { releaseDeferred = meter.hold(completionCost); }
        catch (error) {
          if (!(error instanceof SourceSemanticResourceExhausted)) throw error;
          resourceLimited = true; advance = false;
        }
        yield releaseDeferred ?? (() => undefined);
        releaseDeferred?.(); releaseDeferred = undefined; firstExtent = false;
      }
      if (!advance) break;
    }
    let signal = UNKNOWN;
    try {
      meter.reserve(completionCost.work_units, completionCost.memory_bytes, "access source completion");
      meter.charge(0, 4 * characters, "access source assembly");
      if (offset > 0 || complete) signal = policy.source(chunks.join(""), meter);
    } catch (error) { if (!(error instanceof SourceSemanticResourceExhausted)) throw error; resourceLimited = true; }
    settled = true;
    return { read_bytes: offset, body_bytes: bodyBytes, complete, signal, resourceLimited };
  } finally {
    releaseDeferred?.();
    meter.observer?.event("observation_read_complete", meter.phase, () => ({ record_id: record.identity, source_id: record.source_id,
      start: 0, end: offset, body_bytes: bodyBytes, complete, resource_limited: resourceLimited,
      stop: !settled ? "interrupted" : resourceLimited ? "budget" : complete ? "complete"
        : sourcePreviewByteExtent !== undefined && offset >= sourcePreviewByteExtent ? "preview_extent" : "unavailable" }));
  }
}

function finishSourceText(read: SourceTextRead, step = read.next()): SourceTextResult {
  while (!step.done) step = read.next();
  if (step.value === undefined) throw new CoreError("CONFLICT", "source observation continuation is closed");
  return step.value;
}

/** A request-local handoff, never a new source identity or a cross-snapshot body cache. */
export function beginCanonicalSourceText(repo: SqliteFieldSourceRecordRepo, record: SourceRecordIdentity, policy: Policy,
  meter: SourceSemanticReadBudget, continuationMeter: SourceSemanticReadBudget, bodyBytes: number) {
  const native = quoteSemanticSourceObservation(policy.sourceCost, Math.min(4096, bodyBytes));
  const outstanding = meter.outstandingAllowance();
  let releaseParent: () => void;
  try {
    meter.reserve(native.work_units, native.memory_bytes, "canonical source observation start");
    releaseParent = continuationMeter.hold({ work_units: outstanding.work_units + native.work_units,
      memory_bytes: outstanding.memory_bytes + native.memory_bytes });
  } catch (error) {
    if (!(error instanceof SourceSemanticResourceExhausted)) throw error;
    // Neither reader has run: keep the ordinary metadata/census seam.
    return undefined;
  }
  const read = sourceTextRead(repo, record, policy, meter, undefined, true);
  let consumed = false;
  try {
    // Continuation control state belongs to the parent's metadata allowance, outside the
    // child's already-held canonical native guarantee. Charge the actual retained objects.
    continuationMeter.retain(read, "access source observation continuation");
    read.next();
    const first = read.next();
    continuationMeter.retain(first, "access source observation suspended extent");
    const pending = {
      resume: (afterExtent?: () => void): SourceTextResult => {
        if (consumed) throw new CoreError("CONFLICT", "source observation continuation is closed");
        consumed = true;
        try {
          // Caller failures remain census/completion failures, not partial body observations.
          afterExtent?.();
          return finishSourceText(read, first);
        } finally { read.return(undefined); }
      },
      release: first.done ? () => undefined : first.value!,
      close: () => { consumed = true; read.return(undefined); }
    };
    continuationMeter.retain(pending, "access source observation handoff");
    return pending;
  } catch (error) { read.return(undefined); throw error; }
  finally { releaseParent(); }
}

export function readSourceText(repo: SqliteFieldSourceRecordRepo, record: SourceRecordIdentity, policy: Policy,
  meter: SourceSemanticReadBudget, sourcePreviewByteExtent?: number, afterExtent?: () => void): SourceTextResult {
  const read = sourceTextRead(repo, record, policy, meter, sourcePreviewByteExtent);
  try {
    meter.retain(read, "access source observation continuation");
    read.next();
    afterExtent?.();
    return finishSourceText(read);
  } finally { read.return(undefined); }
}
