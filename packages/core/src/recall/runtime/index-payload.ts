import type { IndexEntry, ManifestationState } from "@do-soul/alaya-protocol";
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
  }>) {
    this.previews = new Map(Object.entries(input.previewCache ?? {}));
    this.remainingMemoryBytes = input.remainingMemoryBytes;
  }

  public finalize(entries: readonly IndexEntry[], allowance: number): Readonly<{ remaining: number; complete: boolean }> {
    let remaining = allowance;
    let complete = true;
    for (const entry of entries) {
      if (this.input.manifestationFor(entry.object_id) === "hint") {
        const preview = `[memory ref: ${entry.object_id}]`;
        const bytes = Buffer.byteLength(preview, "utf8");
        if (remaining < 1 || bytes > this.remainingMemoryBytes) { complete = false; this.previews.delete(entry.object_id); continue; }
        remaining -= 1; this.remainingMemoryBytes -= bytes;
        this.previews.set(entry.object_id, preview);
        continue;
      }
      const facts = this.input.sourceFacts?.[entry.object_id];
      if (this.sourceMetadata[entry.object_id] === undefined && facts !== undefined) {
        const metadata = {
          ...(facts.evidence_refs === undefined ? {} : { evidence_refs: facts.evidence_refs }),
          ...(facts.staged_warnings === undefined ? {} : { staged_warnings: facts.staged_warnings })
        };
        const bytes = Buffer.byteLength(JSON.stringify([entry.object_id, metadata]), "utf8");
        if (remaining < 1 || bytes > this.remainingMemoryBytes) {
          complete = false; this.previews.delete(entry.object_id); continue;
        }
        remaining -= 1; this.remainingMemoryBytes -= bytes;
        this.sourceMetadata[entry.object_id] = metadata;
      }
      if (this.previews.has(entry.object_id)) continue;
      const retainedContent = this.input.sourceFacts?.[entry.object_id]?.content;
      if (retainedContent !== undefined) {
        const preview = createContentPreview(retainedContent, "excerpt");
        const bytes = Buffer.byteLength(preview, "utf8");
        if (remaining < 1 || bytes > this.remainingMemoryBytes) { complete = false; continue; }
        remaining -= 1; this.remainingMemoryBytes -= bytes;
        this.previews.set(entry.object_id, preview);
        continue;
      }
      if (this.input.readers.source === undefined || remaining < 5 || this.remainingMemoryBytes < 1) { complete = false; continue; }
      const page = this.input.readers.source({ workspaceId: this.input.workspaceId, objectId: entry.object_id,
        byteLimit: Math.max(1, Math.min(65536, this.remainingMemoryBytes)) });
      remaining -= Math.max(1, page.rowsRead) + 2;
      this.remainingMemoryBytes = Math.max(0, this.remainingMemoryBytes - page.bytesRead);
      if (page.row?.content === undefined || page.unavailable) { complete = false; continue; }
      const metadata = {
        ...(page.row.evidence_refs === undefined ? {} : { evidence_refs: page.row.evidence_refs }),
        ...(page.row.staged_warnings === undefined ? {} : { staged_warnings: page.row.staged_warnings })
      };
      const metadataBytes = Buffer.byteLength(JSON.stringify([entry.object_id, metadata]), "utf8");
      if (metadataBytes > this.remainingMemoryBytes) { complete = false; continue; }
      this.remainingMemoryBytes -= metadataBytes;
      this.sourceMetadata[entry.object_id] = metadata;
      this.previews.set(entry.object_id, createContentPreview(page.row.content, "excerpt"));
    }
    return { remaining: Math.max(0, remaining), complete };
  }
}
