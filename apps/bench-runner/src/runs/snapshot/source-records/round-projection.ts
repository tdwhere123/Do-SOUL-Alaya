import { AlayaError } from "@do-soul/alaya-protocol";
import type { LoadedLongMemEvalDataset } from "../../../datasets/longmemeval/ingestion/fetch.js";
import { createLongMemEvalHostCapturePolicy } from "../../../datasets/longmemeval/ingestion/host-occurrences.js";

/** The dataset pin identifies original inputs; the prefix versions the round projection's
 * additional host facts. No second content digest or caller-selected revision is needed.
 * Unknown-host custom pins retain the legacy revision, never the captured revision. */
export function longMemEvalRoundSourceVersion(datasetSha256: string, hostCaptured: boolean): string {
  if (!/^[a-f0-9]{64}$/u.test(datasetSha256)) throw new AlayaError("VALIDATION", "round projection requires a dataset SHA-256");
  return hostCaptured ? `bench-round-host-v1:${datasetSha256}` : datasetSha256;
}

/** The existing opaque dataset capability and exact structured renderer remain the
 * admission authority. The census owns the revision passed into that closure. */
export function createLongMemEvalRoundProjection(dataset: LoadedLongMemEvalDataset) {
  const policy = dataset.promotionAuthority === null ? undefined : createLongMemEvalHostCapturePolicy(dataset);
  const sourceVersion = longMemEvalRoundSourceVersion(dataset.sha256, policy !== undefined);
  return {
    sourceVersion,
    capture: policy === undefined ? undefined : (input: Readonly<{
      questionId: string; sessionIndex: number; roundIndex: number; sourceId: string;
    }>) => policy({ ...input, sourceVersion })
  };
}

/** Consumers of new round publications use the same revision authority, not a
 * dataset-hash equality assumption. This does not reinterpret retained native seals. */
export function assertLongMemEvalRoundSourceRevision(input: Readonly<{
  datasetSha256: string; sourceVersion: string; hostCaptured: boolean;
}>): void {
  if (input.sourceVersion !== longMemEvalRoundSourceVersion(input.datasetSha256, input.hostCaptured)) {
    throw new AlayaError("CONFLICT", "round source revision differs from its dataset-bound host projection");
  }
}
