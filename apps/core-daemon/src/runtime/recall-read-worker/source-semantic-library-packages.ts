import { SourceSemanticResourceExhausted, projectSourceSemanticQuerySupport, type IndexEntry, type SourceSemanticLibraryProof,
  type SourceSemanticLibrarySlotQualifier } from "@do-soul/alaya-protocol";
import { CoreError, authorizeSemanticScope, hydrateUtf8Chunk, sourceSemanticSupportWindow, sourceSemanticLibraryRawPreview,
  sourceSemanticLibrarySourceEntry,
  sourceGoldRootIdentity, fieldContractSha256, projectSourceDisclosure, type SourceSemanticLibraryPackage } from "@do-soul/alaya-core";
import { SqliteFieldSourceRecordRepo, RETAINED_SOURCE_READ_RESERVATION, type FieldSourceRecordRow } from "@do-soul/alaya-storage";
import type { SourceSemanticReadBudget } from "../field/source-semantic-read-stores.js";
import type { SourceSemanticReadRuntime } from "./runtime.js";
import { admissionOf, type SourceSemanticWorkerPayload } from "./source-semantic-discovery.js";

import { LIBRARY_SOURCE_DISPLAY_BYTES as DISPLAY_BYTES } from "./source-semantic-library-nominated-windows.js";
import { enumerateSourceRecallPairs } from "./source-recall-package-pairs.js";
export type LibraryExecutedSupport = Readonly<{
  proof: SourceSemanticLibraryProof;
  group: Pick<SourceSemanticLibraryPackage, "entries" | "explanations">;
  source: string; dependencies: readonly string[];
}>;

/** Hydration consumes actual execution origins and current authorized source bytes. */
export function prepareLibraryPackages(runtime: SourceSemanticReadRuntime, payload: SourceSemanticWorkerPayload,
  authorized: readonly string[] | null, meter: SourceSemanticReadBudget,
  sources: readonly IndexEntry[], executed: readonly LibraryExecutedSupport[]) {
  const prepared: ReturnType<typeof supportPackages>[] = [];
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
      prepared.push(semantic);
      incomplete ||= semantic.reason === "resource_budget";
      const chunk = hydrate(meter, retained.text, 0, DISPLAY_BYTES);
      if (chunk.status !== "chunk") { incomplete = true; continue; }
      const preview = sourceSemanticLibraryRawPreview(chunk.text, sources.length);
      const previewBytes = Buffer.byteLength(preview);
      const raw = spanEntry(entry, 0, previewBytes, previewBytes === retained.bytes);
      semantic.packages.push({ entry: raw, entries: [raw], explanations: [], proofs: [], preview,
        access_position: position, payload_support: semantic.reason, source_disclosure: disclosure });
    } catch (error) {
      if (!(error instanceof SourceSemanticResourceExhausted)
        && !(error instanceof CoreError && (error.code === "NOT_FOUND" || admissionOf(error) === "filtered"))) throw error;
      incomplete = true;
      if (error instanceof SourceSemanticResourceExhausted) break;
    }
  }
  const packages = prepared.flatMap(row => row.packages);
  try { if (executed.length > 0) appendLocatedSourcePackages(packages, prepared, sources, meter); }
  catch (error) {
    if (!(error instanceof SourceSemanticResourceExhausted)) throw error;
    incomplete = true;
  }
  meter.observer?.event("package_candidates", meter.phase, () => ({ incomplete, packages: packages.map(row => ({
    target: row.entry.target, access_position: row.access_position, proof_count: row.proofs.length, payload_support: row.payload_support })) }));
  return { packages, incomplete };
}

/** Optional materialization follows every root's baseline and reuses its exact hydrated chunk. */
function appendLocatedSourcePackages(packages: SourceSemanticLibraryPackage[], prepared: readonly ReturnType<typeof supportPackages>[],
  sources: readonly IndexEntry[], meter: SourceSemanticReadBudget): void {
  meter.charge(prepared.length, prepared.length * 8, "library source-only candidates");
  const roots = new Set<string>();
  for (const { located } of prepared) {
    if (located === undefined || located.entry.target.kind !== "source_evidence") continue;
    meter.retain(located.entry.target, "library source-only source identity");
    const root = sourceGoldRootIdentity(located.entry.target), span = located.entry.target.span;
    meter.charge(1, 64 + root.length * 2, "library source-only root enumeration");
    if (roots.has(root) || span === undefined) continue;
    roots.add(root);
    const admitted = sources[located.access_position];
    if (admitted?.target.kind !== "source_evidence") continue;
    meter.charge(1, 1024, "library source-only package references");
    // Reconstruct from the admitted tuple/hypothesis, never from a proof representative.
    const source = sourceSemanticLibrarySourceEntry({ workspaceId: admitted.target.workspace_id,
      root_id: admitted.target.root_id, source_version: admitted.target.source_version,
      content_digest: admitted.target.content_digest, evidence_object_id: admitted.target.evidence_object_id,
      hypothesis_id: admitted.hypothesis_id });
    const entry = spanEntry(source, span.content_start, span.content_end, span.content_complete);
    meter.charge(1, 8, "library source-only insertion");
    packages.push({ entry, entries: [entry], explanations: [], proofs: [], preview: located.preview,
      access_position: located.access_position, payload_support: "envelope_budget", source_disclosure: located.source_disclosure });
  }
}

