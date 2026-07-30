import { CrossEncoderScoreCache } from "./score-cache.js";

const DEFAULT_SCORE_CACHE_SIZE = 256;
const MAX_SCORE_CACHE_SIZE = 4_096;

export function createLocalOnnxCrossEncoderScoreCache(
  modelId: string,
  scoreCacheSize: number | undefined,
  validateLimit: (name: string, value: number, minimum: number, maximum: number) => number
): CrossEncoderScoreCache {
  return new CrossEncoderScoreCache(
    modelId,
    validateLimit(
      "scoreCacheSize",
      scoreCacheSize ?? DEFAULT_SCORE_CACHE_SIZE,
      0,
      MAX_SCORE_CACHE_SIZE
    )
  );
}

/** Resolve cache hits, enqueue only misses, then merge scores in passage order. */
export async function scoreWithCache(
  scoreCache: CrossEncoderScoreCache,
  query: string,
  passages: readonly string[],
  enqueue: (query: string, passages: readonly string[]) => Promise<readonly number[]>
): Promise<readonly number[]> {
  if (!scoreCache.enabled) {
    return await enqueue(query, passages);
  }
  const scores = new Array<number>(passages.length);
  const missIndexes: number[] = [];
  const missPassages: string[] = [];
  for (let index = 0; index < passages.length; index += 1) {
    const passage = passages[index]!;
    const cached = scoreCache.get(query, passage);
    if (cached !== undefined) {
      scores[index] = cached;
      continue;
    }
    missIndexes.push(index);
    missPassages.push(passage);
  }
  if (missPassages.length === 0) {
    return Object.freeze(scores);
  }
  const inferred = await enqueue(query, missPassages);
  for (let offset = 0; offset < missIndexes.length; offset += 1) {
    const score = inferred[offset]!;
    scores[missIndexes[offset]!] = score;
    scoreCache.set(query, missPassages[offset]!, score);
  }
  return Object.freeze(scores);
}
