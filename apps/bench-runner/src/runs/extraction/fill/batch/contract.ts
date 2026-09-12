import type { GeminiGenerateContentSettings } from "./native-codec.js";
import type { ExtractionCacheWriteLease } from "../manifest/fill-root-guard.js";

export type GeminiBatchOperation = "prepare" | "submit" | "status" | "resume" | "import" | "cancel";

/** Logical identity is owned by the caller's shared extraction request owner. */
export interface GeminiBatchLine {
  readonly key: string;
  readonly unitKeys: readonly string[];
  readonly requestSha256: string;
  readonly systemPrompt: string;
  readonly userPrompt: string;
}

export interface GeminiBatchLimits {
  readonly maxJobs: number;
  readonly maxRequestsPerJob: number;
  readonly maxFileBytes: number;
  readonly maxInputTokensPerJob: number;
  readonly maxEnqueuedTokens: number;
  readonly maxOutputTokens: number;
  readonly maxUsd: number;
  readonly inputUsdPerMillion: number;
  readonly outputUsdPerMillion: number;
  readonly deadlineMs: number;
  readonly requestTimeoutMs: number;
  readonly maxPolls: number;
}

export interface GeminiBatchPlan {
  readonly identity: string;
  readonly model: string;
  readonly requestProfile: GeminiGenerateContentSettings["requestProfile"];
  readonly lines: readonly GeminiBatchLine[];
  readonly limits: GeminiBatchLimits;
}

export type GeminiBatchJobStatus = "prepared" | "uploading" | "uploaded" |
  "submission_unknown" | "submitted" | "running" | "succeeded" | "failed" |
  "cancel_requested" | "cancelled" | "expired";

export interface GeminiBatchJob {
  readonly id: string;
  readonly displayName: string;
  readonly lineKeys: readonly string[];
  readonly inputSha256: string;
  readonly inputBytes: number;
  readonly inputTokenBound: number;
  readonly costBoundUsd: number;
  status: GeminiBatchJobStatus;
  inputFile?: string;
  remoteJob?: string;
  outputFile?: string;
  submittedAt?: number;
  attemptOrdinals?: Readonly<Record<string, number>>;
  polls: number;
  cancelRequested?: boolean;
  rawOutputSha256?: string;
  outcomes: Record<string, { status: "admitted" | "failed" | "quarantined"; reason?: string }>;
  usage?: { inputTokens: number; outputTokens: number; totalTokens: number };
  usageUnknown: boolean;
  diagnostic?: string;
}

export interface GeminiBatchState {
  readonly version: 1;
  readonly transport: "gemini-batch";
  readonly planDigest: string;
  readonly endpoint: string;
  readonly jobs: GeminiBatchJob[];
}

export interface GeminiBatchHttp {
  readonly endpoint: string;
  upload(jsonl: string, displayName: string, signal?: AbortSignal): Promise<string>;
  create(model: string, inputFile: string, displayName: string, signal?: AbortSignal): Promise<unknown>;
  get(job: string, signal?: AbortSignal): Promise<unknown>;
  cancel(job: string, signal?: AbortSignal): Promise<void>;
  download(file: string, signal?: AbortSignal): Promise<string>;
}

export interface GeminiBatchInvocation {
  readonly operation: GeminiBatchOperation;
  readonly root: string;
  readonly lease: ExtractionCacheWriteLease;
  readonly plan: GeminiBatchPlan;
  readonly http: GeminiBatchHttp;
  readonly signal?: AbortSignal;
  /** Explicit operator reconciliation; fetched metadata must bind the known input file. */
  readonly reconcile?: { readonly localJob: string; readonly remoteJob: string };
  /** Shared parser/admission/cache owner; must be idempotent after a partial commit. */
  readonly importLine: (input: {
    readonly line: GeminiBatchLine;
    readonly rawJson: string;
    readonly provenance: {
      readonly transport: "gemini-batch";
      readonly job: string;
      readonly inputFile: string;
      readonly inputSha256: string;
      readonly outputSha256: string;
      readonly responseSha256: string;
      readonly finishReason: "STOP";
      readonly attemptOrdinal?: number;
      readonly usage?: { readonly inputTokens: number; readonly outputTokens: number; readonly totalTokens: number };
    };
  }) => Promise<void | { readonly status: "quarantined"; readonly reason: string }>;
  /** Existing attempt/authority owner reserves before the non-idempotent create. */
  readonly reserveSubmission: (lines: readonly GeminiBatchLine[], costBoundUsd: number) =>
    Promise<void | Readonly<Record<string, number>>>;
  /** Idempotent shared attempt accounting; publication may precede an interruption. */
  readonly recordLineOutcome?: (
    key: string,
    outcome: "success" | "provider_error" | "invalid" | "missing",
    usage: { readonly inputTokens: number; readonly outputTokens: number; readonly totalTokens: number } | undefined,
    binding: { readonly jobId: string; readonly attemptOrdinal: number }
  ) => void | Promise<void>;
}
