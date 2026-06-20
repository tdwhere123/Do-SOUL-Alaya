import { SignalExtractorError } from "./pi-mono-errors.js";
import type { PiMonoAssistantMessage, PiMonoContext, PiMonoGetModel, PiMonoModel, PiMonoStreamOptions } from "./pi-mono-extractor.js";

const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 8_192;
const OPENAI_DEFAULT_BASE_URL = "https://api.openai.com/v1";
const MAX_RESPONSE_TEXT_CHARS = 256_000;

function normalizeOpenAiBaseUrl(endpoint: string): string {
  const withoutTrailingSlash = endpoint.trim().replace(/\/+$/u, "");
  return withoutTrailingSlash.endsWith("/chat/completions")
    ? withoutTrailingSlash.slice(0, -"/chat/completions".length)
    : withoutTrailingSlash;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function selectModel(input: {
  readonly modelId: string;
  readonly endpoint?: string;
  readonly getModel: PiMonoGetModel;
}): PiMonoModel {
  const baseModel = input.getModel("openai", input.modelId) ?? createOpenAiCompatibleModel(input.modelId);
  if (input.endpoint === undefined) {
    return baseModel;
  }

  return {
    ...baseModel,
    api: "openai-completions",
    baseUrl: normalizeOpenAiBaseUrl(input.endpoint)
  };
}

// Default direct-OpenAI model. The fetch transport always targets
// /chat/completions (the universal OpenAI-compatible endpoint the bench and
// proxies use), not the OpenAI Responses API the prior pi-ai default resolved.
function createOpenAiCompatibleModel(modelId: string): PiMonoModel {
  return {
    id: modelId,
    name: modelId,
    api: "openai-completions",
    provider: "openai",
    baseUrl: OPENAI_DEFAULT_BASE_URL,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: DEFAULT_MAX_TOKENS
  };
}

// OpenAI-compatible POST to {baseUrl}/chat/completions. Non-ok throws an Error
// carrying .status so the retry loop classifies 4xx vs 5xx/429.
export async function fetchComplete(
  model: PiMonoModel,
  context: PiMonoContext,
  options?: PiMonoStreamOptions
): Promise<PiMonoAssistantMessage> {
  const baseUrl = model.baseUrl.replace(/\/+$/u, "");
  const body: Record<string, unknown> = {
    model: model.id,
    temperature: options?.temperature ?? 0,
    messages: [
      { role: "system", content: context.systemPrompt },
      ...context.messages.map((message) => ({
        role: message.role,
        content: message.content
      }))
    ]
  };
  const shaped = options?.onPayload?.(body, model) ?? body;
  const controller = new AbortController();
  const onAbort = (): void => controller.abort();
  if (options?.signal !== undefined) {
    if (options.signal.aborted) {
      controller.abort();
    } else {
      options.signal.addEventListener("abort", onAbort);
    }
  }
  const timer =
    options?.timeoutMs === undefined
      ? null
      : setTimeout(() => controller.abort(), options.timeoutMs);
  timer?.unref?.();
  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(options?.apiKey === undefined
          ? {}
          : { authorization: `Bearer ${options.apiKey}` })
      },
      body: JSON.stringify(shaped),
      signal: controller.signal
    });
    if (!response.ok) {
      const error = new Error(
        `Signal extractor request failed: HTTP ${response.status} ${response.statusText}`
      );
      (error as { status?: number }).status = response.status;
      throw error;
    }
    const payload = (await response.json()) as {
      readonly choices?: readonly {
        readonly message?: { readonly content?: unknown };
      }[];
    };
    const content = payload.choices?.[0]?.message?.content;
    return {
      content: [
        { type: "text", text: typeof content === "string" ? content : "" }
      ]
    };
  } finally {
    if (timer !== null) {
      clearTimeout(timer);
    }
    if (options?.signal !== undefined) {
      options.signal.removeEventListener("abort", onAbort);
    }
  }
}

export function requestJsonPayload(payload: unknown): unknown {
  if (!isRecord(payload)) {
    return payload;
  }

  if ("messages" in payload) {
    return {
      ...payload,
      temperature: 0,
      response_format: { type: "json_object" }
    };
  }

  if ("input" in payload) {
    const existingText = isRecord(payload.text) ? payload.text : {};
    return {
      ...payload,
      temperature: 0,
      text: {
        ...existingText,
        format: { type: "json_object" }
      }
    };
  }

  return payload;
}

export function readTextContent(message: PiMonoAssistantMessage): string {
  const text = message.content
    .filter(
      (block): block is { readonly type: "text"; readonly text: string } =>
        block.type === "text" && typeof block.text === "string"
    )
    .map((block) => block.text)
    .join("");

  if (text.trim().length === 0) {
    throw new SignalExtractorError("invalid_json", "Signal extractor returned no text content.");
  }

  if (text.length > MAX_RESPONSE_TEXT_CHARS) {
    throw new SignalExtractorError("invalid_json", "Signal extractor response exceeded the size limit.");
  }

  return text;
}
