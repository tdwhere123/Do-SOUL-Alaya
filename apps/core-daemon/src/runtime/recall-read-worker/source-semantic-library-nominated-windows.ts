import { type IndexEntry, type SourceSemanticAcquisitionPhase, SourceSemanticResourceExhausted } from "@do-soul/alaya-protocol";
import { CoreError, authorizeSemanticScope, fieldContractSha256, hydrateUtf8Chunk, projectSourceDisclosure,
  sourceGoldRootIdentity, sourceSemanticLibraryRawPreview, type SourceSemanticLibraryPackage } from "@do-soul/alaya-core";
import { SqliteFieldSourceRecordRepo, RETAINED_SOURCE_READ_RESERVATION } from "@do-soul/alaya-storage";
import { sourceSemanticReadStores, type SourceSemanticReadBudget } from "../field/source-semantic-read-stores.js";
import type { SourceSemanticReadRuntime } from "./runtime.js";
import type { SourceSemanticWorkerPayload } from "./source-semantic-discovery.js";

export const LIBRARY_SOURCE_DISPLAY_BYTES = 4096;
export type LibrarySourceNomination = NonNullable<SourceSemanticAcquisitionPhase["result"]>["nominations"][number];

/** Private navigation hydration, never a semantic support or multi-span package producer.
 *
 * Live daemon library recall no longer selects nominations; the retained consumer is the
 * accepted C3 diagnostic (`apps/bench-runner/src/runs/source-access-diagnostic/field-delivery-read.ts`),
 * which supplies its own frozen nominations and must keep the unchanged window/packing
 * behavior. Removal gate: delete this module and that import together when the diagnostic
 * retires its native-anchor window path or moves to the conditional-field page producer.
 */
export function prepareNominatedLibraryWindows(runtime: SourceSemanticReadRuntime, payload: SourceSemanticWorkerPayload,
  authorized: readonly string[] | null, meter: SourceSemanticReadBudget, sources: readonly IndexEntry[],
  nominations: readonly LibrarySourceNomination[], sourcePositions?: ReadonlyMap<string, number>): SourceSemanticLibraryPackage[] {
  const packages: SourceSemanticLibraryPackage[] = [];
  meter.charge(nominations.length, 0, "library nominated location enumeration");
  if (nominations.every(row => row.vector?.window === undefined)) return packages;
  // Navigation only: this invocation's baseline may supply first-position tuple identities.
  // The index never proves currentness, logical source identity, byte retention or scope.
  const positions = sourcePositions ?? indexSourcePositions(sources, meter);
  for (const nomination of nominations) {
    const window = nomination.vector?.window;
    // A lexical rank has no byte location. Never manufacture a prefix location for it.
    if (window === undefined) continue;
    const target = nomination.source.target;
    if (target.root_kind !== "source_record" || nomination.source.source_id === null) {
      throw new CoreError("VALIDATION", "diagnostic nominated windows require a source record");
    }
    meter.retain(nomination.source, "library nominated source binding");
    if (target.workspace_id !== payload.workspace_id || nomination.source.root_key !== sourceGoldRootIdentity(target)) {
      throw new CoreError("CONFLICT", "nominated window has a different source binding");
    }
    meter.charge(1, 0, "library nominated source lookup");
    const position = positions.get(nomination.source.root_key);
    if (position === undefined) throw new CoreError("CONFLICT", "nominated window is outside the captured source pool");
    const source = sources[position];
    meter.retain(source?.target, "library nominated pool binding");
    if (source?.target.kind !== "source_evidence" || sourceGoldRootIdentity(source.target) !== nomination.source.root_key) {
      throw new CoreError("CONFLICT", "nominated window is outside the captured source pool");
    }
    const current = sourceSemanticReadStores(runtime.database, payload.workspace_id, nomination.source.source_id,
      meter, authorized).getCurrentRecord(payload.workspace_id, nomination.source.source_id);
    if (current === null || current.identity !== target.root_id || current.source_version !== target.source_version
      || current.content_digest !== target.content_digest) {
      throw new CoreError("CONFLICT", "nominated window is not the current source record");
    }
    authorizeSemanticScope(current.scope_class, authorized);
    const size = window.end_byte - window.start_byte;
    if (!Number.isSafeInteger(window.start_byte) || window.start_byte < 0 || !Number.isSafeInteger(window.end_byte)
      || size < 1 || size > LIBRARY_SOURCE_DISPLAY_BYTES || window.end_byte > nomination.source.body_bytes) {
      throw new CoreError("VALIDATION", "nominated window exceeds the contiguous display bounds");
    }
    const text = readWindow(runtime, payload.workspace_id, target.root_id, nomination.source.body_bytes,
      window.start_byte, window.end_byte, meter);
    meter.charge(text.length * 3, Buffer.byteLength(text) * 3, "library nominated window verification");
    if (`sha256:${fieldContractSha256(text)}` !== window.content_digest) {
      throw new CoreError("CONFLICT", "nominated window digest does not match retained bytes");
    }
    const preview = sourceSemanticLibraryRawPreview(text, sources.length);
    const end = window.start_byte + Buffer.byteLength(preview);
    const entry = { ...source, target: { ...source.target, span: { content_start: window.start_byte, content_end: end,
      retained_extent: "body" as const, content_complete: window.start_byte === 0 && end === nomination.source.body_bytes,
      original_complete: false } } };
    meter.charge(1, 1024, "library nominated raw package");
    packages.push({ entry, entries: [entry], explanations: [], proofs: [], preview, access_position: position,
      payload_support: "not_applicable", source_disclosure: projectSourceDisclosure({ material_kind: "original_body",
        evaluated_as_of: payload.as_of, source: current }) });
  }
  return packages;
}

