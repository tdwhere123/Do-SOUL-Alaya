import {
  MemoryDimension,
  ScopeClass,
  indexEntryCacheKey,
  indexEntrySubjectId,
  indexMemoryObjectId,
  type IndexEntry,
  type ManifestationState,
  type PayloadContinuationRequest,
  type SourceEvidenceTarget
} from "@do-soul/alaya-protocol";
import type { BoundSourceFacts } from "../conditional-field/engine/binding-environment.js";
import type { ObserverReaders } from "../conditional-field/observers/observe.js";
import { createContentPreview } from "./recall-service-helpers.js";
import type { RecallSourceMetadata } from "./recall-service-results.js";

export class BoundedIndexPayload {
  public readonly previews: Map<string, string>;
  public readonly sourceMetadata: Record<string, RecallSourceMetadata> = {};
  public remainingMemoryBytes: number;

  public constructor(private readonly input: Readonly<{
    readonly sourceFacts?: Readonly<Record<string, BoundSourceFacts>>;
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
      const subjectId = indexEntrySubjectId(entry);
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
      const facts = this.input.sourceFacts?.[subjectId]
        ?? (objectId === undefined ? undefined : this.input.sourceFacts?.[objectId]);
      if (this.sourceMetadata[cacheKey] === undefined && facts !== undefined) {
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
      if (continued === undefined
        && (this.previews.has(cacheKey) || (objectId !== undefined && this.previews.has(objectId)))) {
        continue;
      }
      const retainedContent = facts?.content
        ?? (objectId === undefined ? undefined : this.input.sourceFacts?.[objectId]?.content);
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
        if (hydrated.retryable || this.previews.has(cacheKey) || retainedContent === undefined) continue;
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
      this.remainingMemoryBytes = Math.max(0, this.remainingMemoryBytes - page.bytesRead);
      if (page.row?.content === undefined || page.unavailable) { complete = false; continue; }
      const metadata = sourceMetadataFrom(page.row);
      const metadataBytes = Buffer.byteLength(JSON.stringify([objectId, metadata]), "utf8");
      if (metadataBytes > this.remainingMemoryBytes) { complete = false; continue; }
      this.remainingMemoryBytes -= metadataBytes;
      rememberMetadata(this.sourceMetadata, cacheKey, objectId, metadata);
      rememberPreview(this.previews, cacheKey, objectId, createContentPreview(page.row.content, "excerpt"));
    }
    return { remaining: Math.max(0, remaining), complete, retryable: !complete && retryable };
  }

  private payloadContinuationFor(target: IndexEntry["target"]): PayloadContinuationRequest | undefined {
    const continuation = this.input.payloadContinuation;
    if (continuation === undefined || continuation.purpose !== "payload_expansion") return undefined;
    if (target.kind !== "source_evidence" || continuation.target.kind !== "source_evidence") return undefined;
    return sameSourceEvidenceTarget(target, continuation.target) ? continuation : undefined;
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
    const byteLimit = hydrateByteLimit(continuation, this.remainingMemoryBytes);
    const page = reader({
      workspaceId: this.input.workspaceId,
      rootKind: target.root_kind,
      rootId: target.root_id,
      revision: target.source_version,
      digest: target.content_digest,
      evidenceObjectId: target.evidence_object_id,
      byteLimit,
      offset
    });
    const nextRemaining = remaining - Math.max(1, page.rowsRead) - 2;
    this.remainingMemoryBytes = Math.max(0, this.remainingMemoryBytes - page.bytesRead);
    if (page.row?.content === undefined || page.unavailable) {
      return { ok: false, remaining: nextRemaining, retryable: false };
    }
    const truncated = page.resourceLimited === true || page.row.content_complete === false;
    if (page.row.content.length > 0) {
      rememberPreview(
        this.previews,
        cacheKey,
        undefined,
        createContentPreview(page.row.content, "excerpt")
      );
      const metadata = sourceMetadataFrom(page.row);
      if (metadata.dimension !== undefined || metadata.scope_class !== undefined
        || metadata.evidence_refs !== undefined || metadata.staged_warnings !== undefined) {
        rememberMetadata(this.sourceMetadata, cacheKey, undefined, metadata);
      }
    }
    return { ok: !truncated, remaining: nextRemaining, retryable: truncated };
  }
}

function sameSourceEvidenceTarget(left: SourceEvidenceTarget, right: SourceEvidenceTarget): boolean {
  return left.workspace_id === right.workspace_id
    && left.root_kind === right.root_kind
    && left.root_id === right.root_id
    && left.source_version === right.source_version
    && left.content_digest === right.content_digest
    && left.evidence_object_id === right.evidence_object_id;
}

function hydrateByteLimit(
  continuation: PayloadContinuationRequest | undefined,
  remainingMemoryBytes: number
): number {
  const memoryCap = Math.max(1, Math.min(65536, remainingMemoryBytes));
  if (continuation === undefined) return memoryCap;
  if (continuation.byte_budget !== undefined) {
    return Math.max(1, Math.min(continuation.byte_budget, memoryCap));
  }
  if (continuation.end_offset !== undefined) {
    const start = continuation.start_offset ?? 0;
    return Math.max(1, Math.min(continuation.end_offset - start, memoryCap));
  }
  return memoryCap;
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
