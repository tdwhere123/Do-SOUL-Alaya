import {
  MemoryDimension,
  ScopeClass,
  indexEntryCacheKey,
  indexMemoryObjectId,
  sameSourceEvidenceRoot,
  sourceEvidenceRootKey,
  sourceRecallTarget,
  type IndexEntry,
  type InformationIndex,
  type ManifestationState,
  type PayloadContinuationRequest,
  type SourceDeliveredSpan,
  type SourceEvidenceTarget
} from "@do-soul/alaya-protocol";
import { sourceFactKey, type BoundSourceFacts } from "../conditional-field/engine/binding-environment.js";
import type { ObserverReaders } from "../conditional-field/observers/observe.js";
import { createContentPreview } from "./recall-service-helpers.js";
import type { RecallSourceMetadata } from "./recall-service-results.js";

export class BoundedIndexPayload {
  public readonly previews: Map<string, string>;
  public readonly sourceMetadata: Record<string, RecallSourceMetadata> = {};
  public remainingMemoryBytes: number;
  private nativeVisits = 0;
  private nativeBytes = 0;
  private readonly deliveredSpans = new Map<string, SourceDeliveredSpan>();

  public constructor(private readonly input: Readonly<{
    readonly sourceFacts?: ReadonlyMap<string, BoundSourceFacts>;
    readonly previewCache?: Readonly<Record<string, string>>;
    readonly readers: ObserverReaders;
    readonly workspaceId: string;
    readonly remainingMemoryBytes: number;
    readonly manifestationFor: (objectId: string) => ManifestationState;
    readonly payloadContinuation?: PayloadContinuationRequest;
  }>) {
    this.previews = new Map(Object.entries(input.previewCache ?? {}));
    this.remainingMemoryBytes = input.remainingMemoryBytes;
  }

