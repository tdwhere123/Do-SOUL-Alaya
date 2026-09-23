import { existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { AlayaError, canonicalJson } from "@do-soul/alaya-protocol";
import { parseSourceSemanticRequest } from "@do-soul/alaya-soul";
import { censusCompleteSourceRecords } from "./census.js";
import { listRetainedSourceSemanticKeys, parseSourcePublicationAssociations, type SourcePublicationAssociation,
  type SourcePublicationPopulation } from "./publish.js";
import { inspectCachedSourceSemantic } from "../../extraction/cache/source-semantic-artifact.js";
import { prepareSourceSemanticBatchLine } from "../../extraction/fill/batch/source-semantic-interpretation.js";
import { readBoundedCanonicalUtf8Artifact } from "../../extraction/cache-audit/bounded-artifact-reader.js";
import { chainIdentity, writeChainArtifact, writeChainJson } from "../../semantic-chain/contract.js";
import { EXTRACTION_OPEN_SEMANTICS_GENERATION, sourceSemanticArtifactPreparations,
  parseExtractionOpenSemanticsGeneration, type ExtractionOpenSemanticsGeneration } from "../../extraction/request-artifact.js";

const LineSchema = z.object({ key: z.string(), unitKeys: z.array(z.string()), requestSha256: z.string(),
  systemPrompt: z.string(), userPrompt: z.string() }).strict();
export type SourceAssociationCacheOwner = Readonly<{ cacheRoot: string; retainedPreparationPath: string }>;
type RetainedLine = z.infer<typeof LineSchema>;
type RetainedOwner = Readonly<{ cacheRoot: string; digest: string; plannedRequests: readonly RetainedLine[] }>;

/** Original selected requests allocate keys to roots; cache presence never selects an alternate owner. */
function readRetainedOwners(owners: readonly SourceAssociationCacheOwner[], population: Pick<SourcePublicationPopulation, "model" | "requestProfile">) {
  if (owners.length === 0) throw new AlayaError("VALIDATION", "association preparation requires owning cache roots");
  const roots = new Set<string>();
  const planned = new Map<string, Readonly<{ line: RetainedLine; cacheRoot: string }>>();
  const units = new Set<string>();
  const retained: RetainedOwner[] = [];
  for (const owner of owners) {
    if (!owner.cacheRoot || !owner.retainedPreparationPath) throw new AlayaError("VALIDATION", "association owner requires root and retained preparation");
    const cacheRoot = resolve(owner.cacheRoot);
    const physicalRoot = existsSync(cacheRoot) ? realpathSync(cacheRoot) : cacheRoot;
    if (roots.has(physicalRoot)) throw new AlayaError("CONFLICT", "association owner repeats a resolved cache root");
    roots.add(physicalRoot);
    const raw = readBoundedCanonicalUtf8Artifact({ path: owner.retainedPreparationPath,
      maxBytes: 32 * 1024 * 1024, label: "retained source preflight" });
    const artifact = JSON.parse(raw);
    const lines = z.object({ contract: z.literal("extraction-batch-preflight-v2"),
      planned_requests: z.array(LineSchema) }).passthrough().parse(artifact).planned_requests;
    for (const line of lines) {
      const request = parseSourceSemanticRequest(JSON.parse(line.userPrompt));
      const expected = prepareSourceSemanticBatchLine(request, line.unitKeys, population);
      if (canonicalJson(line) !== canonicalJson(expected)) {
        throw new AlayaError("CONFLICT", "retained source preflight has foreign or duplicate request identity");
      }
      if (planned.has(line.key)) throw new AlayaError("CONFLICT", "retained source preparations repeat an owning request key");
      for (const unit of line.unitKeys) {
        if (units.has(unit)) throw new AlayaError("CONFLICT", "retained source preparations repeat a source assignment");
        units.add(unit);
      }
      planned.set(line.key, { line, cacheRoot });
    }
    retained.push({ cacheRoot, digest: chainIdentity(artifact), plannedRequests: lines });
  }
  return { retained, planned };
}

/** Prepare one original question/window, regardless of which earlier window owns each key. */
export async function prepareSourcePublicationAssociations(
  population: Omit<SourcePublicationPopulation, "cacheRoots" | "publicationAssociations"> & Readonly<{
    openSemantics?: ExtractionOpenSemanticsGeneration;
  }>,
  owners: readonly SourceAssociationCacheOwner[], outputPath: string
) {
  const generation = parseExtractionOpenSemanticsGeneration(population.openSemantics ?? EXTRACTION_OPEN_SEMANTICS_GENERATION);
  const { retained, planned } = readRetainedOwners(owners, population);
  const physical = new Map<string, string>();
  for (const owner of retained) {
    const keys = listRetainedSourceSemanticKeys(owner.cacheRoot);
    if (new Set(keys).size !== keys.length) throw new AlayaError("CONFLICT", "retained source cache repeats an owning request key");
    for (const key of keys) {
      if (physical.has(key)) throw new AlayaError("CONFLICT", "request key occurs in multiple physical cache roots");
      physical.set(key, owner.cacheRoot);
    }
  }
  const census = await censusCompleteSourceRecords({ population: population.name,
    dataDir: population.dataDir, pinnedMetaRoot: population.pinnedMetaRoot,
    ...(population.questionWindow === undefined ? {} : { questionWindow: population.questionWindow }) });
  const expected = new Map<string, { requestDigest: string; sources: typeof census.records[number][] }>();
  const unsupported = new Map<string, Extract<SourcePublicationAssociation, { status: "unsupported_source" }>>();
  for (const source of census.records) {
    const preparations = sourceSemanticArtifactPreparations(source.content_bytes, "complete-source", generation);
    if (preparations.length !== 1) throw new AlayaError("CONFLICT", "complete source association requires exactly one host preparation");
    const prepared = preparations[0]!;
    if (prepared.status === "unsupported_source") {
      unsupported.set(source.source_id, { source_id: source.source_id, source_version: source.source_version,
        content_digest: source.content_digest, corpus_digest: source.corpus_digest,
        ...prepared.disposition, provider_attempts: 0 });
      continue;
    }
    const line = prepareSourceSemanticBatchLine(prepared.semantic, [], population);
    const match = expected.get(line.key) ?? { requestDigest: line.requestSha256, sources: [] };
    if (match.requestDigest !== line.requestSha256) throw new AlayaError("CONFLICT", "current source requests have ambiguous owning key");
    match.sources.push(source);
    expected.set(line.key, match);
  }
  for (const [key, current] of expected) {
    const retainedLine = planned.get(key)?.line;
    if (retainedLine !== undefined && retainedLine.requestSha256 !== current.requestDigest) {
      throw new AlayaError("CONFLICT", "retained source request conflicts with the current key identity");
    }
  }
  const associations: SourcePublicationAssociation[] = [...unsupported.values()];
  const artifacts: { key: string; cache_root: string; status: "associated" | "invalid" | "unbound";
    sources: string[]; reason?: "foreign_root" | "unproven_retained_request" }[] = [];
  const reasons = new Map(census.records.filter((source) => !unsupported.has(source.source_id))
    .map((source) => [source.source_id, "missing_current_artifact"]));
  for (const [key, cacheRoot] of physical) {
    const native = inspectCachedSourceSemantic(cacheRoot, key, population.model, population.requestProfile);
    const owner = planned.get(key);
    const current = expected.get(key);
    const belongsHere = owner?.cacheRoot === cacheRoot;
    if (native.status !== "hit") {
      artifacts.push({ key, cache_root: cacheRoot, status: "invalid", sources: [],
        ...(!belongsHere && owner !== undefined ? { reason: "foreign_root" as const } : {}) });
      if (belongsHere) for (const source of current?.sources ?? []) reasons.set(source.source_id, "invalid_current_artifact");
      continue;
    }
    if (!belongsHere || current === undefined || native.requestDigest !== owner.line.requestSha256 ||
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
  const result = { contract: "source-publication-association-preparation-v2", provenance: "new_host_publication_association",
    population: population.name, dataset_sha256: census.dataset_sha256,
    retained_preparations: retained.map((owner) => ({ cache_root: owner.cacheRoot,
      retained_preparation_digest: owner.digest, selected_request_keys: owner.plannedRequests.length })),
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
