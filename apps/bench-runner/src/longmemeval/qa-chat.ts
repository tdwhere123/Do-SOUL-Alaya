/**
 * @anchor longmemeval-qa-chat — thin OpenAI-compatible chat primitive for the
 * end-to-end QA harness (answer-LLM + LLM-judge). Mirrors the verified probe
 * `.do-it/a-qa-probe.mjs`: a bare POST /v1/chat/completions against the garden
 * provider URL (yunwu.ai, model gpt-5.4-nano). The garden extractor reuses the
 * SAME primitive, but a thin helper keeps the QA path self-contained,
 * dependency-light, and mockable (the QA harness takes a `QaChatFn` so unit
 * tests inject a fake chat and spend zero network / zero tokens).
 *
 * Credentials come from env only (never hard-coded). The QA path is gated OFF
 * by default (--qa flag); when off this module is never constructed, so a
 * normal recall bench makes zero LLM calls.
 *
 * see also: apps/bench-runner/src/longmemeval/qa-harness.ts — answer/judge flow
 */

/** A single chat turn: system + user prompt -> assistant text. */
export type QaChatFn = (system: string, user: string) => Promise<string>;

export interface QaChatConfig {
  /** Garden provider base URL, e.g. https://yunwu.ai/v1 (no trailing slash). */
  readonly url: string;
  /** Bearer API key. */
  readonly apiKey: string;
  /** Chat model id, e.g. gpt-5.4-nano. */
  readonly model: string;
}

export const QA_ENV_PROVIDER_URL = "OFFICIAL_API_GARDEN_PROVIDER_URL";
export const QA_ENV_API_KEY = "ALAYA_OFFICIAL_GARDEN_API_KEY";
export const QA_ENV_MODEL = "OFFICIAL_API_GARDEN_MODEL";
// QA answer/judge model override, independent of the extraction model. Lets a
// run keep OFFICIAL_API_GARDEN_MODEL=<seed model> (extraction cache hit) while
// answering/judging with a stronger model — extraction resolves its own model
// elsewhere and is unaffected by this override.
const QA_ENV_MODEL_OVERRIDE = "OFFICIAL_API_GARDEN_QA_MODEL";
const QA_DEFAULT_MODEL = "gpt-5.4-nano";
// Judge model override, independent of the answer model (LongMemEval's official
// metric judges with gpt-4o; mini-as-judge deflates preference). Falls back to
// the answer model when unset.
const QA_ENV_JUDGE_MODEL_OVERRIDE = "OFFICIAL_API_GARDEN_QA_JUDGE_MODEL";

/**
 * Resolve the garden chat credentials from env. Throws (fail-loud) when the
 * URL or key is missing so a --qa run never silently degrades to no answers.
 */
export function resolveQaChatConfig(
  env: NodeJS.ProcessEnv = process.env
): QaChatConfig {
  const url = env[QA_ENV_PROVIDER_URL]?.trim();
  const apiKey = env[QA_ENV_API_KEY]?.trim();
  const model =
    env[QA_ENV_MODEL_OVERRIDE]?.trim() || env[QA_ENV_MODEL]?.trim() || QA_DEFAULT_MODEL;
  if (url === undefined || url.length === 0) {
    throw new Error(
      `--qa requires ${QA_ENV_PROVIDER_URL} (garden chat provider base URL)`
    );
  }
  if (apiKey === undefined || apiKey.length === 0) {
    throw new Error(`--qa requires ${QA_ENV_API_KEY} (garden chat API key)`);
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
  const judgeModel = env[QA_ENV_JUDGE_MODEL_OVERRIDE]?.trim();
  return judgeModel !== undefined && judgeModel.length > 0
    ? { ...base, model: judgeModel }
    : base;
}

// Transient failures retried with exponential backoff so a single network blip
// or 5xx doesn't crash a 1000-call full-bench run. 4xx (except 408/429) is a
// client error and fails fast.
const QA_MAX_ATTEMPTS = 5;
const QA_RETRY_BASE_MS = 600;
const QA_RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

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
 * Build a real chat fn over fetch. Same shape as the verified probe: one
 * system + one user message, returns the first choice's content. Transient
 * provider/network errors are retried; a non-retryable non-2xx surfaces so a
 * transient provider error never scores a blank answer as WRONG.
 */
export function createGardenChatFn(config: QaChatConfig): QaChatFn {
  const endpoint = `${config.url.replace(/\/+$/u, "")}/chat/completions`;
  return async (system: string, user: string): Promise<string> => {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= QA_MAX_ATTEMPTS; attempt += 1) {
      let res: Response;
      try {
        res = await fetch(endpoint, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${config.apiKey}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            model: config.model,
            messages: [
              { role: "system", content: system },
              { role: "user", content: user }
            ]
          })
        });
      } catch (err) {
        // network-level reject ("fetch failed") — retry until attempts exhausted
        lastErr = err;
        if (attempt >= QA_MAX_ATTEMPTS) break;
        await sleep(QA_RETRY_BASE_MS * 2 ** (attempt - 1));
        continue;
      }
      if (!res.ok) {
        const body = (await res.text()).slice(0, 300);
        if (QA_RETRYABLE_STATUS.has(res.status) && attempt < QA_MAX_ATTEMPTS) {
          lastErr = new Error(`garden chat HTTP ${res.status}: ${body}`);
          await sleep(QA_RETRY_BASE_MS * 2 ** (attempt - 1));
          continue;
        }
        throw new Error(`garden chat HTTP ${res.status}: ${body}`);
      }
      const data = (await res.json()) as {
        choices?: { message?: { content?: string } }[];
      };
      return data.choices?.[0]?.message?.content ?? "";
    }
    throw new QaChatError(
      `garden chat failed after ${QA_MAX_ATTEMPTS} attempts: ${
        lastErr instanceof Error ? lastErr.message : String(lastErr)
      }`,
      { cause: lastErr }
    );
  };
}
