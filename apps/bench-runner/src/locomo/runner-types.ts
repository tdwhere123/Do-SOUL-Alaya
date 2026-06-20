import type { KpiPayload } from "@do-soul/alaya-eval";
import type {
  BenchEmbeddingMode,
  BenchEmbeddingProviderKind
} from "../harness/daemon.js";
import type { QaChatFn } from "../longmemeval/qa-chat.js";
import type { LocomoVariant } from "./dataset.js";
import type { LocomoFetchResult } from "./fetch.js";

export interface LocomoRunOptions {
  readonly variant: LocomoVariant;
  readonly limit?: number;
  readonly historyRoot: string;
  readonly dataDir?: string;
  readonly fetchResult?: LocomoFetchResult;
  readonly embeddingMode?: BenchEmbeddingMode;
  readonly embeddingProviderKind?: BenchEmbeddingProviderKind;
  readonly pinnedMetaRoot?: string;
  readonly offset?: number;
  // End-to-end QA: present only with --qa. Supplies the answer-LLM/judge chat fn.
  readonly qa?: {
    readonly chat: QaChatFn;
    readonly judgeChat?: QaChatFn;
    readonly answerModel?: string;
    readonly judgeModel?: string;
  };
}

export interface LocomoRunResult {
  readonly slug: string;
  readonly kpiPath: string;
  readonly reportPath: string;
  readonly findingsPath: string;
  readonly diagnosticsPath: string;
  readonly payload: KpiPayload;
}

export interface LocomoEmbeddingVectorCacheSummary {
  readonly expected_count: number;
  readonly ready_count: number;
  readonly not_ready_count: number;
  readonly ready_rate: number;
  readonly max_pass_count: number;
}

export interface LocomoQueryEmbeddingCacheSummary {
  readonly requested_count: number;
  readonly ready_count: number;
  readonly not_ready_count: number;
  readonly ready_rate: number;
  readonly cache_hit_count: number;
  readonly provider_requested_count: number;
  readonly last_error?: string;
}

