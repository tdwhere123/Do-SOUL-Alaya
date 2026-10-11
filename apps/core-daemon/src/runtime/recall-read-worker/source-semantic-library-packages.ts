import { SourceSemanticResourceExhausted, type IndexEntry, type SourceSemanticLibraryProof,
  type SourceSemanticLibrarySlotQualifier } from "@do-soul/alaya-protocol";
import { CoreError, authorizeSemanticScope, hydrateUtf8Chunk, sourceSemanticSupportWindow, sourceSemanticLibraryRawPreview,
  sourceGoldRootIdentity, fieldContractSha256, projectSourceDisclosure, type SourceSemanticLibraryPackage } from "@do-soul/alaya-core";
import { SqliteFieldSourceRecordRepo, RETAINED_SOURCE_READ_RESERVATION } from "@do-soul/alaya-storage";
import type { SourceSemanticReadBudget } from "../field/source-semantic-read-stores.js";
import type { SourceSemanticReadRuntime } from "./runtime.js";
import { admissionOf, type SourceSemanticWorkerPayload } from "./source-semantic-discovery.js";

const DISPLAY_BYTES = 4096;
export type LibraryExecutedSupport = Readonly<{
  proof: SourceSemanticLibraryProof;
  group: Pick<SourceSemanticLibraryPackage, "entries" | "explanations">;
  source: string; dependencies: readonly string[];
}>;

/** Hydration consumes actual execution origins and current authorized source bytes. */
export function prepareLibraryPackages(runtime: SourceSemanticReadRuntime, payload: SourceSemanticWorkerPayload,
  authorized: readonly string[] | null, meter: SourceSemanticReadBudget,
  sources: readonly IndexEntry[], executed: readonly LibraryExecutedSupport[]) {
  const packages: SourceSemanticLibraryPackage[] = [];
  let incomplete = false;
  for (const [position, entry] of sources.entries()) {
    if (entry.target.kind !== "source_evidence") continue;
    const root = sourceGoldRootIdentity(entry.target);
    const branches = executed.filter(row => row.proof.source_target !== undefined && sourceGoldRootIdentity(row.proof.source_target) === root);
    try {
      const retained = readSource(runtime, payload, authorized, meter, entry);
      if (retained === undefined) { incomplete = true; continue; }
      const disclosure = projectSourceDisclosure({ material_kind: "original_body", evaluated_as_of: payload.as_of,
        source: retained.record });
      const semantic = supportPackages(position, branches[0]?.source ?? retained.text, retained.bytes, branches, meter, disclosure);
      packages.push(...semantic.packages);
      incomplete ||= semantic.reason === "resource_budget";
      const chunk = hydrate(meter, retained.text, 0, DISPLAY_BYTES);
      if (chunk.status !== "chunk") { incomplete = true; continue; }
      const preview = sourceSemanticLibraryRawPreview(chunk.text, sources.length);
      const raw = spanEntry(entry, 0, Buffer.byteLength(preview), retained.bytes);
      packages.push({ entry: raw, entries: [raw], explanations: [], proofs: [], preview,
        access_position: position, payload_support: semantic.reason, source_disclosure: disclosure });
    } catch (error) {
      if (!(error instanceof SourceSemanticResourceExhausted)
        && !(error instanceof CoreError && (error.code === "NOT_FOUND" || admissionOf(error) === "filtered"))) throw error;
      incomplete = true;
      if (error instanceof SourceSemanticResourceExhausted) break;
    }
  }
  return { packages, incomplete };
}

