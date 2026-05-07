import {
  CandidateMemorySignalSchema,
  GardenProviderKind as GardenProviderKinds,
  type GardenProviderKind as GardenProviderKindValue,
  SignalKind,
  SignalSource,
  type CandidateMemorySignal,
  type ConversationMessage
} from "@do-soul/alaya-protocol";
import { randomUUID } from "node:crypto";

export const GardenProviderKind = GardenProviderKinds;
export type GardenProviderKind = GardenProviderKindValue;

export interface GardenCompileContext {
  readonly workspace_id: string;
  readonly run_id: string;
  readonly surface_id: string | null;
  readonly turn_messages: readonly ConversationMessage[];
}

export interface GardenComputeProvider {
  readonly provider_kind: GardenProviderKind;
  compile(turnContent: string, context: GardenCompileContext): Promise<readonly CandidateMemorySignal[]>;
}

type GardenProviderErrorKind = "auth" | "network" | "provider_failure" | "invalid_response";

interface OfficialApiGardenProviderDependencies {
  readonly apiKey?: string | null;
  readonly model?: string | null;
  readonly endpoint?: string | null;
  readonly fetchImpl?: typeof fetch;
  readonly requestTimeoutMs?: number;
  readonly createAbortController?: () => AbortController;
  readonly setTimeoutImpl?: typeof setTimeout;
  readonly clearTimeoutImpl?: typeof clearTimeout;
  readonly now?: () => string;
  readonly generateSignalId?: () => string;
}

interface OfficialApiSignalDraft {
  readonly signal_kind: CandidateMemorySignal["signal_kind"];
  readonly object_kind: string;
  readonly confidence: number;
  readonly matched_text: string;
  readonly reason?: string;
}

export class GardenProviderError extends Error {
  public constructor(
    message: string,
    public readonly kind: GardenProviderErrorKind,
    options?: { readonly cause?: unknown }
  ) {
    super(message, options);
    this.name = "GardenProviderError";
  }
}

const OFFICIAL_API_ENDPOINT = "https://api.openai.com/v1/chat/completions";
const DEFAULT_OFFICIAL_API_REQUEST_TIMEOUT_MS = 10_000;
export const OFFICIAL_API_GARDEN_MODEL = "gpt-4.1-mini";
const OFFICIAL_API_SYSTEM_PROMPT = [
  "You extract candidate durable memory signals from a single operator turn.",
  'Return strict JSON only with shape {"signals":[...]} and no markdown.',
  'Each signal must include "signal_kind", "object_kind", "confidence", and "matched_text".',
  'Use only supported signal kinds such as "potential_preference" and "potential_claim".',
  'Return {"signals":[]} when the turn does not contain durable memory candidates.'
].join(" ");

export class OfficialApiGardenProvider implements GardenComputeProvider {
  public readonly provider_kind = GardenProviderKind.OFFICIAL_API;
  private readonly apiKey: string | null;
  private readonly model: string;
  private readonly endpoint: string;
  private readonly fetchImpl: typeof fetch;
  private readonly requestTimeoutMs: number;
  private readonly createAbortController: () => AbortController;
  private readonly setTimeoutImpl: typeof setTimeout;
  private readonly clearTimeoutImpl: typeof clearTimeout;
  private readonly now: () => string;
  private readonly generateSignalId: () => string;

  public constructor(deps: OfficialApiGardenProviderDependencies = {}) {
    this.apiKey = normalizeOptionalString(deps.apiKey ?? null);
    this.model = normalizeOptionalString(deps.model) ?? OFFICIAL_API_GARDEN_MODEL;
    this.endpoint = normalizeOptionalString(deps.endpoint) ?? OFFICIAL_API_ENDPOINT;
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.requestTimeoutMs = normalizePositiveTimeoutMs(deps.requestTimeoutMs) ?? DEFAULT_OFFICIAL_API_REQUEST_TIMEOUT_MS;
    this.createAbortController = deps.createAbortController ?? (() => new AbortController());
    this.setTimeoutImpl = deps.setTimeoutImpl ?? setTimeout;
    this.clearTimeoutImpl = deps.clearTimeoutImpl ?? clearTimeout;
    this.now = deps.now ?? (() => new Date().toISOString());
    this.generateSignalId = deps.generateSignalId ?? (() => randomUUID());
  }

  public async compile(
    turnContent: string,
    context: GardenCompileContext
  ): Promise<readonly CandidateMemorySignal[]> {
    const normalizedTurnContent = turnContent.trim();
    if (normalizedTurnContent.length === 0) {
      return [];
    }

    if (this.apiKey === null) {
      throw new GardenProviderError("Official garden provider credentials are missing.", "auth");
    }

    const drafts = await this.requestSignals(normalizedTurnContent, context);
    const createdAt = this.now();

    return Object.freeze(
      drafts.map((draft) =>
        CandidateMemorySignalSchema.parse({
          signal_id: this.generateSignalId(),
          workspace_id: context.workspace_id,
          run_id: context.run_id,
          surface_id: context.surface_id,
          source: SignalSource.GARDEN_COMPILE,
          signal_kind: draft.signal_kind,
          object_kind: draft.object_kind,
          scope_hint: null,
          domain_tags: [],
          confidence: clampConfidence(draft.confidence),
          evidence_refs: [],
          raw_payload: {
            matched_text: draft.matched_text,
            provider_kind: this.provider_kind,
            extraction_reason: draft.reason ?? "official_api",
            turn_content_excerpt: buildTurnExcerpt(normalizedTurnContent, draft.matched_text)
          },
          created_at: createdAt
        })
      )
    );
  }