/** Preserve findIndex's first-position semantics for standalone hydration callers. */
function indexSourcePositions(sources: readonly IndexEntry[], meter: SourceSemanticReadBudget): ReadonlyMap<string, number> {
  meter.charge(1, 64, "library nominated source index");
  const positions = new Map<string, number>();
  for (const [position, entry] of sources.entries()) {
    meter.charge(1, 0, "library nominated source enumeration");
    if (entry.target.kind !== "source_evidence") continue;
    meter.retain(entry.target, "library nominated source identity");
    const root = sourceGoldRootIdentity(entry.target);
    if (positions.has(root)) continue;
    meter.charge(1, 64 + root.length * 2, "library nominated source index");
    positions.set(root, position);
  }
  return positions;
}

/** Native chunks may end before the requested interval; each next read is bounded and charged. */
function readWindow(runtime: SourceSemanticReadRuntime, workspace: string, recordId: string, bodyBytes: number,
  start: number, end: number, meter: SourceSemanticReadBudget): string {
  const repo = new SqliteFieldSourceRecordRepo(runtime.database, fieldContractSha256), chunks: string[] = [];
  for (let offset = start; offset < end;) {
    meter.reserve(5, RETAINED_SOURCE_READ_RESERVATION, "library nominated raw read");
    const read = repo.findByIdBounded(workspace, recordId, end - offset, offset,
      { workLimit: meter.work, nativeByteLimit: meter.bytes });
    meter.read(5 + (read?.dependencyWork ?? 0), read === null ? 0 : read.nativeBytes + read.metadataBytes);
    meter.observer?.event("source_read", meter.phase, () => ({ purpose: "nominated_window_hydration", record_id: recordId,
      start: offset, end: offset + Buffer.byteLength(read?.record?.source_body ?? ""), requested_end: end,
      native_bytes: read === null ? 0 : read.nativeBytes + read.metadataBytes, resource_limited: read?.resourceLimited ?? false }));
    if (read?.resourceLimited) throw new SourceSemanticResourceExhausted("library nominated source dependencies");
    if (read?.record?.source_body == null || read.invalidOffset || read.bodyBytes !== bodyBytes) {
      throw new CoreError("CONFLICT", "nominated source bytes are unavailable or misbound");
    }
    const text = read.record.source_body;
    meter.charge(text.length * 3, Buffer.byteLength(text) * 3 + 32, "library nominated UTF-8 chunk");
    const chunk = hydrateUtf8Chunk(text, { byteLimit: end - offset });
    if (chunk.status !== "chunk" || chunk.end_offset === 0) {
      throw new CoreError("VALIDATION", "nominated window does not end on a UTF-8 boundary");
    }
    chunks.push(chunk.text); offset += chunk.end_offset;
  }
  meter.charge(chunks.length, (end - start) * 2, "library nominated contiguous assembly");
  return chunks.join("");
}
