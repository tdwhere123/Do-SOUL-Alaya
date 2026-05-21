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
import {
  SignalExtractorError,
  createPiMonoExtractor,
  type SignalExtractor
} from "./pi-mono-extractor.js";
import { buildSchemaGroundedRawPayload } from "./schema-grounding.js";
import { DISTILLED_FACT_MAX_CHARS } from "./materialization-router.js";

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
  readonly requestTimeoutMs?: number;
  readonly extractor?: SignalExtractor;
  readonly now?: () => string;
  readonly generateSignalId?: () => string;
}

// One parsed signal from the official-API extractor JSON. distilled_fact is
// absent when the model omits it (or supplies a non-string / empty value);
// in that case materialization-router.ts buildDistilledFact falls through to
// the rule distiller rather than receiving a faked span.
export interface OfficialApiSignalDraft {
  readonly signal_kind: CandidateMemorySignal["signal_kind"];
  readonly object_kind: string;
  readonly confidence: number;
  readonly matched_text: string;
  readonly distilled_fact?: string;
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

const DEFAULT_OFFICIAL_API_REQUEST_TIMEOUT_MS = 10_000;
export const OFFICIAL_API_GARDEN_MODEL = "gpt-4.1-mini";

// The distilled_fact contract below is the field-standard atomic-fact
// wording, adapted to this provider's {"signals":[...]} envelope so the
// production passive-extraction path emits resolved one-assertion facts
// instead of falling through to the rule distiller in
// materialization-router.ts buildDistilledFact.
// see also: apps/bench-runner/src/longmemeval/compile-seed.ts
//   (the LongMemEval bench seed path that drives this provider)
export const OFFICIAL_API_SYSTEM_PROMPT = [
  "You extract candidate durable memory signals from a single operator turn.",
  'Return strict JSON only with shape {"signals":[...]} and no markdown.',
  'Each signal must include "signal_kind", "object_kind", "confidence", "matched_text", and "distilled_fact".',
  'Use only supported signal kinds such as "potential_preference" and "potential_claim".',
  '"matched_text" is the verbatim span of the turn that triggered the signal.',
  '"distilled_fact" must be a self-contained declarative sentence carrying exactly one assertion.',
  "Resolve every pronoun, relative date, and reference in distilled_fact to its absolute form using the turn text.",
  "Preserve every concrete detail (names, numbers, dates, places) that appears in the turn.",
  "Do not invent facts and do not summarize away detail; split compound statements into separate signals.",
  'Return {"signals":[]} when the turn does not contain durable memory candidates.'
].join(" ");

export class OfficialApiGardenProvider implements GardenComputeProvider {
  public readonly provider_kind = GardenProviderKind.OFFICIAL_API;
  private readonly apiKey: string | null;
  private readonly model: string;
  private readonly endpoint: string | null;
  private readonly requestTimeoutMs: number;
  private readonly extractor: SignalExtractor | null;
  private readonly now: () => string;
  private readonly generateSignalId: () => string;

  public constructor(deps: OfficialApiGardenProviderDependencies = {}) {
    this.apiKey = normalizeOptionalString(deps.apiKey ?? null);
    this.model = normalizeOptionalString(deps.model) ?? OFFICIAL_API_GARDEN_MODEL;
    this.endpoint = normalizeOptionalString(deps.endpoint);
    this.requestTimeoutMs = normalizePositiveTimeoutMs(deps.requestTimeoutMs) ?? DEFAULT_OFFICIAL_API_REQUEST_TIMEOUT_MS;
    this.extractor = deps.extractor ?? (this.apiKey === null
      ? null
      : createPiMonoExtractor({
          apiKey: this.apiKey,
          model: this.model,
          ...(this.endpoint === null ? {} : { endpoint: this.endpoint })
        }));
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

    const signals: CandidateMemorySignal[] = [];
    let distilledFactOmittedCount = 0;
    for (const draft of drafts) {
      const confidence = clampConfidence(draft.confidence);
      // Observability: a draft with no distilled_fact makes
      // materialization-router.ts buildDistilledFact degrade to its rule
      // distiller (raw-payload truncation) instead of storing a resolved
      // one-assertion fact. Count per turn so the production omission rate
      // — how often ingestion silently loses §18-faithfulness — is visible.
      if (draft.distilled_fact === undefined) {
        distilledFactOmittedCount += 1;
      }
      try {
        signals.push(
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
            confidence,
            evidence_refs: [],
            raw_payload: buildSchemaGroundedRawPayload({
              signalKind: draft.signal_kind,
              objectKind: draft.object_kind,
              confidence,
              rawPayload: {
                matched_text: draft.matched_text,
                // materialization-router.ts buildDistilledFact reads this
                // key when present; an absent value (model omitted it)
                // falls through to that file's rule distiller. Never write
                // a faked span here.
                ...(draft.distilled_fact === undefined
                  ? {}
                  : { distilled_fact: draft.distilled_fact }),
                provider_kind: this.provider_kind,
                extraction_reason: draft.reason ?? "official_api",
                turn_content_excerpt: buildTurnExcerpt(normalizedTurnContent, draft.matched_text)
              }
            }),
            created_at: createdAt
          })
        );
      } catch (error) {
        // invariant: one over-budget signal (raw_payload past the protocol
        // 16 KB BoundedJsonObject cap — a long matched_text triples under
        // schema-grounding and overflows even after clamping — or an
        // empty/oversized matched_text) must not abort the turn's other
        // signals. Drop the bad signal and keep the rest; emit an observable
        // line so chronic overflow is a visible recall hole, not a silent one.
        console.warn("garden/compute-provider: dropped one official-API signal", {
          runId: context.run_id,
          signalKind: draft.signal_kind,
          matchedTextChars: draft.matched_text.length,
          distilledFactChars: draft.distilled_fact?.length ?? 0,
          error: readErrorMessage(error)
        });
      }
    }

