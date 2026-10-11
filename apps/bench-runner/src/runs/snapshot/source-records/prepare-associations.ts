import { existsSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { AlayaError, canonicalJson } from "@do-soul/alaya-protocol";
import { parseSourceSemanticRequest } from "@do-soul/alaya-soul";
import { isCompleteSemanticFinish } from "../../compile-seed/http/semantic-provider-http.js";
import { censusCompleteSourceRecords, censusNativeSourceRecords, type SourceCensus } from "./census.js";
import { listRetainedSourceSemanticKeys, parseSourcePublicationAssociations, type SourcePublicationAssociation,
  type SourcePublicationPopulation } from "./publish.js";
import { inspectCachedSourceSemantic } from "../../extraction/cache/source-semantic-artifact.js";
import { bindProviderRawAttempt, readSingleSourceRawAttempt } from "../../extraction/fill/provider-raw-attempt.js";
import { readCompletePhysicalSourceResponseForRequest,
  readCompleteRetainedSourceResponse } from "../../extraction/cache/source-interactive-binding.js";
import { nativeSourceRequestInventory } from "../../extraction/fill/source-request-workset.js";
import { parseSourceSemanticInteractivePreflight } from "../../extraction/fill/source-semantic-interactive-preflight.js";
import { parseRetainedBatchPreflight } from "../../extraction/fill/batch-preflight.js";
import { sourceSemanticRequestWireDigest } from "../../extraction/fill/source-semantic-interactive-request.js";
import { readBoundedCanonicalUtf8Artifact } from "../../extraction/cache-audit/bounded-artifact-reader.js";
import { chainIdentity, writeChainArtifact, writeChainJson } from "../../semantic-chain/contract.js";
import { EXTRACTION_OPEN_SEMANTICS_GENERATION, sourceSemanticArtifactPreparations,
  parseExtractionOpenSemanticsGeneration, parseSourceSemanticRequestLine, prepareSourceSemanticRequestLine,
  type SourceRequestLine, type ExtractionOpenSemanticsGeneration } from "../../extraction/request-artifact.js";

export type SourceAssociationCacheOwner = Readonly<{ cacheRoot: string; retainedPreparationPath: string;
  physicalPreparationPath?: string }>;
type SourceAssociationPopulation = Omit<SourcePublicationPopulation, "cacheRoots" | "publicationAssociations"> & Readonly<{
  activeRevision?: Readonly<{ source_id: string; source_version: string;
    key: string; generation: ExtractionOpenSemanticsGeneration }> & (
      Readonly<{ kind: "native"; record_id: string }> |
      Readonly<{ kind: "natural"; content_digest: string }>);
}>;
type RetainedOwner = Readonly<{ cacheRoot: string; digest: string;
  contract: "extraction-batch-preflight-v2" | "source-semantic-interactive-preflight-v3";
  selectedRequestCount: number; physicalPreparationDigest?: string }>;

function matchesRetainedInteractiveAttempt(input: { cacheRoot: string; key: string; model: string;
  requestProfile: string; wireDigest: string; rawJsonSha256: string }): boolean {
  const attempt = readSingleSourceRawAttempt(input.cacheRoot, input.key);
  if (attempt === undefined) return false;
  const raw = bindProviderRawAttempt(attempt, { cacheKey: input.key, model: input.model,
    requestProfile: input.requestProfile, requestDigest: input.wireDigest, kind: "source_semantic" });
  return raw.transport_failure === undefined && isCompleteSemanticFinish(input.requestProfile, raw.finish_reason) &&
    raw.decoded_text_digest === input.rawJsonSha256;
}

/** Original selected requests allocate keys to roots; cache presence never selects an alternate owner. */
export function readRetainedSourcePublicationOwners(owners: readonly SourceAssociationCacheOwner[],
  population: Pick<SourcePublicationPopulation, "model" | "requestProfile">,
  generation: ExtractionOpenSemanticsGeneration, datasetSha256: string) {
  if (owners.length === 0) throw new AlayaError("VALIDATION", "association preparation requires owning cache roots");
  const roots = new Set<string>();
  const owned = new Map<string, Readonly<{ line: SourceRequestLine; cacheRoot: string; wireDigest?: string;
    generation?: ExtractionOpenSemanticsGeneration;
    preflight?: ReturnType<typeof parseSourceSemanticInteractivePreflight>;
    physicalPreflight?: ReturnType<typeof parseSourceSemanticInteractivePreflight>;
    physicalLine?: SourceRequestLine }>>();
  const unitOwners = new Map<string, string[]>();
  const retained: RetainedOwner[] = [];
  for (const owner of owners) {
    if (!owner.cacheRoot || !owner.retainedPreparationPath) throw new AlayaError("VALIDATION", "association owner requires root and retained preparation");
    const cacheRoot = resolve(owner.cacheRoot);
    const physicalRoot = existsSync(cacheRoot) ? realpathSync(cacheRoot) : cacheRoot;
    if (roots.has(physicalRoot)) throw new AlayaError("CONFLICT", "association owner repeats a resolved cache root");
    roots.add(physicalRoot);
    const raw = readBoundedCanonicalUtf8Artifact({ path: owner.retainedPreparationPath,
      maxBytes: 32 * 1024 * 1024, label: "retained source preflight" });
    const artifact: unknown = JSON.parse(raw);
    const contract = z.object({ contract: z.string() }).passthrough().parse(artifact).contract;
    let preparationContract: RetainedOwner["contract"];
    let selectedRequestCount: number;
    let requests: readonly Readonly<{ line: SourceRequestLine; wireDigest?: string;
      generation?: ExtractionOpenSemanticsGeneration;
      preflight?: ReturnType<typeof parseSourceSemanticInteractivePreflight>;
      physicalPreflight?: ReturnType<typeof parseSourceSemanticInteractivePreflight>;
      physicalLine?: SourceRequestLine }>[];
    let physicalPreparationDigest: string | undefined;
    if (contract === "source-semantic-interactive-preflight-v3") {
      const report = parseSourceSemanticInteractivePreflight(artifact);
      const physical = owner.physicalPreparationPath === undefined ? undefined :
        parseSourceSemanticInteractivePreflight(JSON.parse(readBoundedCanonicalUtf8Artifact({
          path: owner.physicalPreparationPath, maxBytes: 32 * 1024 * 1024,
          label: "original physical source preflight" })));
      if (physical !== undefined && (physical.config.model !== report.config.model ||
          physical.config.requestProfile !== report.config.requestProfile ||
          physical.max_output_tokens !== report.max_output_tokens)) {
        throw new AlayaError("CONFLICT", "current source owner changed its physical model, profile or output cap");
      }
      physicalPreparationDigest = physical === undefined ? undefined : chainIdentity(physical);
      preparationContract = report.contract;
      selectedRequestCount = report.selected_requests;
      if (report.config.model !== population.model || report.config.requestProfile !== population.requestProfile ||
          report.dataset_revision !== datasetSha256) {
        throw new AlayaError("CONFLICT", "retained interactive source preparation differs from the current source population");
      }
      const wireByKey = new Map(report.planned_requests.map(row => [row.key, row.request_digest]));
      requests = report.ready_requests.map(line => {
        const physicalLine = physical?.ready_requests.find(row => row.key === line.key);
        if (physical !== undefined) readCompletePhysicalSourceResponseForRequest({ cacheRoot,
          physicalPreflight: physical, currentPreflight: report, currentLine: line });
        const noAssertions = parseSourceSemanticRequest(JSON.parse(line.userPrompt))
          .source_request.source_assertions.length === 0;
        return { line, preflight: report,
          generation: parseExtractionOpenSemanticsGeneration(report.config.openSemantics),
          ...(physical === undefined ? {} : { physicalPreflight: physical, physicalLine: physicalLine! }),
          ...(!noAssertions ? { wireDigest: wireByKey.get(line.key) ?? sourceSemanticRequestWireDigest({ ...report.config,
          openSemantics: parseExtractionOpenSemanticsGeneration(report.config.openSemantics) }, line, report.max_output_tokens) } : {}) };
      });
    } else {
      if (owner.physicalPreparationPath !== undefined) {
        throw new AlayaError("CONFLICT", "physical source owner requires an interactive current preflight");
      }
      const report = parseRetainedBatchPreflight(artifact);
      preparationContract = report.contract;
      selectedRequestCount = report.planned_requests.length;
      if (report.config.model !== population.model || report.config.requestProfile !== population.requestProfile ||
          report.dataset_revision !== datasetSha256) {
        throw new AlayaError("CONFLICT", "retained Batch source preparation differs from the current source population");
      }
      requests = report.planned_requests.map(line => ({ line }));
    }
    for (const { line, wireDigest, preflight, physicalPreflight, physicalLine, generation: ownerGeneration } of requests) {
      try { parseSourceSemanticRequestLine(line, population); }
      catch (cause) { throw new AlayaError("CONFLICT", "retained source preflight has foreign or duplicate request identity", { cause }); }
      if (owned.has(line.key)) throw new AlayaError("CONFLICT", "retained source preparations repeat an owning request key");
      for (const unit of line.unitKeys) {
        const keys = unitOwners.get(unit) ?? [];
        keys.push(line.key); unitOwners.set(unit, keys);
      }
      owned.set(line.key, { line, cacheRoot, ...(ownerGeneration === undefined ? {} : { generation: ownerGeneration }),
        ...(wireDigest === undefined ? {} : { wireDigest }),
        ...(preflight === undefined ? {} : { preflight }),
        ...(physicalPreflight === undefined ? {} : { physicalPreflight, physicalLine }) });
    }
    retained.push({ cacheRoot, digest: chainIdentity(artifact), contract: preparationContract,
      selectedRequestCount,
      ...(physicalPreparationDigest === undefined ? {} : { physicalPreparationDigest }) });
  }
  for (const keys of unitOwners.values()) {
    if (keys.length === 1) continue;
    if (keys.length !== 2) throw new AlayaError("CONFLICT", "retained source assignment has unrelated overlap");
    const pair = keys.map(key => owned.get(key)!);
    const child = pair.find(item => parseSourceSemanticRequest(JSON.parse(item.line.userPrompt))
      .source_request.revision !== undefined);
    const parent = pair.find(item => item !== child);
    const revision = child === undefined ? undefined : parseSourceSemanticRequest(JSON.parse(child.line.userPrompt))
      .source_request.revision;
    if (child === undefined || parent === undefined || parent.preflight === undefined || revision === undefined ||
        revision.parent_request_json !== parent.line.userPrompt ||
        readCompleteRetainedSourceResponse({ cacheRoot: parent.cacheRoot,
          preflight: parent.physicalPreflight ?? parent.preflight,
          line: parent.physicalLine ?? parent.line }) !== revision.previous_response) {
      throw new AlayaError("CONFLICT", "retained source overlap lacks a complete immediate parent");
    }
  }
  return { retained, owned };
}

/** A current census, including each native occurrence, owns association eligibility. */
function currentSourceAssociationExpectations(census: SourceCensus, generation: ExtractionOpenSemanticsGeneration,
  population: SourceAssociationPopulation, owned: ReturnType<typeof readRetainedSourcePublicationOwners>["owned"]) {
  const expected = new Map<string, { requestDigest: string; sources: typeof census.records[number][] }>();
  const expectedGeneration = new Map<string, ExtractionOpenSemanticsGeneration>();
  const unsupported = new Map<string, Extract<SourcePublicationAssociation, { status: "unsupported_source" }>>();
  const revision = population.activeRevision;
  if (revision !== undefined && (revision.kind === "native") !== (population.nativeSnapshotPath !== undefined)) {
    throw new AlayaError("VALIDATION", "source-local H revision population differs from its source tuple");
  }
  let selectedCount = 0;
  for (const source of census.records) {
    const selected = revision !== undefined && source.source_id === revision.source_id &&
      source.source_version === revision.source_version && (revision.kind === "native"
        ? source.native_record_id === revision.record_id : source.content_digest === revision.content_digest);
    if (selected) selectedCount++;
    const activeGeneration = selected ? revision!.generation : generation;
    const preparations = sourceSemanticArtifactPreparations(source.content_bytes, "complete-source", activeGeneration,
      source.attribution_context, source.source_role);
    if (preparations.length !== 1) throw new AlayaError("CONFLICT", "complete source association requires exactly one host preparation");
    const prepared = preparations[0]!;
    if (prepared.status === "unsupported_source") {
      unsupported.set(source.source_id, { source_id: source.source_id, source_version: source.source_version,
        content_digest: source.content_digest, corpus_digest: source.corpus_digest,
        ...prepared.disposition, provider_attempts: 0 });
      continue;
    }
    const line = prepareSourceSemanticRequestLine(prepared.semantic, [], population);
    if (selected && line.key !== revision!.key) throw new AlayaError("CONFLICT", "selected H child differs from its exact source tuple");
    const match = expected.get(line.key) ?? { requestDigest: line.requestSha256, sources: [] };
    if (match.requestDigest !== line.requestSha256) throw new AlayaError("CONFLICT", "current source requests have ambiguous owning key");
    match.sources.push(source);
    expected.set(line.key, match);
    expectedGeneration.set(line.key, activeGeneration);
  }
  if (revision !== undefined && selectedCount !== 1) throw new AlayaError("CONFLICT", "H child must select one current source tuple");
  const inventories = new Map<string, ReturnType<typeof nativeSourceRequestInventory>>();
  for (const [key, current] of expected) {
    const retained = owned.get(key), retainedLine = retained?.line;
    if (retainedLine !== undefined && retainedLine.requestSha256 !== current.requestDigest) {
      throw new AlayaError("CONFLICT", "retained source request conflicts with the current key identity");
    }
    if (population.nativeSnapshotPath !== undefined && retainedLine !== undefined) {
      const activeGeneration = expectedGeneration.get(key)!;
      if (retained?.generation === undefined || canonicalJson(retained.generation) !== canonicalJson(activeGeneration)) {
        throw new AlayaError("CONFLICT", "retained source request changed its own generation");
      }
      const identity = canonicalJson(activeGeneration);
      let inventory = inventories.get(identity);
      if (inventory === undefined) {
        inventory = nativeSourceRequestInventory(census.records, census.dataset_sha256, {
          model: population.model, requestProfile: population.requestProfile,
          sourcePacking: "complete-source", openSemantics: activeGeneration });
        inventories.set(identity, inventory);
      }
      const physicalLine = inventory.requests.find(row => row.line.key === key)?.line;
      if (physicalLine === undefined || canonicalJson(physicalLine) !== canonicalJson(retainedLine)) {
        throw new AlayaError("CONFLICT", "retained native request changed its exact source occurrence assignments");
      }
    }
  }
  return { expected, unsupported };
}

/** Prepare one original question/window, regardless of which earlier window owns each key. */
export async function prepareSourcePublicationAssociations(
  population: SourceAssociationPopulation,
  owners: readonly SourceAssociationCacheOwner[], outputPath: string
) {
  const generation = parseExtractionOpenSemanticsGeneration(population.openSemantics ?? EXTRACTION_OPEN_SEMANTICS_GENERATION);
  let census: SourceCensus;
  if (population.nativeSnapshotPath !== undefined) {
    census = censusNativeSourceRecords({ population: population.name, snapshotPath: population.nativeSnapshotPath });
  } else {
    const { dataDir, pinnedMetaRoot } = population;
    if (dataDir === undefined || pinnedMetaRoot === undefined) {
      throw new AlayaError("VALIDATION", "LongMemEval association requires pinned dataset paths");
    }
    census = await censusCompleteSourceRecords({ population: population.name,
      dataDir, pinnedMetaRoot,
      ...(population.questionWindow === undefined ? {} : { questionWindow: population.questionWindow }) });
  }
  const { retained, owned } = readRetainedSourcePublicationOwners(owners, population, generation, census.dataset_sha256);
  const physical = new Map<string, string>();
  if (population.nativeSnapshotPath !== undefined) {
    // Exact retained key ownership bounds this scan; a current association may use
    // a separate original physical preflight for the same request.
    for (const key of owned.keys()) {
      for (const owner of retained) {
        if (!existsSync(join(owner.cacheRoot, key.slice(0, 2), `${key}.json`))) continue;
        if (physical.has(key)) throw new AlayaError("CONFLICT", "request key occurs in multiple physical cache roots");
        physical.set(key, owner.cacheRoot);
      }
    }
  } else {
    for (const owner of retained) {
      const keys = listRetainedSourceSemanticKeys(owner.cacheRoot);
      if (new Set(keys).size !== keys.length) throw new AlayaError("CONFLICT", "retained source cache repeats an owning request key");
      for (const key of keys) {
        if (physical.has(key)) throw new AlayaError("CONFLICT", "request key occurs in multiple physical cache roots");
        physical.set(key, owner.cacheRoot);
      }
    }
  }
  const { expected, unsupported } = currentSourceAssociationExpectations(census, generation, population, owned);
  const associations: SourcePublicationAssociation[] = [...unsupported.values()];
  const artifacts: { key: string; cache_root: string; status: "associated" | "invalid" | "unbound";
    sources: string[]; reason?: "foreign_root" | "unproven_retained_request" }[] = [];
  const reasons = new Map(census.records.filter((source) => !unsupported.has(source.source_id))
    .map((source) => [source.source_id, "missing_current_artifact"]));
  for (const [key, cacheRoot] of physical) {
    const native = inspectCachedSourceSemantic(cacheRoot, key, population.model, population.requestProfile);
    const owner = owned.get(key);
    const current = expected.get(key);
    const belongsHere = owner?.cacheRoot === cacheRoot;
    if (native.status !== "hit") {
      artifacts.push({ key, cache_root: cacheRoot, status: "invalid", sources: [],
        ...(!belongsHere && owner !== undefined ? { reason: "foreign_root" as const } : {}) });
      if (belongsHere) for (const source of current?.sources ?? []) reasons.set(source.source_id, "invalid_current_artifact");
      continue;
    }
    const rawMatchesPreparation = owner?.wireDigest === undefined || matchesRetainedInteractiveAttempt({
      cacheRoot, key, model: population.model, requestProfile: population.requestProfile,
      wireDigest: owner.wireDigest, rawJsonSha256: native.rawJsonSha256
    });
    if (!belongsHere || current === undefined || !rawMatchesPreparation || native.requestDigest !== owner.line.requestSha256 ||
        native.requestDigest !== current.requestDigest) {
      if (current !== undefined && owner === undefined) {
        for (const source of current.sources) reasons.set(source.source_id, "unproven_retained_request");
      } else if (belongsHere) {
        for (const source of current?.sources ?? []) reasons.set(source.source_id, "unproven_retained_request");
      }
      artifacts.push({ key, cache_root: cacheRoot, status: "unbound", sources: [],
        reason: !belongsHere && owner !== undefined ? "foreign_root" : "unproven_retained_request" });
      continue;
    }
    artifacts.push({ key, cache_root: cacheRoot, status: "associated", sources: current.sources.map((source) => source.source_id) });
    for (const source of current.sources) {
      reasons.delete(source.source_id);
      associations.push({ source_id: source.source_id, source_version: source.source_version,
        generation_key: key, request_digest: native.requestDigest });
    }
  }
  const wrapper = { contract: "source-publication-associations-v2", publicationAssociations: associations };
  parseSourcePublicationAssociations(wrapper);
  const result = { contract: "source-publication-association-preparation-v3", provenance: "new_host_publication_association",
    population: population.name, dataset_sha256: census.dataset_sha256,
    retained_preparations: retained.map((owner) => ({ cache_root: owner.cacheRoot, preparation_contract: owner.contract,
      retained_preparation_digest: owner.digest, selected_request_keys: owner.selectedRequestCount,
      ...(owner.physicalPreparationDigest === undefined ? {} : {
        physical_preparation_digest: owner.physicalPreparationDigest }) })),
    source_occurrences: census.records.length, unsupported_source_occurrences: unsupported.size,
    ready_request_keys: expected.size, publicationAssociations: associations, artifacts,
    sources: census.records.map((source) => ({ source_id: source.source_id, source_version: source.source_version,
      status: unsupported.has(source.source_id) ? "unsupported_source" : reasons.has(source.source_id) ? "unbound" : "associated",
      ...(unsupported.has(source.source_id) ? { preparation: unsupported.get(source.source_id) } : {}),
      ...(reasons.has(source.source_id) ? { reason: reasons.get(source.source_id) } : {}) })) };
  writeChainArtifact(outputPath, result);
  writeChainJson(`${outputPath}.associations.json`, wrapper);
  return result;
}
