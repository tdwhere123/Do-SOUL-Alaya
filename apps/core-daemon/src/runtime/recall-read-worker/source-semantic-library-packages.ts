import { SourceSemanticResourceExhausted, type IndexEntry, type SourceSemanticLibraryProof,
  type SourceSemanticLibrarySlotQualifier } from "@do-soul/alaya-protocol";
import { CoreError, authorizeSemanticScope, hydrateUtf8Chunk, sourceSemanticSupportWindow, sourceSemanticLibraryRawPreview,
  sourceGoldRootIdentity, fieldContractSha256, type SourceSemanticLibraryPackage } from "@do-soul/alaya-core";
import { SqliteFieldSourceRecordRepo, RETAINED_SOURCE_READ_RESERVATION } from "@do-soul/alaya-storage";
import type { SourceSemanticReadBudget } from "../field/source-semantic-read-stores.js";
import type { RecallReadWorkerRuntime } from "./runtime.js";
import { admissionOf, type SourceSemanticWorkerPayload } from "./source-semantic-discovery.js";

const DISPLAY_BYTES = 4096;
export type LibraryExecutedSupport = Readonly<{
  proof: SourceSemanticLibraryProof;
  group: Pick<SourceSemanticLibraryPackage, "entries" | "explanations">;
  source: string; dependencies: readonly string[];
}>;

/** Hydration consumes actual execution origins and current authorized source bytes. */
export function prepareLibraryPackages(runtime: RecallReadWorkerRuntime, payload: SourceSemanticWorkerPayload,
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
      const semantic = supportPackage(entry, position, branches[0]?.source ?? retained.text, branches, meter);
      if (semantic.package !== undefined) packages.push(semantic.package);
      const chunk = hydrate(meter, retained.text, 0, DISPLAY_BYTES);
      if (chunk.status !== "chunk") { incomplete = true; continue; }
      const preview = sourceSemanticLibraryRawPreview(chunk.text, sources.length);
      const raw = spanEntry(entry, 0, Buffer.byteLength(preview), retained.bytes);
      packages.push({ entry: raw, entries: [raw], explanations: [], proofs: [], preview,
        access_position: position, payload_support: semantic.reason });
    } catch (error) {
      if (!(error instanceof SourceSemanticResourceExhausted)
        && !(error instanceof CoreError && (error.code === "NOT_FOUND" || admissionOf(error) === "filtered"))) throw error;
      incomplete = true;
      if (error instanceof SourceSemanticResourceExhausted) break;
    }
  }
  return { packages, incomplete };
}

function supportPackage(entry: IndexEntry, position: number, source: string, branches: readonly LibraryExecutedSupport[],
  meter: SourceSemanticReadBudget): { package?: SourceSemanticLibraryPackage; reason: NonNullable<SourceSemanticLibrarySlotQualifier["payload_support"]> } {
  if (branches.length === 0) return { reason: "not_applicable" };
  let start = Infinity, end = 0;
  for (const row of branches) {
    const window = sourceSemanticSupportWindow({ source, interpretation: row.proof.interpretation,
      dependency_ids: row.dependencies, max_bytes: DISPLAY_BYTES, meter });
    if (window.status !== "available") return { reason: window.reason };
    start = Math.min(start, window.start_offset); end = Math.max(end, window.end_offset);
  }
  if (end - start > DISPLAY_BYTES) return { reason: "display_budget" };
  const chunk = hydrate(meter, source, start, end - start);
  if (chunk.status !== "chunk" || chunk.end_offset !== end) return { reason: "location_missing" };
  const entries = branches.flatMap(row => row.group.entries);
  const representative = [...entries].sort((a, b) => a.hypothesis_id.localeCompare(b.hypothesis_id) || a.output_binding.localeCompare(b.output_binding))[0]!;
  return { reason: "envelope_budget", package: {
    entry: spanEntry(representative, start, end, Buffer.byteLength(source)), entries,
    explanations: branches.flatMap(row => row.group.explanations), proofs: branches.map(row => row.proof),
    preview: chunk.text, access_position: position, payload_support: "available"
  } };
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
function readSource(runtime: RecallReadWorkerRuntime, payload: SourceSemanticWorkerPayload,
  authorized: readonly string[] | null, meter: SourceSemanticReadBudget, entry: IndexEntry): { text: string; bytes: number } | undefined {
  if (entry.target.kind !== "source_evidence") return undefined;
  meter.reserve(5, RETAINED_SOURCE_READ_RESERVATION, "library raw prefix");
  const repo = new SqliteFieldSourceRecordRepo(runtime.database, fieldContractSha256);
  const stored = repo.findByIdBounded(payload.workspace_id, entry.target.root_id, DISPLAY_BYTES, 0);
  meter.read(5, stored === null ? 0 : stored.nativeBytes + stored.metadataBytes);
  const record = stored?.record;
  if (stored === null || record == null || record.source_body === null || record.record_id !== entry.target.root_id
    || record.source_version !== entry.target.source_version || record.content_digest !== entry.target.content_digest) return undefined;
  authorizeSemanticScope(record.scope_class, authorized);
  return { text: record.source_body, bytes: stored.bodyBytes };
}
