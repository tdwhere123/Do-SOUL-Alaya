import { z } from "zod";
import { canonicalJson } from "@do-soul/alaya-protocol";
import { parseSourceSemanticRequest } from "@do-soul/alaya-soul";
import { censusCompleteSourceRecords } from "./census.js";
import { listRetainedSourceSemanticKeys, type SourcePublicationPopulation } from "./publish.js";
import { inspectCachedSourceSemantic } from "../../extraction/cache/source-semantic-artifact.js";
import { prepareSourceSemanticBatchLine } from "../../extraction/fill/batch/source-semantic-interpretation.js";
import { readBoundedCanonicalUtf8Artifact } from "../../extraction/cache-audit/bounded-artifact-reader.js";
import { chainIdentity, writeChainArtifact, writeChainJson } from "../../semantic-chain/contract.js";
import { EXTRACTION_OPEN_SEMANTICS_GENERATION, sourceSemanticArtifactRequests,
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
  if (population.cacheRoot === undefined) throw new Error("association preparation requires a retained cache");
  const generation = parseExtractionOpenSemanticsGeneration(population.openSemantics ?? EXTRACTION_OPEN_SEMANTICS_GENERATION);
  const census = await censusCompleteSourceRecords({ population: population.name,
    dataDir: population.dataDir, pinnedMetaRoot: population.pinnedMetaRoot,
    ...(population.questionWindow === undefined ? {} : { questionWindow: population.questionWindow }) });
  const raw = readBoundedCanonicalUtf8Artifact({ path: retainedPreflightPath, maxBytes: 32 * 1024 * 1024, label: "retained source preflight" });
  const lines = z.object({ planned_requests: z.array(LineSchema) }).passthrough().parse(JSON.parse(raw)).planned_requests;
  const planned = new Map<string, z.infer<typeof LineSchema>>();
  for (const line of lines) {
    const request = parseSourceSemanticRequest(JSON.parse(line.userPrompt));
    const expected = prepareSourceSemanticBatchLine(request, line.unitKeys, {
      model: population.model, requestProfile: population.requestProfile
    });
    if (canonicalJson(line) !== canonicalJson(expected) || planned.has(line.key)) {
      throw new Error("retained source preflight has foreign or duplicate request identity");
    }
    planned.set(line.key, line);
  }
  // These are new host associations, not claims about a retained line's historical unitKeys.
  // The census owns each occurrence; the extraction owner independently rebuilds its current request.
  const expected = new Map<string, { requestDigest: string; sources: typeof census.records[number][] }>();
  for (const source of census.records) {
    const requests = sourceSemanticArtifactRequests(source.content_bytes, "complete-source", generation);
    if (requests.length !== 1) throw new Error("complete source association requires exactly one current request");
    const line = prepareSourceSemanticBatchLine(requests[0]!.semantic, [], population);
    const match = expected.get(line.key) ?? { requestDigest: line.requestSha256, sources: [] };
    if (match.requestDigest !== line.requestSha256) throw new Error("current source requests have ambiguous owning key");
    match.sources.push(source);
    expected.set(line.key, match);
  }
  const associations: NonNullable<SourcePublicationPopulation["publicationAssociations"]>[number][] = [];
  const artifacts: { key: string; status: "associated" | "invalid" | "unbound"; sources: string[] }[] = [];
  const reasons = new Map(census.records.map((source) => [source.source_id, "missing_current_artifact"]));
  const keys = listRetainedSourceSemanticKeys(population.cacheRoot);
  if (new Set(keys).size !== keys.length) throw new Error("retained source cache repeats an owning request key");
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
  const result = { contract: "source-publication-association-preparation-v1", provenance: "new_host_publication_association",
    population: population.name, dataset_sha256: census.dataset_sha256, retained_preflight_digest: chainIdentity(JSON.parse(raw)),
    publicationAssociations: associations, artifacts,
    sources: census.records.map((source) => ({ source_id: source.source_id, source_version: source.source_version,
      status: reasons.has(source.source_id) ? "unbound" : "associated",
      ...(reasons.has(source.source_id) ? { reason: reasons.get(source.source_id) } : {}) })) };
  writeChainArtifact(outputPath, result);
  writeChainJson(`${outputPath}.associations.json`, associations);
  return result;
}