  public finalize(entries: readonly IndexEntry[], allowance: number): Readonly<{
    readonly remaining: number;
    readonly complete: boolean;
    readonly retryable: boolean;
  }> {
    let remaining = allowance;
    let complete = true;
    let retryable = false;
    for (const entry of entries) {
      const cacheKey = indexEntryCacheKey(entry);
      const objectId = indexMemoryObjectId(entry);
      if (entry.target.kind === "memory_entry" && objectId !== undefined && !this.previews.has(cacheKey)) {
        this.previews.delete(objectId);
      }
      if (objectId !== undefined && this.input.manifestationFor(objectId) === "hint") {
        const preview = `[memory ref: ${objectId}]`;
        const bytes = Buffer.byteLength(preview, "utf8");
        if (remaining < 1 || bytes > this.remainingMemoryBytes) {
          complete = false;
          forgetPreview(this.previews, cacheKey, objectId);
          continue;
        }
        remaining -= 1; this.remainingMemoryBytes -= bytes;
        rememberPreview(this.previews, cacheKey, objectId, preview);
        continue;
      }
      const facts = this.input.sourceFacts?.get(sourceFactKey(entry.target));
      const factsMatchEntry = observedMemoryRevisionMatches(entry, facts?.source_revision);
      if (this.sourceMetadata[cacheKey] === undefined && facts !== undefined && factsMatchEntry) {
        const metadata = sourceMetadataFrom(facts);
        const bytes = Buffer.byteLength(JSON.stringify([objectId, metadata]), "utf8");
        if (remaining < 1 || bytes > this.remainingMemoryBytes) {
          complete = false;
          forgetPreview(this.previews, cacheKey, objectId);
          continue;
        }
        remaining -= 1; this.remainingMemoryBytes -= bytes;
        rememberMetadata(this.sourceMetadata, cacheKey, objectId, metadata);
      }
      const continued = this.payloadContinuationFor(entry.target);
      if (continued !== undefined) forgetPreview(this.previews, cacheKey, objectId);
      const cachedPreview = this.previews.has(cacheKey)
        || (objectId !== undefined
          && entry.target.kind !== "memory_entry"
          && this.previews.has(objectId));
      if (continued === undefined && cachedPreview) {
        continue;
      }
      const retainedContent = factsMatchEntry
        ? (facts?.content
          ?? (objectId === undefined ? undefined : this.input.sourceFacts?.get(objectId)?.content))
        : undefined;
      if (retainedContent !== undefined && entry.target.kind !== "source_evidence") {
        const preview = createContentPreview(retainedContent, "excerpt");
        const bytes = Buffer.byteLength(preview, "utf8");
        if (remaining < 1 || bytes > this.remainingMemoryBytes) { complete = false; continue; }
        remaining -= 1; this.remainingMemoryBytes -= bytes;
        rememberPreview(this.previews, cacheKey, objectId, preview);
        continue;
      }
      if (entry.target.kind === "source_evidence") {
        const hydrated = this.hydrateSourceTarget(entry.target, cacheKey, remaining);
        remaining = hydrated.remaining;
        if (hydrated.retryable) retryable = true;
        if (hydrated.ok) continue;
        complete = false;
        if (continued !== undefined || hydrated.retryable || this.previews.has(cacheKey) || retainedContent === undefined) continue;
        const preview = createContentPreview(retainedContent, "excerpt");
        const bytes = Buffer.byteLength(preview, "utf8");
        if (remaining < 1 || bytes > this.remainingMemoryBytes) continue;
        remaining -= 1; this.remainingMemoryBytes -= bytes;
        rememberPreview(this.previews, cacheKey, objectId, preview);
        continue;
      }
      if (objectId === undefined || this.input.readers.source === undefined || remaining < 5 || this.remainingMemoryBytes < 1) { complete = false; continue; }
      const page = this.input.readers.source({ workspaceId: this.input.workspaceId, objectId,
        byteLimit: Math.max(1, Math.min(65536, this.remainingMemoryBytes)) });
      remaining -= Math.max(1, page.rowsRead) + 2;
      this.nativeVisits += Math.max(1, page.rowsRead);
      this.nativeBytes += page.bytesRead;
      this.remainingMemoryBytes = Math.max(0, this.remainingMemoryBytes - page.bytesRead);
      if (page.row?.content === undefined || page.unavailable) { complete = false; continue; }
      // Object-id source lookup is current state, not the pinned product.
      if (!observedMemoryRevisionMatches(entry, page.row.sourceRevision)) {
        complete = false;
        forgetPreview(this.previews, cacheKey, objectId);
        continue;
      }
      const metadata = sourceMetadataFrom(page.row);
      const metadataBytes = Buffer.byteLength(JSON.stringify([objectId, metadata]), "utf8");
      if (metadataBytes > this.remainingMemoryBytes) { complete = false; continue; }
      this.remainingMemoryBytes -= metadataBytes;
      rememberMetadata(this.sourceMetadata, cacheKey, objectId, metadata);
      rememberPreview(this.previews, cacheKey, objectId, createContentPreview(page.row.content, "excerpt"));
    }
    return { remaining: Math.max(0, remaining), complete, retryable: !complete && retryable };
  }

  public takeNativeWork(): Readonly<{ readonly native_visits: number; readonly native_bytes: number }> {
    const work = { native_visits: this.nativeVisits, native_bytes: this.nativeBytes };
    this.nativeVisits = 0;
    this.nativeBytes = 0;
    return work;
  }

  public applyDeliveredSpans(index: InformationIndex): InformationIndex {
    if (this.deliveredSpans.size === 0) return index;
    return { ...index, entries: index.entries.map((entry) => this.stampDeliveredSpan(entry)) };
  }

  private payloadContinuationFor(target: IndexEntry["target"]): PayloadContinuationRequest | undefined {
    const continuation = this.input.payloadContinuation;
    if (continuation === undefined || continuation.purpose !== "payload_expansion") return undefined;
    if (target.kind !== "source_evidence" || continuation.target.kind !== "source_evidence") return undefined;
    return sameSourceEvidenceRoot(target, continuation.target) ? continuation : undefined;
  }