function supportPackages(position: number, source: string, sourceBytes: number, branches: readonly LibraryExecutedSupport[],
  meter: SourceSemanticReadBudget, source_disclosure: SourceSemanticLibraryPackage["source_disclosure"]): {
    packages: SourceSemanticLibraryPackage[]; reason: NonNullable<SourceSemanticLibrarySlotQualifier["payload_support"]>;
    located?: SourceSemanticLibraryPackage;
  } {
  const packages: SourceSemanticLibraryPackage[] = [], available: LibraryExecutedSupport[] = [];
  let reason: NonNullable<SourceSemanticLibrarySlotQualifier["payload_support"]> = "not_applicable";
  let start = Infinity, end = 0, exact = branches.length > 0;
  try {
    for (const row of branches) {
      const window = sourceSemanticSupportWindow({ source, interpretation: row.proof.interpretation,
        dependency_ids: row.dependencies, max_bytes: DISPLAY_BYTES, meter });
      if (window.status !== "available") {
        exact = false;
        reason = window.reason;
        if (reason === "resource_budget") return { packages, reason };
        continue;
      }
      exact &&= window.kind === "support_window";
      const chunk = hydrate(meter, source, window.start_offset, window.end_offset - window.start_offset);
      if (chunk.status !== "chunk" || chunk.end_offset !== window.end_offset) { exact = false; reason = "location_missing"; continue; }
      packages.push(proofPackage(position, window.start_offset === 0 && window.end_offset === sourceBytes, [row],
        { text: chunk.text, start_offset: window.start_offset, end_offset: window.end_offset }, meter, source_disclosure));
      available.push(row);
      start = Math.min(start, window.start_offset); end = Math.max(end, window.end_offset);
    }
    // Baseline packages precede optional pair search so it cannot spend their reservation work.
    if (available.length > 1 && end - start <= DISPLAY_BYTES) {
      const chunk = hydrate(meter, source, start, end - start);
      if (chunk.status === "chunk" && chunk.end_offset === end) {
        packages.unshift(proofPackage(position, start === 0 && end === sourceBytes, available,
          { text: chunk.text, start_offset: start, end_offset: end }, meter, source_disclosure));
      } else exact = false;
    }
    // A single exact branch also qualifies. For multiple branches packages[0] is the hydrated hull.
    const located = exact && end - start <= DISPLAY_BYTES ? packages[0] : undefined;
    return { packages, reason: packages.length > 0 ? "envelope_budget" : reason, located };
  } catch (error) {
    if (!(error instanceof SourceSemanticResourceExhausted)) throw error;
    return { packages, reason: "resource_budget" };
  }
}

/** Optional same-root alternatives reuse complete baseline source windows, after page reservation. */
export function* prepareLibraryPackagePairs(candidates: readonly SourceSemanticLibraryPackage[],
  page: readonly SourceSemanticLibraryPackage[], meter: SourceSemanticReadBudget): Generator<SourceSemanticLibraryPackage> {
  const root = (row: SourceSemanticLibraryPackage): string | undefined => {
    if (row.entry.target.kind !== "source_evidence") return undefined;
    meter.retain(row.entry.target, "library pair source identity");
    return sourceGoldRootIdentity(row.entry.target);
  };
  const pairs = enumerateSourceRecallPairs({ count: candidates.length, selectedCount: page.length, meter,
    selectedRoot: position => root(page[position]!), selectedSupportCount: position => page[position]!.proofs.length,
    root: member => root(candidates[member]!), supportCount: member => candidates[member]!.proofs.length,
    hasExtent: member => { const target = candidates[member]!.entry.target; return target.kind === "source_evidence" && target.span !== undefined; },
    belongsTo: (member, union) => candidates[union]!.proofs.includes(candidates[member]!.proofs[0]!),
    inputs: member => {
      const proof = candidates[member]!.proofs[0]!, bindings = proof.binding_results ?? [];
      meter.retain(proof.query, "library pair query support");
      const count = proof.query.alternatives.reduce((sum, alternative) => sum + (alternative.evidence_inputs?.length ?? 0), 0);
      meter.charge((bindings.length + 1) * (count + 1), count * 128, "library pair query support");
      return new Set(projectSourceSemanticQuerySupport(proof.query, bindings).evidence_inputs
        .filter(row => row.status === "supported").map(row => `${row.alternative}:${row.input}`));
    }
  });
  for (const selected of pairs) {
    const union = candidates[selected.union]!;
    if (union.entry.target.kind !== "source_evidence" || union.entry.target.span === undefined) {
      throw new CoreError("OBLIGATION_VIOLATION", "selected pair has no complete source extent");
    }
    const span = union.entry.target.span;
    const branches = [candidates[selected.left]!, candidates[selected.right]!].map(row => ({ proof: row.proofs[0]!, group: row }));
    yield proofPackage(union.access_position, span.content_complete, branches,
      { text: union.preview, start_offset: span.content_start, end_offset: span.content_end }, meter, union.source_disclosure);
  }
}

