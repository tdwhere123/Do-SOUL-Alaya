export interface GardenChatCompletionConfig {
  readonly providerUrl: string;
  readonly model: string;
  readonly apiKey: string | null;
}

export interface GardenChatCompletionRequest {
  readonly config: GardenChatCompletionConfig;
  readonly systemPrompt: string;
  readonly userPrompt: string;
  readonly timeoutMs: number;
  readonly failureLabel: string;
}

const RETRY_DELAYS_MS = [100, 250] as const;

export async function requestGardenChatCompletionContent(
  input: GardenChatCompletionRequest
): Promise<string> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      return await requestGardenChatCompletionContentOnce(input);
    } catch (error) {
      lastError = error;
      if (!isRetryableGardenChatError(error) || attempt === RETRY_DELAYS_MS.length) {
        throw error;
      }
      await sleep(RETRY_DELAYS_MS[attempt] ?? 0);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(`${input.failureLabel} request failed`);
}

async function requestGardenChatCompletionContentOnce(
  input: GardenChatCompletionRequest
): Promise<string> {
  const { config } = input;
  if (config.apiKey === null) {
    throw new Error("garden API key is unavailable");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs);
  try {
    let response: Response;
    try {
      response = await fetch(`${normalizeBaseUrl(config.providerUrl)}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${config.apiKey}`
        },
        body: JSON.stringify({
          model: config.model,
          temperature: 0,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: input.systemPrompt },
            { role: "user", content: input.userPrompt }
          ]
        }),
        signal: controller.signal
      });
    } catch (error) {
      throw new GardenChatCompletionTransportError(
        `${input.failureLabel} transport failed`,
        error
      );
    }
    if (!response.ok) {
      throw new GardenChatCompletionHttpError(
        `${input.failureLabel} HTTP ${response.status} ${response.statusText}`,
        response.status
      );
    }
    const payload = (await response.json()) as {
      readonly choices?: readonly {
        readonly message?: { readonly content?: unknown };
      }[];
    };
    const content = payload.choices?.[0]?.message?.content;
    if (typeof content !== "string" || content.trim().length === 0) {
      throw new Error(`${input.failureLabel} returned no content`);
    }
    return content;
  } finally {
    clearTimeout(timer);
  }
}

class GardenChatCompletionHttpError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "GardenChatCompletionHttpError";
    this.status = status;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

class GardenChatCompletionTransportError extends Error {
  constructor(message: string, cause: unknown) {
    super(message, { cause });
    this.name = "GardenChatCompletionTransportError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

function isRetryableGardenChatError(error: unknown): boolean {
  if (error instanceof GardenChatCompletionHttpError) {
    return error.status === 429 || error.status >= 500;
  }

  return error instanceof GardenChatCompletionTransportError;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function normalizeBaseUrl(url: string): string {
  const trimmed = url.trim().replace(/\/+$/u, "");
  return trimmed.endsWith("/chat/completions")
    ? trimmed.slice(0, -"/chat/completions".length)
    : trimmed;
}