function supportPackages(position: number, source: string, sourceBytes: number, branches: readonly LibraryExecutedSupport[],
  meter: SourceSemanticReadBudget, source_disclosure: SourceSemanticLibraryPackage["source_disclosure"]): {
    packages: SourceSemanticLibraryPackage[]; reason: NonNullable<SourceSemanticLibrarySlotQualifier["payload_support"]>
  } {
  const packages: SourceSemanticLibraryPackage[] = [], available: LibraryExecutedSupport[] = [];
  let reason: NonNullable<SourceSemanticLibrarySlotQualifier["payload_support"]> = "not_applicable";
  let start = Infinity, end = 0;
  try {
    for (const row of branches) {
      const window = sourceSemanticSupportWindow({ source, interpretation: row.proof.interpretation,
        dependency_ids: row.dependencies, max_bytes: DISPLAY_BYTES, meter });
      if (window.status !== "available") {
        reason = window.reason;
        if (reason === "resource_budget") return { packages, reason };
        continue;
      }
      const chunk = hydrate(meter, source, window.start_offset, window.end_offset - window.start_offset);
      if (chunk.status !== "chunk" || chunk.end_offset !== window.end_offset) { reason = "location_missing"; continue; }
      packages.push(proofPackage(position, sourceBytes, [row],
        { text: chunk.text, start_offset: window.start_offset, end_offset: window.end_offset }, meter, source_disclosure));
      available.push(row);
      start = Math.min(start, window.start_offset); end = Math.max(end, window.end_offset);
    }
    // Each executed Q/H/C proof remains whole. At most one union and one option
    // per execution are offered; the selector still reserves one package per root.
    if (available.length > 1 && end - start <= DISPLAY_BYTES) {
      const chunk = hydrate(meter, source, start, end - start);
      if (chunk.status === "chunk" && chunk.end_offset === end) {
        packages.unshift(proofPackage(position, sourceBytes, available,
          { text: chunk.text, start_offset: start, end_offset: end }, meter, source_disclosure));
      }
    }
    return { packages, reason: packages.length > 0 ? "envelope_budget" : reason };
  } catch (error) {
    if (!(error instanceof SourceSemanticResourceExhausted)) throw error;
    return { packages, reason: "resource_budget" };
  }
}

function proofPackage(position: number, sourceBytes: number, branches: readonly LibraryExecutedSupport[],
  window: { text: string; start_offset: number; end_offset: number }, meter: SourceSemanticReadBudget,
  source_disclosure: SourceSemanticLibraryPackage["source_disclosure"]): SourceSemanticLibraryPackage {
  const entriesCount = branches.reduce((sum, row) => sum + row.group.entries.length, 0);
  const explanationsCount = branches.reduce((sum, row) => sum + row.group.explanations.length, 0);
  meter.charge(branches.length + explanationsCount + entriesCount * Math.max(1, Math.ceil(Math.log2(entriesCount))),
    512 + (branches.length * 4 + entriesCount * 2 + explanationsCount) * 8, "library proof package references");
  const entries = branches.flatMap(row => row.group.entries);
  const representative = [...entries].sort((a, b) => a.hypothesis_id.localeCompare(b.hypothesis_id) || a.output_binding.localeCompare(b.output_binding))[0]!;
  return {
    entry: spanEntry(representative, window.start_offset, window.end_offset, sourceBytes), entries,
    explanations: branches.flatMap(row => row.group.explanations), proofs: branches.map(row => row.proof),
    preview: window.text, access_position: position, payload_support: "available", source_disclosure
  };
}

function spanEntry(entry: IndexEntry, start: number, end: number, extent: number): IndexEntry {
  if (entry.target.kind !== "source_evidence") return entry;
  return { ...entry, target: { ...entry.target, span: { content_start: start, content_end: end,
    retained_extent: "body", content_complete: start === 0 && end === extent, original_complete: false } } };
}
function hydrate(meter: SourceSemanticReadBudget, source: string, offset: number, bytes: number) {
  meter.charge(source.length * 3, Buffer.byteLength(source) * 3 + bytes * 2, "library source window encoding");
  return hydrateUtf8Chunk(source, { offset, byteLimit: bytes });
}
function readSource(runtime: SourceSemanticReadRuntime, payload: SourceSemanticWorkerPayload,
  authorized: readonly string[] | null, meter: SourceSemanticReadBudget, entry: IndexEntry): { text: string; bytes: number;
    record: { event_time: string | null; valid_from: string | null; valid_to: string | null } } | undefined {
  if (entry.target.kind !== "source_evidence") return undefined;
  meter.reserve(5, RETAINED_SOURCE_READ_RESERVATION, "library raw prefix");
  const repo = new SqliteFieldSourceRecordRepo(runtime.database, fieldContractSha256);
  const stored = repo.findByIdBounded(payload.workspace_id, entry.target.root_id, DISPLAY_BYTES, 0);
  meter.read(5, stored === null ? 0 : stored.nativeBytes + stored.metadataBytes);
  const record = stored?.record;
  if (stored === null || record == null || record.source_body === null || record.record_id !== entry.target.root_id
    || record.source_version !== entry.target.source_version || record.content_digest !== entry.target.content_digest) return undefined;
  authorizeSemanticScope(record.scope_class, authorized);
  return { text: record.source_body, bytes: stored.bodyBytes,
    record: { event_time: record.event_time, valid_from: record.valid_from, valid_to: record.valid_to } };
}
