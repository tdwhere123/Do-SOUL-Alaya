import {
  fetchProviderChatCompletion,
  ProviderChatCompletionError,
  withProviderRetry
} from "@do-soul/alaya-engine-gateway";

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
  return withProviderRetry(
    () => requestGardenChatCompletionContentOnce(input),
    {
      delaysMs: RETRY_DELAYS_MS,
      isRetryable: isRetryableGardenChatError
    }
  );
}

async function requestGardenChatCompletionContentOnce(
  input: GardenChatCompletionRequest
): Promise<string> {
  const apiKey = requireGardenApiKey(input.config.apiKey);
  try {
    const result = await fetchProviderChatCompletion({
      providerUrl: input.config.providerUrl,
      apiKey,
      model: input.config.model,
      systemPrompt: input.systemPrompt,
      userPrompt: input.userPrompt,
      timeoutMs: input.timeoutMs,
      mode: "json",
      jsonObject: true
    });
    if (result.text.trim().length === 0) {
      throw new Error(`${input.failureLabel} returned no content`);
    }
    return result.text;
  } catch (error) {
    throw mapGardenChatCompletionError(error, input.failureLabel, apiKey);
  }
}

function mapGardenChatCompletionError(
  error: unknown,
  failureLabel: string,
  apiKey: string
): Error {
  if (error instanceof ProviderChatCompletionError && error.kind === "http_error") {
    return new GardenChatCompletionHttpError(
      `${failureLabel} HTTP ${error.httpStatus ?? "unknown"}`,
      error.httpStatus ?? 0
    );
  }
  return new GardenChatCompletionTransportError(
    `${failureLabel} transport failed`,
    redactSecretFromCause(error, apiKey)
  );
}

function requireGardenApiKey(apiKey: string | null): string {
  if (apiKey === null) {
    throw new Error("garden API key is unavailable");
  }
  return apiKey;
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

function redactSecretFromCause(error: unknown, secret: string): unknown {
  if (secret.length === 0) {
    return error;
  }
  const messages = collectErrorMessages(error);
  if (messages.length === 0) return error;
  const redacted = new Error(messages.map((message) => redactSecret(message, secret)).join(" | "));
  if (error instanceof Error) {
    redacted.name = error.name;
    if (error.stack !== undefined) {
      redacted.stack = redactSecret(error.stack, secret);
    }
  }
  return redacted;
}

function collectErrorMessages(error: unknown): readonly string[] {
  const messages: string[] = [];
  let current: unknown = error;
  const seen = new Set<unknown>();
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    messages.push(current.message);
    current = current.cause;
  }
  if (typeof current === "string") messages.push(current);
  return messages;
}

function redactSecret(value: string, secret: string): string {
  return value.split(secret).join("[REDACTED_SECRET]");
}