function proofPackage(position: number, sourceComplete: boolean, branches: readonly Pick<LibraryExecutedSupport, "proof" | "group">[],
  window: { text: string; start_offset: number; end_offset: number }, meter: SourceSemanticReadBudget,
  source_disclosure: SourceSemanticLibraryPackage["source_disclosure"]): SourceSemanticLibraryPackage {
  const entriesCount = branches.reduce((sum, row) => sum + row.group.entries.length, 0);
  const explanationsCount = branches.reduce((sum, row) => sum + row.group.explanations.length, 0);
  meter.charge(branches.length + explanationsCount + entriesCount * Math.max(1, Math.ceil(Math.log2(entriesCount))),
    512 + (branches.length * 4 + entriesCount * 2 + explanationsCount) * 8, "library proof package references");
  const entries = branches.flatMap(row => row.group.entries);
  const representative = [...entries].sort((a, b) => a.hypothesis_id.localeCompare(b.hypothesis_id) || a.output_binding.localeCompare(b.output_binding))[0]!;
  return {
    entry: spanEntry(representative, window.start_offset, window.end_offset, sourceComplete), entries,
    explanations: branches.flatMap(row => row.group.explanations), proofs: branches.map(row => row.proof),
    preview: window.text, access_position: position, payload_support: "available", source_disclosure
  };
}

function spanEntry(entry: IndexEntry, start: number, end: number, complete: boolean): IndexEntry {
  if (entry.target.kind !== "source_evidence") return entry;
  return { ...entry, target: { ...entry.target, span: { content_start: start, content_end: end,
    retained_extent: "body", content_complete: complete, original_complete: false } } };
}
function hydrate(meter: SourceSemanticReadBudget, source: string, offset: number, bytes: number) {
  meter.charge(source.length * 3, Buffer.byteLength(source) * 3 + bytes * 2, "library source window encoding");
  return hydrateUtf8Chunk(source, { offset, byteLimit: bytes });
}
function readSource(runtime: SourceSemanticReadRuntime, payload: SourceSemanticWorkerPayload,
  authorized: readonly string[] | null, meter: SourceSemanticReadBudget, entry: IndexEntry): { text: string; bytes: number;
    record: FieldSourceRecordRow } | undefined {
  if (entry.target.kind !== "source_evidence") return undefined;
  meter.observer?.event("source_read_attempt", meter.phase, () => ({ purpose: "package_hydration", record_id: entry.target.kind === "source_evidence" ? entry.target.root_id : null,
    start: 0, requested_end: DISPLAY_BYTES }));
  meter.reserve(5, RETAINED_SOURCE_READ_RESERVATION, "library raw prefix");
  const repo = new SqliteFieldSourceRecordRepo(runtime.database, fieldContractSha256);
  const stored = repo.findByIdBounded(payload.workspace_id, entry.target.root_id, DISPLAY_BYTES, 0,
    { workLimit: meter.work, nativeByteLimit: meter.bytes });
  meter.read(5 + (stored?.dependencyWork ?? 0), stored === null ? 0 : stored.nativeBytes + stored.metadataBytes);
  meter.observer?.event("source_read", meter.phase, () => ({ purpose: "package_hydration", record_id: entry.target.kind === "source_evidence" ? entry.target.root_id : null,
    start: 0, end: Buffer.byteLength(stored?.record?.source_body ?? ""), body_bytes: stored?.bodyBytes ?? null,
    native_bytes: stored === null ? 0 : stored.nativeBytes + stored.metadataBytes, resource_limited: stored?.resourceLimited ?? false }));
  if (stored?.resourceLimited) throw new SourceSemanticResourceExhausted("library source dependencies");
  const record = stored?.record;
  if (stored === null || record == null || record.source_body === null || record.record_id !== entry.target.root_id
    || record.source_version !== entry.target.source_version || record.content_digest !== entry.target.content_digest) return undefined;
  authorizeSemanticScope(record.scope_class, authorized);
  return { text: record.source_body, bytes: stored.bodyBytes, record };
}
