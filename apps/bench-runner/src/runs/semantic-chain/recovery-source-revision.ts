import { join, resolve } from "node:path";
import { AlayaError, SoulInterpretationResponseSchema, canonicalJson } from "@do-soul/alaya-protocol";
import { parseSourceSemanticRequest, prepareSourceSemanticRevision, sourceSemanticTransportUnits } from "@do-soul/alaya-soul";
import { readCompleteRetainedSourceResponse } from "../extraction/cache/source-interactive-binding.js";
import { parseSourceSemanticInteractivePreflight } from "../extraction/fill/source-semantic-interactive-preflight.js";
import { readBoundedCanonicalUtf8Artifact } from "../extraction/cache-audit/bounded-artifact-reader.js";
import { censusNativeSourceRecords } from "../snapshot/source-records/census.js";
import { nativeSourceOccurrenceId, nativeSourceRequestInventory } from "../extraction/fill/source-request-workset.js";
import { parseExtractionOpenSemanticsGeneration } from "../extraction/request-artifact.js";
import { chainIdentity, readChainArtifact, writeChainArtifact, writeChainJson } from "./contract.js";
import { admitInitialQualified } from "./recovery-publication.js";
import { reserveRecoveryRead, reserveRecoveryHostEffect } from "./recovery-allowance.js";

/** The unchanged complete source and its physical parent define exactly one child H request. */
export function prepareRecoverySourceRevision(rootInput: string) {
  const root = resolve(rootInput);
  reserveRecoveryRead(root, "prepare selected H revision");
  const { window, settled } = admitInitialQualified(root);
  const read = readChainArtifact(join(root, "recovery-source-read.json")) as {
    source_id?: string; source_version?: string; record_id?: string; source_content_digest?: string;
    response?: unknown; identity?: string } | undefined;
  const source = window.window.find(row => row.source_id === read?.source_id &&
    row.source_version === read?.source_version && row.record_id === read?.record_id &&
    row.content_digest === read?.source_content_digest);
  if (source === undefined || read?.response === undefined) throw new AlayaError("CONFLICT", "H revision lacks current fresh source read");
  const prepared = SoulInterpretationResponseSchema.parse(read.response);
  if (prepared.operation !== "prepare_source" || prepared.catalog === undefined ||
      prepared.source_id !== source.source_id || prepared.source_version !== source.source_version ||
      prepared.content_digest !== source.content_digest) {
    throw new AlayaError("CONFLICT", "H revision source catalog changed");
  }
  const preflight = parseSourceSemanticInteractivePreflight(JSON.parse(readBoundedCanonicalUtf8Artifact({
    path: settled.source_preflight_path, maxBytes: 32 * 1024 * 1024, label: "H parent preflight" })));
  const parentLine = preflight.ready_requests.find(line => line.key === source.initial_key);
  if (parentLine === undefined) throw new AlayaError("CONFLICT", "H revision lacks selected physical parent key");
  const parent = parseSourceSemanticRequest(JSON.parse(parentLine.userPrompt));
  const catalogRows = prepared.catalog.assertions.map(row => ({ assertion_id: row.assertion_id,
    text: row.segments.map(part => part.text).join("") }));
  if (prepared.catalog.source_digest !== parent.source_digest ||
      canonicalJson(catalogRows) !== canonicalJson(parent.source_request.source_assertions.map(row => ({
        assertion_id: row.assertion_id, text: row.text })))) {
    throw new AlayaError("CONFLICT", "fresh native source catalog differs from unchanged H request");
  }
  const physical = readCompleteRetainedSourceResponse({ cacheRoot: settled.source_cache_root,
    preflight, line: parentLine });
  const review = [] as { assertion_ids: number[]; comment: string }[];
  for (let offset = 0; offset < catalogRows.length; offset += 8) review.push({
    assertion_ids: catalogRows.slice(offset, offset + 8).map(row => row.assertion_id),
    comment: "Verify all source assertions and their local relation roles against the unchanged complete source; include supported content omitted by the prior response."
  });
  const revision = prepareSourceSemanticRevision(parent, physical, review, { responseCompletion: "complete" });
  const generation = parseExtractionOpenSemanticsGeneration({ ...parseExtractionOpenSemanticsGeneration(window.open_semantics),
    revisions: [revision] });
  const census = censusNativeSourceRecords({ population: window.population, snapshotPath: window.native_snapshot_path });
  const occurrence = census.records.find(row => row.source_id === source.source_id &&
    row.source_version === source.source_version && row.native_record_id === source.record_id);
  if (occurrence === undefined) throw new AlayaError("CONFLICT", "H revision occurrence is no longer in native census");
  const occurrenceId = nativeSourceOccurrenceId(occurrence);
  const inventory = nativeSourceRequestInventory(census.records, census.dataset_sha256, {
    model: window.source_model, requestProfile: window.source_request_profile,
    sourcePacking: "complete-source", openSemantics: generation });
  const occurrenceUnits = sourceSemanticTransportUnits(occurrence.content_bytes, [occurrenceId], census.dataset_sha256);
  const child = inventory.requests.find(row => occurrenceUnits.every(unit =>
    row.units.some(candidate => candidate.binding.occurrenceIdentity === unit.binding.occurrenceIdentity)));
  if (child === undefined || child.line.key === parentLine.key ||
      parseSourceSemanticRequest(JSON.parse(child.line.userPrompt)).source_request.revision?.parent_request_sha256 !==
        revision.parent_request_sha256) {
    throw new AlayaError("CONFLICT", "H child request did not bind the exact selected source parent");
  }
  const generationPath = join(root, "source-revision-generation.json");
  reserveRecoveryHostEffect(root, "H-revision-workset", chainIdentity({ generation,
    selected: occurrenceId, child_key: child.line.key }),
    readChainArtifact(join(root, "source-revision.json")) !== undefined);
  writeChainJson(generationPath, generation);
  const result = { contract: "source-semantic-source-revision-v1", source_read_identity: read.identity,
    qualified_snapshot_identity: settled.publication_identity,
    source_id: source.source_id, source_version: source.source_version, record_id: source.record_id,
    parent_key: parentLine.key, child_key: child.line.key, selected_occurrence: occurrenceId,
    generation_path: generationPath, generation_identity: chainIdentity(generation),
    child_request_sha256: child.line.requestSha256, parent_response_sha256: revision.previous_response_sha256 };
  writeChainArtifact(join(root, "source-revision.json"), result);
  return result;
}
