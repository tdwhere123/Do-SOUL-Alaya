import { z } from "zod";
import { AlayaError, canonicalJson } from "@do-soul/alaya-protocol";
import { parseSourceSemanticRequest } from "@do-soul/alaya-soul";
import { censusCompleteSourceRecords } from "./census.js";
import { listRetainedSourceSemanticKeys, type SourcePublicationAssociation,
  type SourcePublicationPopulation } from "./publish.js";
import { inspectCachedSourceSemantic } from "../../extraction/cache/source-semantic-artifact.js";
import { prepareSourceSemanticBatchLine } from "../../extraction/fill/batch/source-semantic-interpretation.js";
import { readBoundedCanonicalUtf8Artifact } from "../../extraction/cache-audit/bounded-artifact-reader.js";
import { chainIdentity, writeChainArtifact, writeChainJson } from "../../semantic-chain/contract.js";
import { EXTRACTION_OPEN_SEMANTICS_GENERATION, sourceSemanticArtifactPreparations,
  parseExtractionOpenSemanticsGeneration, type ExtractionOpenSemanticsGeneration } from "../../extraction/request-artifact.js";

const LineSchema = z.object({ key: z.string(), unitKeys: z.array(z.string()), requestSha256: z.string(),
  systemPrompt: z.string(), userPrompt: z.string() }).strict();

/** New host associations only; neither bytes nor a model-cache key proves historical source origin. */
export async function prepareSourcePublicationAssociations(
  population: Omit<SourcePublicationPopulation, "cacheRoots"> & Readonly<{
    cacheRoot: string; openSemantics?: ExtractionOpenSemanticsGeneration;
  }>,
  retainedPreflightPath: string, outputPath: string
) {
  if (population.cacheRoot === undefined) throw new AlayaError("VALIDATION", "association preparation requires a retained cache");
  const generation = parseExtractionOpenSemanticsGeneration(population.openSemantics ?? EXTRACTION_OPEN_SEMANTICS_GENERATION);
  const census = await censusCompleteSourceRecords({ population: population.name,
    dataDir: population.dataDir, pinnedMetaRoot: population.pinnedMetaRoot,
    ...(population.questionWindow === undefined ? {} : { questionWindow: population.questionWindow }) });
  const raw = readBoundedCanonicalUtf8Artifact({ path: retainedPreflightPath, maxBytes: 32 * 1024 * 1024, label: "retained source preflight" });
  const lines = z.object({ contract: z.literal("extraction-batch-preflight-v2"),
    planned_requests: z.array(LineSchema) }).passthrough().parse(JSON.parse(raw)).planned_requests;
  const planned = new Map<string, z.infer<typeof LineSchema>>();
  for (const line of lines) {
    const request = parseSourceSemanticRequest(JSON.parse(line.userPrompt));
    const expected = prepareSourceSemanticBatchLine(request, line.unitKeys, {
      model: population.model, requestProfile: population.requestProfile
    });
    if (canonicalJson(line) !== canonicalJson(expected) || planned.has(line.key)) {
      throw new AlayaError("CONFLICT", "retained source preflight has foreign or duplicate request identity");
    }
    planned.set(line.key, line);
  }
  // These are new host associations, not claims about a retained line's historical unitKeys.
  // The census owns each occurrence; the extraction owner independently rebuilds its current request.
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
  const associations: SourcePublicationAssociation[] = [...unsupported.values()];
  const artifacts: { key: string; status: "associated" | "invalid" | "unbound"; sources: string[] }[] = [];
  const reasons = new Map(census.records.filter((source) => !unsupported.has(source.source_id))
    .map((source) => [source.source_id, "missing_current_artifact"]));
  const keys = listRetainedSourceSemanticKeys(population.cacheRoot);
  if (new Set(keys).size !== keys.length) throw new AlayaError("CONFLICT", "retained source cache repeats an owning request key");
  for (const key of keys) {
    const native = inspectCachedSourceSemantic(population.cacheRoot, key, population.model, population.requestProfile);
    const retained = planned.get(key);
    const current = expected.get(key);
    if (native.status !== "hit") {
      artifacts.push({ key, status: "invalid", sources: [] });
      for (const source of current?.sources ?? []) reasons.set(source.source_id, "invalid_current_artifact");
      continue;
    }
    if (current === undefined || retained === undefined || native.requestDigest !== retained.requestSha256 ||
        native.requestDigest !== current.requestDigest) {
      for (const source of current?.sources ?? []) reasons.set(source.source_id, "unproven_retained_request");
      artifacts.push({ key, status: "unbound", sources: [] }); continue;
    }
    artifacts.push({ key, status: "associated", sources: current.sources.map((source) => source.source_id) });
    for (const source of current.sources) {
      reasons.delete(source.source_id);
      associations.push({ source_id: source.source_id, source_version: source.source_version,
        generation_key: key, request_digest: native.requestDigest });
    }
  }
  const result = { contract: "source-publication-association-preparation-v2", provenance: "new_host_publication_association",
    population: population.name, dataset_sha256: census.dataset_sha256, retained_preflight_digest: chainIdentity(JSON.parse(raw)),
    source_occurrences: census.records.length, unsupported_source_occurrences: unsupported.size,
    ready_request_keys: expected.size,
    publicationAssociations: associations, artifacts,
    sources: census.records.map((source) => ({ source_id: source.source_id, source_version: source.source_version,
      status: unsupported.has(source.source_id) ? "unsupported_source" : reasons.has(source.source_id) ? "unbound" : "associated",
      ...(unsupported.has(source.source_id) ? { preparation: unsupported.get(source.source_id) } : {}),
      ...(reasons.has(source.source_id) ? { reason: reasons.get(source.source_id) } : {}) })) };
  writeChainArtifact(outputPath, result);
  writeChainJson(`${outputPath}.associations.json`, {
    contract: "source-publication-associations-v2", publicationAssociations: associations
  });
  return result;
}
