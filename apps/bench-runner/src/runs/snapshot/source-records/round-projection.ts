import { AlayaError } from "@do-soul/alaya-protocol";
import type { LoadedLongMemEvalDataset } from "../../../datasets/longmemeval/ingestion/fetch.js";
import type { LongMemEvalSourceCensus } from "./census.js";
import type { SourcePublicationReport } from "./publish.js";

/** The dataset pin identifies original inputs; the prefix versions the round projection's
 * additional host facts. No second content digest or caller-selected revision is needed.
 * Unknown-host custom pins retain the legacy revision, never the captured revision. */
export function longMemEvalRoundSourceVersion(datasetSha256: string, hostCaptured: boolean): string {
  if (!/^[a-f0-9]{64}$/u.test(datasetSha256)) throw new AlayaError("VALIDATION", "round projection requires a dataset SHA-256");
  return hostCaptured ? `bench-round-host-v1:${datasetSha256}` : datasetSha256;
}

/** Only the producer imports the capture capability. Read-only publication consumers
 * can stage this same pure revision/binding owner without another runtime or authority. */
export async function createLongMemEvalRoundProjection(dataset: LoadedLongMemEvalDataset) {
  const { createLongMemEvalHostCapturePolicy } = await import("../../../datasets/longmemeval/ingestion/host-occurrences.js");
  const policy = dataset.promotionAuthority === null ? undefined : createLongMemEvalHostCapturePolicy(dataset);
  const sourceVersion = longMemEvalRoundSourceVersion(dataset.sha256, policy !== undefined);
  return {
    sourceVersion,
    capture: policy === undefined ? undefined : (input: Readonly<{
      questionId: string; sessionIndex: number; roundIndex: number; sourceId: string;
    }>) => policy({ ...input, sourceVersion })
  };
}

/** This does not reinterpret retained native seals or authorize a source write. */
export function assertLongMemEvalRoundSourceRevision(input: Readonly<{
  datasetSha256: string; sourceVersion: string; hostCaptured: boolean;
}>): void {
  if (input.sourceVersion !== longMemEvalRoundSourceVersion(input.datasetSha256, input.hostCaptured)) {
    throw new AlayaError("CONFLICT", "round source revision differs from its dataset-bound host projection");
  }
}

/** Evaluator copies of official inputs intentionally have no promotion capability.
 * Bind their byte-identical census to the already verified publication's revision,
 * not to a newly invented source. The caller also verifies that publication against
 * the actual sealed snapshot. No host-capture closure survives this read projection. */
export function bindPublishedLongMemEvalRoundCensus(census: LongMemEvalSourceCensus,
  publication: Pick<SourcePublicationReport, "workspace_id" | "sources" | "census_count" | "admitted_count">): LongMemEvalSourceCensus {
  const published = new Map(publication.sources.map(source => [source.source_id, source]));
  if (new Set(census.records.map(source => source.source_id)).size !== census.records.length ||
      published.size !== publication.sources.length || published.size !== census.records.length ||
      publication.census_count !== census.records.length || publication.admitted_count !== census.records.length) {
    throw new AlayaError("CONFLICT", "round publication must bind the complete census");
  }
  return { ...census, records: census.records.map(({ host_capture: _capture, ...record }) => {
    const source = published.get(record.source_id), identity = source?.source_record;
    if (source === undefined || identity === undefined || source.admission !== "admitted" ||
        source.record_id !== identity.identity || identity.workspace_id !== publication.workspace_id ||
        identity.source_id !== record.source_id || identity.source_version !== source.source_version ||
        identity.content_digest !== record.content_digest || source.content_digest !== record.content_digest ||
        source.corpus_digest !== record.corpus_digest || source.question_id !== record.question_id ||
        source.session_id !== record.session_id || source.session_index !== record.session_index || source.round_index !== record.round_index) {
      throw new AlayaError("CONFLICT", "round publication changed source identity, coordinates or rendered bytes");
    }
    assertLongMemEvalRoundSourceRevision({ datasetSha256: census.dataset_sha256, sourceVersion: source.source_version,
      hostCaptured: identity.host_structure !== undefined });
    return { ...record, source_version: source.source_version };
  }) };
}