  private hydrateSourceTarget(
    target: SourceEvidenceTarget,
    cacheKey: string,
    remaining: number
  ): Readonly<{ readonly ok: boolean; readonly remaining: number; readonly retryable: boolean }> {
    const reader = this.input.readers.sourceRoot;
    if (reader === undefined || remaining < 5 || this.remainingMemoryBytes < 1) {
      return { ok: false, remaining, retryable: false };
    }
    const continuation = this.payloadContinuationFor(target);
    const offset = continuation?.start_offset ?? 0;
    const byteLimit = hydrateByteLimit(continuation, this.remainingMemoryBytes, this.input.readers.sourceRootMetadataByteLimit ?? 0);
    if (byteLimit < 1) {
      return { ok: false, remaining, retryable: continuation?.byte_budget !== 0 };
    }
    const page = reader({
      workspaceId: this.input.workspaceId,
      rootKind: target.root_kind,
      rootId: target.root_id,
      revision: target.source_version,
      digest: target.content_digest,
      evidenceObjectId: target.evidence_object_id,
      byteLimit,
      nativeByteLimit: this.remainingMemoryBytes,
      offset
    });
    const nextRemaining = remaining - Math.max(1, page.nativeWork ?? page.rowsRead) - 2;
    this.nativeVisits += Math.max(1, page.nativeWork ?? page.rowsRead);
    this.nativeBytes += page.bytesRead + (page.metadataBytes ?? 0);
    this.remainingMemoryBytes = Math.max(0, this.remainingMemoryBytes - page.bytesRead - (page.metadataBytes ?? 0));
    if (page.row?.content === undefined || page.unavailable) {
      return { ok: false, remaining: nextRemaining, retryable: page.resourceLimited === true };
    }
    const truncated = page.resourceLimited === true || page.row.content_complete === false;
    this.deliveredSpans.set(sourceEvidenceRootKey(target), deliveredSpanFromHydrate(page.row, offset, !truncated));
    {
      rememberPreview(
        this.previews,
        cacheKey,
        undefined,
        page.row.content
      );
      const metadata = sourceMetadataFrom(page.row);
      if (metadata.dimension !== undefined || metadata.scope_class !== undefined
        || metadata.evidence_refs !== undefined || metadata.staged_warnings !== undefined) {
        rememberMetadata(this.sourceMetadata, cacheKey, undefined, metadata);
      }
    }
    return { ok: !truncated, remaining: nextRemaining, retryable: truncated };
  }

  private stampDeliveredSpan(entry: IndexEntry): IndexEntry {
    if (entry.target.kind !== "source_evidence") return entry;
    const span = this.deliveredSpans.get(sourceEvidenceRootKey(entry.target));
    if (span === undefined) return entry;
    const stamped = sourceRecallTarget({
      workspace_id: entry.target.workspace_id,
      root_kind: entry.target.root_kind,
      root_id: entry.target.root_id,
      source_version: entry.target.source_version,
      content_digest: entry.target.content_digest,
      evidence_object_id: entry.target.evidence_object_id,
      span
    });
    const next = { ...entry, target: stamped };
    const previousKey = indexEntryCacheKey(entry);
    const nextKey = indexEntryCacheKey(next);
    if (previousKey !== nextKey) {
      const preview = this.previews.get(previousKey);
      if (preview !== undefined) this.previews.set(nextKey, preview);
      const metadata = this.sourceMetadata[previousKey];
      if (metadata !== undefined) this.sourceMetadata[nextKey] = metadata;
    }
    return next;
  }
}

