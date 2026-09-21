import { z } from "zod";
import { canonicalJson } from "@do-soul/alaya-protocol";
import { parseSourceSemanticRequest } from "@do-soul/alaya-soul";
import { censusCompleteSourceRecords } from "./census.js";
import { listRetainedSourceSemanticKeys, type SourcePublicationPopulation } from "./publish.js";
import { inspectCachedSourceSemantic } from "../../extraction/cache/source-semantic-artifact.js";
import { prepareSourceSemanticBatchLine } from "../../extraction/fill/batch/source-semantic-interpretation.js";
import { readBoundedCanonicalUtf8Artifact } from "../../extraction/cache-audit/bounded-artifact-reader.js";
import { chainIdentity, writeChainArtifact, writeChainJson } from "../../semantic-chain/contract.js";

const LineSchema = z.object({ key: z.string(), unitKeys: z.array(z.string()), requestSha256: z.string(),
  systemPrompt: z.string(), userPrompt: z.string() }).strict();

/** New host associations only; neither bytes nor a model-cache key proves historical source origin. */
export async function prepareSourcePublicationAssociations(
  population: Omit<SourcePublicationPopulation, "cacheRoots"> & Readonly<{ cacheRoot: string }>,
  retainedPreflightPath: string, outputPath: string
) {
  if (population.cacheRoot === undefined) throw new Error("association preparation requires a retained cache");
  const census = await censusCompleteSourceRecords({ population: population.name,
    dataDir: population.dataDir, pinnedMetaRoot: population.pinnedMetaRoot });
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
  const associations: NonNullable<SourcePublicationPopulation["publicationAssociations"]>[number][] = [];
  const artifacts: { key: string; status: "associated" | "invalid" | "unbound" | "ambiguous"; sources: string[] }[] = [];
  const candidates = new Map<string, { key: string; request_digest: string }[]>();
  for (const key of listRetainedSourceSemanticKeys(population.cacheRoot)) {
    const native = inspectCachedSourceSemantic(population.cacheRoot, key, population.model, population.requestProfile);
    const retained = planned.get(key);
    if (native.status !== "hit") { artifacts.push({ key, status: "invalid", sources: [] }); continue; }
    if (retained === undefined || native.requestDigest !== retained.requestSha256) {
      artifacts.push({ key, status: "unbound", sources: [] }); continue;
    }
    const sources = census.records.filter((source) => source.corpus_digest === native.admitted.request.source_catalog.source_digest);
    if (sources.length !== 1) {
      artifacts.push({ key, status: sources.length === 0 ? "unbound" : "ambiguous", sources: sources.map((source) => source.source_id) });
      continue;
    }
    const source = sources[0]!;
    const list = candidates.get(source.source_id) ?? [];
    list.push({ key, request_digest: native.requestDigest }); candidates.set(source.source_id, list);
  }
  for (const source of census.records) {
    const matches = candidates.get(source.source_id) ?? [];
    for (const match of matches) artifacts.push({ key: match.key,
      status: matches.length === 1 ? "associated" : "ambiguous", sources: [source.source_id] });
    if (matches.length === 1) associations.push({ source_id: source.source_id, source_version: source.source_version,
      generation_key: matches[0]!.key, request_digest: matches[0]!.request_digest });
  }
  const result = { contract: "source-publication-association-preparation-v1", provenance: "new_host_publication_association",
    population: population.name, dataset_sha256: census.dataset_sha256, retained_preflight_digest: chainIdentity(JSON.parse(raw)),
    publicationAssociations: associations, artifacts,
    sources: census.records.map((source) => ({ source_id: source.source_id, source_version: source.source_version,
      status: associations.some((row) => row.source_id === source.source_id) ? "associated" : "unbound" })) };
  writeChainArtifact(outputPath, result);
  writeChainJson(`${outputPath}.associations.json`, associations);
  return result;
}
