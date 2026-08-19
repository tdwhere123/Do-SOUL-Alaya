/**
 * @anchor longmemeval-qa-chat — provider-backed chat port for the end-to-end
 * QA harness (answer-LLM + LLM-judge). The harness takes a `QaChatFn` so unit
 * tests inject a fake chat and spend zero network / zero tokens).
 *
 * Credentials come from env only (never hard-coded). The QA path is gated OFF
 * by default (--qa flag); when off this module is never constructed, so a
 * normal recall bench makes zero LLM calls.
 *
 * see also: apps/bench-runner/src/longmemeval/qa-harness.ts — answer/judge flow
 */

import {
  executeProviderChatCompletion,
  providerExecutionFailureOf,
  ProviderChatCompletionError
} from "@do-soul/alaya-engine-gateway";

/** A single chat turn: system + user prompt -> assistant text. */
export type QaChatFn = (system: string, user: string) => Promise<string>;

export interface QaChatConfig {
  /** OpenAI-compatible provider base URL without a trailing slash. */
  readonly url: string;
  /** Bearer API key. */
  readonly apiKey: string;
  /** Provider model id. */
  readonly model: string;
}

export const QA_ENV_PROVIDER_URL = "ALAYA_QA_PROVIDER_URL";
export const QA_ENV_API_KEY = "ALAYA_QA_API_KEY";
export const QA_ENV_MODEL = "ALAYA_QA_MODEL";
export const QA_ENV_JUDGE_MODEL = "ALAYA_QA_JUDGE_MODEL";

/**
 * Resolve the garden chat credentials from env. Throws (fail-loud) when the
 * URL or key is missing so a --qa run never silently degrades to no answers.
 */
export function resolveQaChatConfig(
  env: NodeJS.ProcessEnv = process.env
): QaChatConfig {
  const url = env[QA_ENV_PROVIDER_URL]?.trim();
  const apiKey = env[QA_ENV_API_KEY]?.trim();
  const model = env[QA_ENV_MODEL]?.trim();
  if (url === undefined || url.length === 0) {
    throw new Error(
      `--qa requires ${QA_ENV_PROVIDER_URL} (garden chat provider base URL)`
    );
  }
  if (apiKey === undefined || apiKey.length === 0) {
    throw new Error(`--qa requires ${QA_ENV_API_KEY} (garden chat API key)`);
  }
  if (model === undefined || model.length === 0) {
    throw new Error(`--qa requires ${QA_ENV_MODEL} (answer model)`);
  }
  return { url, apiKey, model };
}

/**
 * Resolve the JUDGE chat credentials: same provider/key as the answer chat, but
 * the model is the judge override, falling back to the answer model when unset.
 */
export function resolveQaJudgeChatConfig(
  env: NodeJS.ProcessEnv = process.env
): QaChatConfig {
  const base = resolveQaChatConfig(env);
  const judgeModel = env[QA_ENV_JUDGE_MODEL]?.trim();
  return judgeModel !== undefined && judgeModel.length > 0
    ? { ...base, model: judgeModel }
    : base;
}

// Transient failures retried with exponential backoff so a single network blip
// or 5xx doesn't crash a 1000-call full-bench run. 4xx (except 408/429) is a
// client error and fails fast.
const QA_MAX_ATTEMPTS = 5;
const QA_RETRY_BASE_MS = 600;
const QA_RETRYABLE_STATUSES = [408, 409, 425, 429, 500, 502, 503, 504] as const;

/**
 * Terminal QA-chat failure after the transient retries are exhausted (network
 * reject / 5xx). Distinguished so the bench loop can SKIP the affected question
 * without swallowing a fatal fail-closed invariant — those stay plain Errors and
 * still abort the run. A non-retryable 4xx also stays a plain Error (config/auth
 * problem must surface, not be skipped 500×).
 */
export class QaChatError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "QaChatError";
  }
}

/**
 * Build a real chat fn over the shared provider executor. One system + one
 * user message returns the first choice's content. Transient
 * provider/network errors are retried; a non-retryable non-2xx surfaces so a
 * transient provider error never scores a blank answer as WRONG.
 */
export function createGardenChatFn(config: QaChatConfig): QaChatFn {
  return async (system: string, user: string): Promise<string> => {
    try {
      const execution = await executeProviderChatCompletion({
        providerUrl: config.url,
        apiKey: config.apiKey,
        model: config.model,
        systemPrompt: system,
        userPrompt: user,
        mode: "json",
        jsonObject: false
      }, {
        maxRetries: QA_MAX_ATTEMPTS - 1,
        retryDelaysMs: Array.from(
          { length: QA_MAX_ATTEMPTS - 1 },
          (_, attempt) => QA_RETRY_BASE_MS * 2 ** attempt
        ),
        retryHttpStatuses: QA_RETRYABLE_STATUSES,
        retryNetworkErrors: true
      });
      return execution.result.text;
    } catch (error) {
      throw mapQaChatFailure(error);
    }
  };
}

function mapQaChatFailure(error: unknown): Error {
  const receipt = providerExecutionFailureOf(error);
  if (error instanceof ProviderChatCompletionError && error.kind === "http_error") {
    if (receipt?.retryClassification !== "failure_max_retries") {
      return new Error(`garden chat HTTP ${error.httpStatus ?? "unknown"}`, { cause: error });
    }
  }
  if (receipt?.retryClassification === "failure_max_retries") {
    return new QaChatError(
      `garden chat failed after ${QA_MAX_ATTEMPTS} attempts: ${providerFailureDetail(error)}`,
      { cause: error }
    );
  }
  return error instanceof Error ? error : new Error(String(error));
}

function providerFailureDetail(error: unknown): string {
  if (error instanceof ProviderChatCompletionError && error.cause instanceof Error) {
    return error.cause.message;
  }
  return error instanceof Error ? error.message : String(error);
}