  private async requestSignals(
    turnContent: string,
    context: GardenCompileContext
  ): Promise<readonly OfficialApiSignalDraft[]> {
    let response: Response;
    const abortController = this.createAbortController();
    const timeoutHandle = this.setTimeoutImpl(() => {
      abortController.abort();
    }, this.requestTimeoutMs);

    try {
      response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          "content-type": "application/json"
        },
        signal: abortController.signal,
        body: JSON.stringify({
          model: this.model,
          temperature: 0,
          response_format: { type: "json_object" },
          messages: [
            {
              role: "system",
              content: OFFICIAL_API_SYSTEM_PROMPT
            },
            {
              role: "user",
              content: JSON.stringify({
                workspace_id: context.workspace_id,
                run_id: context.run_id,
                surface_id: context.surface_id,
                turn_content: turnContent,
                turn_messages: context.turn_messages
              })
            }
          ]
        })
      });
    } catch (error) {
      const message = abortController.signal.aborted
        ? `Official garden provider request timed out after ${this.requestTimeoutMs}ms.`
        : "Official garden provider request failed.";
      throw new GardenProviderError(message, "network", {
        cause: error
      });
    } finally {
      this.clearTimeoutImpl(timeoutHandle);
    }

    if (!response.ok) {
      throw new GardenProviderError(
        `Official garden provider request failed with status ${response.status}.`,
        response.status === 401 || response.status === 403 ? "auth" : "provider_failure"
      );
    }

    try {
      return parseOfficialApiSignals(await readAssistantContent(response));
    } catch (error) {
      throw new GardenProviderError("Official garden provider returned an invalid response.", "invalid_response", {
        cause: error
      });
    }
  }
}

export class CustomApiGardenProvider implements GardenComputeProvider {
  public readonly provider_kind = GardenProviderKind.CUSTOM_API;

  public async compile(): Promise<readonly CandidateMemorySignal[]> {
    throw new GardenProviderError(
      "CustomApiGardenProvider is not implemented in Phase 0.5.",
      "provider_failure"
    );
  }
}

export class LocalModelGardenProvider implements GardenComputeProvider {
  public readonly provider_kind = GardenProviderKind.LOCAL_MODEL;

  public async compile(): Promise<readonly CandidateMemorySignal[]> {
    throw new GardenProviderError(
      "LocalModelGardenProvider is not implemented in Phase 0.5.",
      "provider_failure"
    );
  }
}

async function readAssistantContent(response: Response): Promise<string> {
  const body = await response.json() as {
    readonly choices?: ReadonlyArray<{
      readonly message?: {
        readonly content?: string | ReadonlyArray<{ readonly type?: string; readonly text?: string }>;
      };
    }>;
  };
  const content = body.choices?.[0]?.message?.content;

  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    const text = content
      .filter((part) => part.type === "text" && typeof part.text === "string")
      .map((part) => part.text)
      .join("");
    if (text.length > 0) {
      return text;
    }
  }

  throw new Error("assistant content missing");
}

function parseOfficialApiSignals(content: string): readonly OfficialApiSignalDraft[] {
  const parsed = JSON.parse(content) as unknown;
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("signals" in parsed) ||
    !Array.isArray((parsed as { readonly signals?: unknown }).signals)
  ) {
    throw new Error("signals array missing");
  }

  return Object.freeze(
    (parsed as { readonly signals: readonly unknown[] }).signals.map((candidate) => {
      if (typeof candidate !== "object" || candidate === null) {
        throw new Error("signal entry must be an object");
      }

      const signalKind = normalizeOptionalString((candidate as { readonly signal_kind?: unknown }).signal_kind);
      const objectKind = normalizeOptionalString((candidate as { readonly object_kind?: unknown }).object_kind);
      const matchedText = normalizeOptionalString((candidate as { readonly matched_text?: unknown }).matched_text);
      const confidence = (candidate as { readonly confidence?: unknown }).confidence;
      const reason = normalizeOptionalString((candidate as { readonly reason?: unknown }).reason);

      if (signalKind === null || !isSignalKind(signalKind)) {
        throw new Error("signal_kind must be a supported protocol value");
      }

      if (objectKind === null || matchedText === null || typeof confidence !== "number") {
        throw new Error("signal entry missing required fields");
      }

      return Object.freeze({
        signal_kind: signalKind,
        object_kind: objectKind,
        confidence,
        matched_text: matchedText,
        ...(reason === null ? {} : { reason })
      });
    })
  );
}

function normalizeOptionalString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function normalizePositiveTimeoutMs(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return null;
  }

  return value;
}

function clampConfidence(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function isSignalKind(value: string): value is CandidateMemorySignal["signal_kind"] {
  return (
    value === SignalKind.POTENTIAL_CLAIM ||
    value === SignalKind.POTENTIAL_SYNTHESIS ||
    value === SignalKind.POTENTIAL_HANDOFF ||
    value === SignalKind.POTENTIAL_EVIDENCE_ANCHOR ||
    value === SignalKind.POTENTIAL_CONFLICT ||
    value === SignalKind.POTENTIAL_PREFERENCE
  );
}

function buildTurnExcerpt(turnContent: string, matchedText: string): string {
  const index = turnContent.indexOf(matchedText);
  if (index < 0) {
    return turnContent.slice(0, 160);
  }

  const start = Math.max(0, index - 40);
  const end = Math.min(turnContent.length, index + matchedText.length + 40);
  return turnContent.slice(start, end).trim();
}