    if (distilledFactOmittedCount > 0) {
      console.warn("garden/compute-provider: official-API drafts missing distilled_fact", {
        runId: context.run_id,
        omittedCount: distilledFactOmittedCount,
        draftCount: drafts.length
      });
    }

    return Object.freeze(signals);
  }

  private async requestSignals(
    turnContent: string,
    context: GardenCompileContext
  ): Promise<readonly OfficialApiSignalDraft[]> {
    if (this.extractor === null) {
      throw new GardenProviderError("Official garden provider credentials are missing.", "auth");
    }

    try {
      const response = await this.extractor.extract({
        systemPrompt: OFFICIAL_API_SYSTEM_PROMPT,
        userPrompt: JSON.stringify({
          workspace_id: context.workspace_id,
          run_id: context.run_id,
          surface_id: context.surface_id,
          turn_content: turnContent,
          turn_messages: context.turn_messages
        }),
        timeoutMs: this.requestTimeoutMs
      });
      return parseOfficialApiSignals(response.rawJson);
    } catch (error) {
      if (error instanceof SignalExtractorError) {
        throw new GardenProviderError(
          error.kind === "invalid_json"
            ? "Official garden provider returned an invalid response."
            : error.message,
          error.kind === "invalid_json" ? "invalid_response" : "network",
          { cause: error }
        );
      }
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

const MAX_OFFICIAL_API_SIGNALS = 64;
const MAX_OFFICIAL_API_OBJECT_KIND_CHARS = 200;
const MAX_OFFICIAL_API_MATCHED_TEXT_CHARS = 4_000;
const MAX_OFFICIAL_API_REASON_CHARS = 400;

// Exported so the LongMemEval bench seed path can drive its ingestion
// through this exact production parse instead of a divergent bench-only
// copy.
// see also: apps/bench-runner/src/longmemeval/compile-seed.ts
export function parseOfficialApiSignals(content: string): readonly OfficialApiSignalDraft[] {
  const parsed = JSON.parse(content) as unknown;
  // invariant: a malformed *envelope* (response is not an object, or has no
  // signals array) is a genuine total failure of the extraction call, so it
  // still throws hard. A malformed single *entry* is one bad fact among
  // many — it is dropped, never allowed to abort the turn's good signals.
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("signals" in parsed) ||
    !Array.isArray((parsed as { readonly signals?: unknown }).signals)
  ) {
    throw new Error("signals array missing");
  }

  const drafts: OfficialApiSignalDraft[] = [];
  for (const candidate of (parsed as { readonly signals: readonly unknown[] }).signals.slice(
    0,
    MAX_OFFICIAL_API_SIGNALS
  )) {
    const draft = parseOfficialApiSignalEntry(candidate);
    if (draft !== null) {
      drafts.push(draft);
    }
  }
  return Object.freeze(drafts);
}

// Parse one entry of the official-API {"signals":[...]} envelope. Returns
// null — instead of throwing — when the entry is malformed (hallucinated
// signal_kind, missing object_kind / matched_text / confidence, or a
// non-object element), so one bad fact is dropped while the rest survive.
function parseOfficialApiSignalEntry(candidate: unknown): OfficialApiSignalDraft | null {
  if (typeof candidate !== "object" || candidate === null) {
    return null;
  }

  const signalKind = normalizeOptionalString((candidate as { readonly signal_kind?: unknown }).signal_kind);
  const objectKind = normalizeOptionalString((candidate as { readonly object_kind?: unknown }).object_kind);
  const matchedText = normalizeOptionalString((candidate as { readonly matched_text?: unknown }).matched_text);
  const distilledFact = normalizeOptionalString((candidate as { readonly distilled_fact?: unknown }).distilled_fact);
  const confidence = (candidate as { readonly confidence?: unknown }).confidence;
  const reason = normalizeOptionalString((candidate as { readonly reason?: unknown }).reason);

  if (signalKind === null || !isSignalKind(signalKind)) {
    return null;
  }

  if (objectKind === null || matchedText === null || typeof confidence !== "number") {
    return null;
  }

  const clampedMatchedText = matchedText.slice(0, MAX_OFFICIAL_API_MATCHED_TEXT_CHARS);
  // distilled_fact is the resolved one-assertion fact materialization
  // stores as memory_entry content. A model that omits it (or sends a
  // non-string / empty value) leaves the field ABSENT so
  // materialization-router.ts buildDistilledFact degrades honestly to
  // its rule distiller — never fake one from matched_text. The clamp
  // shares DISTILLED_FACT_MAX_CHARS so the provider and materialization
  // agree on one budget.
  const clampedDistilledFact =
    distilledFact === null ? null : distilledFact.slice(0, DISTILLED_FACT_MAX_CHARS);
  const clampedReason = reason === null ? null : reason.slice(0, MAX_OFFICIAL_API_REASON_CHARS);
  return Object.freeze({
    signal_kind: signalKind,
    object_kind: objectKind.slice(0, MAX_OFFICIAL_API_OBJECT_KIND_CHARS),
    confidence,
    matched_text: clampedMatchedText,
    ...(clampedDistilledFact === null ? {} : { distilled_fact: clampedDistilledFact }),
    ...(clampedReason === null ? {} : { reason: clampedReason })
  });
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

function readErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
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
