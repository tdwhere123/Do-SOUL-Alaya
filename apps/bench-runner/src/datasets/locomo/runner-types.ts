import type {
  BenchEmbeddingVectorCacheSummary,
  BenchQaOption,
  BenchQueryEmbeddingCacheSummary,
  BenchRunOptions,
  BenchRunResult
} from "../../runs/index.js";
import type { LocomoVariant } from "./dataset.js";
import type { LocomoFetchResult } from "./fetch.js";

export interface LocomoRunOptions extends BenchRunOptions {
  readonly variant: LocomoVariant;
  readonly fetchResult?: LocomoFetchResult;
  readonly qa?: BenchQaOption;
}

export type LocomoRunResult = BenchRunResult;

export type LocomoEmbeddingVectorCacheSummary = BenchEmbeddingVectorCacheSummary;
export type LocomoQueryEmbeddingCacheSummary = BenchQueryEmbeddingCacheSummary;