function hydrateByteLimit(
  continuation: PayloadContinuationRequest | undefined,
  remainingMemoryBytes: number,
  metadataReserve: number
): number {
  const memoryCap = Math.max(0, Math.min(65536, remainingMemoryBytes - metadataReserve));
  if (continuation === undefined) return memoryCap;
  const spanCap = continuation.end_offset === undefined ? memoryCap
    : continuation.end_offset - (continuation.start_offset ?? 0);
  return Math.max(0, Math.min(continuation.byte_budget ?? memoryCap, spanCap, memoryCap));
}

function rememberPreview(
  previews: Map<string, string>,
  cacheKey: string,
  objectId: string | undefined,
  preview: string
): void {
  previews.set(cacheKey, preview);
  if (objectId !== undefined && objectId !== cacheKey) previews.set(objectId, preview);
}

function forgetPreview(
  previews: Map<string, string>,
  cacheKey: string,
  objectId: string | undefined
): void {
  previews.delete(cacheKey);
  if (objectId !== undefined) previews.delete(objectId);
}

function rememberMetadata(
  metadata: Record<string, RecallSourceMetadata>,
  cacheKey: string,
  objectId: string | undefined,
  value: RecallSourceMetadata
): void {
  metadata[cacheKey] = value;
  if (objectId !== undefined && objectId !== cacheKey) metadata[objectId] = value;
}

function observedMemoryRevisionMatches(
  entry: IndexEntry,
  observedRevision: string | undefined
): boolean {
  if (entry.target.kind !== "memory_entry") return true;
  return observedRevision === entry.target.source_revision;
}

function sourceMetadataFrom(row: Readonly<{
  readonly evidence_refs?: readonly string[];
  readonly staged_warnings?: RecallSourceMetadata["staged_warnings"];
  readonly dimension?: string;
  readonly scope_class?: string;
}>): RecallSourceMetadata {
  const dimension = knownEnum(row.dimension, MemoryDimension);
  const scopeClass = knownEnum(row.scope_class, ScopeClass);
  return {
    ...(row.evidence_refs === undefined ? {} : { evidence_refs: row.evidence_refs }),
    ...(row.staged_warnings === undefined ? {} : { staged_warnings: row.staged_warnings }),
    ...(dimension === undefined ? {} : { dimension }),
    ...(scopeClass === undefined ? {} : { scope_class: scopeClass })
  };
}

function knownEnum<T extends string>(
  value: string | undefined,
  allowed: Readonly<Record<string, T>>
): T | undefined {
  return (Object.values(allowed) as readonly string[]).includes(value ?? "")
    ? value as T
    : undefined;
}

type HydrateSpanRow = Readonly<{
  readonly content?: string;
  readonly content_start?: number;
  readonly content_end?: number;
  readonly content_complete?: boolean;
  readonly original_complete?: boolean;
  readonly retained_extent?: string;
}>;

function deliveredSpanFromHydrate(
  row: HydrateSpanRow,
  offset: number,
  contentComplete: boolean
): SourceDeliveredSpan {
  const start = nonNegativeInt(row.content_start) ?? offset;
  const contentEnd = start + Buffer.byteLength(row.content ?? "", "utf8");
  const end = contentEnd;
  const originalComplete = row.original_complete ?? true;
  return {
    content_start: start,
    content_end: end,
    retained_extent: retainedExtentFromHydrate(row, originalComplete),
    content_complete: contentComplete,
    original_complete: originalComplete
  };
}

function nonNegativeInt(value: number | undefined): number | undefined {
  return Number.isSafeInteger(value) && value !== undefined && value >= 0 ? value : undefined;
}

function retainedExtentFromHydrate(
  row: HydrateSpanRow,
  originalComplete: boolean
): SourceDeliveredSpan["retained_extent"] {
  if (row.retained_extent === "body" || row.retained_extent === "excerpt" || row.retained_extent === "gist") {
    return row.retained_extent;
  }
  // Observer hydrate currently drops retained_extent; incomplete originals are
  // retained reductions, never the body.
  return originalComplete ? "body" : "excerpt";
}
