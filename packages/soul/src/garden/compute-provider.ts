import {
  AlayaError,
  CandidateMemorySignalSchema,
  GardenProviderKind as GardenProviderKinds,
  type GardenProviderKind as GardenProviderKindValue,
  readErrorMessage,
  type CandidateMemorySignal,
  type ConversationMessage
} from "@do-soul/alaya-protocol";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import {
  SignalExtractorError,
  createPiMonoExtractor,
  type SignalExtractor
} from "./pi-mono-extractor.js";
import {
  WallClockTimeoutError,
  withWallClockTimeout
} from "./wall-clock-timeout.js";
import {
  clampConfidence,
  normalizeOptionalString,
  normalizePositiveTimeoutMs,
  parseOfficialApiSignals,
  type OfficialApiSignalDraft
} from "./official-api-signal-parser.js";
import {
  normalizeSourceObservedAt,
  selectObservedTemporalProjection
} from "./temporal/observed-projection.js";
import { buildOfficialCandidateSignal } from "./official-api/signal-payload.js";
import { groundOfficialApiDraft } from "./official-api/source-grounding.js";
import {
  dumpOfficialApiRequestDiagnostic,
  type OfficialApiExtractorMeta
} from "./official-api/request-diagnostic.js";

export { parseOfficialApiSignals, salvageRawSignalElements } from "./official-api-signal-parser.js";
export type { OfficialApiSignalDraft } from "./official-api-signal-parser.js";

export const GardenProviderKind = GardenProviderKinds;
export type GardenProviderKind = GardenProviderKindValue;

export interface GardenCompileContext {
  readonly workspace_id: string;
  readonly run_id: string;
  readonly surface_id: string | null;
  readonly turn_messages: readonly ConversationMessage[];
  readonly source_observed_at?: string;
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
  // invariant: outer wall-clock budget. Defaults to readTimeoutMs + 30s.
  // Test seam.
  // see also: packages/soul/src/garden/wall-clock-timeout.ts
  readonly wallClockBudgetMs?: number;
  readonly extractor?: SignalExtractor;
  readonly now?: () => string;
  readonly generateSignalId?: () => string;
  // When set, a requestSignals invalid_response failure dumps a diagnostic
  // JSON envelope to <diagnosticDir>/<ISO-ts>-<uuid>.json
  // BEFORE the exception is rethrown. The dump is observation-only — it does
  // not alter blocker logic or recover the failed call. Leave undefined to
  // disable (no fs writes). Defaults to the cwd-rooted directory
  // data/diagnostics/seed-extraction-failures/ so the bench preflight can
  // read what the live extraction returned without bypassing the blocker.
  readonly diagnosticDir?: string | null;
}

// Default cwd-rooted diagnostic directory used when no diagnosticDir override
// is supplied. Generated path (data/* is gitignored); never treat as source.
const DEFAULT_DIAGNOSTIC_DIR_REL = "data/diagnostics/seed-extraction-failures";

export class GardenProviderError extends AlayaError {
  public readonly kind: GardenProviderErrorKind;

  public constructor(
    message: string,
    kind: GardenProviderErrorKind,
    options?: { readonly cause?: unknown }
  ) {
    super(kind, message, options);
    this.name = "GardenProviderError";
    this.kind = kind;
  }
}
const DEFAULT_OFFICIAL_API_REQUEST_TIMEOUT_MS = 10_000;
// invariant: outer wall-clock budget = read timeout + grace. Read timeout
// drives the inner SDK abort; wall-clock catches stale sockets the monotonic
// timer cannot detect after host suspend.
// see also: packages/soul/src/garden/wall-clock-timeout.ts
const WALL_CLOCK_OUTER_GRACE_MS = 30_000;
function wallClockBudgetFor(readTimeoutMs: number): number {
  return readTimeoutMs + WALL_CLOCK_OUTER_GRACE_MS;
}
export const OFFICIAL_API_GARDEN_MODEL = "gpt-4.1-mini";

// The distilled_fact contract below is the field-standard atomic-fact
// wording, adapted to this provider's {"signals":[...]} envelope so the
// production passive-extraction path emits resolved one-assertion facts
// instead of falling through to the rule distiller in
// materialization-router/inputs.ts buildDistilledFact.
// see also: apps/bench-runner/src/longmemeval/compile-seed.ts
//   (the LongMemEval bench seed path that drives this provider)
export const OFFICIAL_API_SYSTEM_PROMPT = [
  "You extract candidate durable memory signals from a single operator turn.",
  'Return strict JSON only with shape {"signals":[...]} and no markdown.',
  'Each signal must include "signal_kind", "object_kind", "confidence", "matched_text", and "distilled_fact".',
  'Use only supported signal kinds such as "potential_preference" and "potential_claim".',
  '"matched_text" is an exact verbatim substring containing the complete atomic assertion, not isolated keywords.',
  '"distilled_fact" must be a self-contained declarative sentence carrying exactly one assertion.',
  'When a synthesis signal cites existing evidence or memories by ID, include "evidence_refs" and "source_memory_refs" arrays.',
  'When a signal has an event or valid-time fact, include optional "temporal_projection" with "projection_schema_version":1, ISO "event_time_start"/"event_time_end", ISO "valid_from"/"valid_to", "time_precision", and "time_source".',
  "For relative dates, omit absolute temporal_projection dates; the runtime resolves them from source observation.",
  'When a signal is a durable preference, include optional "preference_profile" with "projection_schema_version":1, "subject", "predicate", "object", "category", and "polarity".',
  'Include "canonical_entities": an array of at most 3 lowercase canonical names for the entities or subjects the distilled_fact is about, resolving pronouns and aliases so the SAME real-world entity always yields the SAME string across turns.',
  "Resolve pronouns and non-temporal references in distilled_fact using only the turn text.",
  "Preserve relative-date wording exactly; never infer an absolute date absent from the turn text.",
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
  private readonly wallClockBudgetMs: number;
  private readonly extractor: SignalExtractor | null;
  private readonly now: () => string;
  private readonly generateSignalId: () => string;
  // Absolute directory for invalid_response diagnostic dumps, or null when
  // dumps are disabled. Resolved once at construction so
  // a later cwd change does not retarget the dump file mid-run.
  private readonly diagnosticDir: string | null;

  public constructor(deps: OfficialApiGardenProviderDependencies = {}) {
    this.apiKey = normalizeOptionalString(deps.apiKey ?? null);
    this.model = normalizeOptionalString(deps.model) ?? OFFICIAL_API_GARDEN_MODEL;
    this.endpoint = normalizeOptionalString(deps.endpoint);
    this.requestTimeoutMs = normalizePositiveTimeoutMs(deps.requestTimeoutMs) ?? DEFAULT_OFFICIAL_API_REQUEST_TIMEOUT_MS;
    this.wallClockBudgetMs =
      normalizePositiveTimeoutMs(deps.wallClockBudgetMs) ??
      wallClockBudgetFor(this.requestTimeoutMs);
    this.extractor = deps.extractor ?? (this.apiKey === null
      ? null
      : createPiMonoExtractor({
          apiKey: this.apiKey,
          model: this.model,
          ...(this.endpoint === null ? {} : { endpoint: this.endpoint })
        }));
    this.now = deps.now ?? (() => new Date().toISOString());
    this.generateSignalId = deps.generateSignalId ?? (() => randomUUID());
    // null sentinel ("disabled") vs undefined ("use default cwd path"). A null
    // override is honoured exactly — production wiring that intentionally
    // turns dumps off (e.g. read-only fs) gets no fs writes.
    this.diagnosticDir =
      deps.diagnosticDir === null
        ? null
        : deps.diagnosticDir === undefined
          ? resolve(process.cwd(), DEFAULT_DIAGNOSTIC_DIR_REL)
          : resolve(deps.diagnosticDir);
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
    const createdAt = normalizeSourceObservedAt(context.source_observed_at) ?? this.now();

    const signals: CandidateMemorySignal[] = [];
    let distilledFactOmittedCount = 0;
    for (const draft of drafts) {
      if (draft.distilled_fact === undefined) {
        distilledFactOmittedCount += 1;
      }
      const signal = this.buildSignalFromDraft(draft, context, normalizedTurnContent, createdAt);
      if (signal !== null) {
        signals.push(signal);
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

  private buildSignalFromDraft(
    draft: OfficialApiSignalDraft,
    context: GardenCompileContext,
    normalizedTurnContent: string,
    createdAt: string
  ): CandidateMemorySignal | null {
    const grounding = groundOfficialApiDraft(draft, normalizedTurnContent);
    if (grounding.status === "rejected") {
      console.warn("garden/compute-provider: rejected ungrounded official-API signal", {
        runId: context.run_id,
        reasons: grounding.audit.reasons
      });
    }
    const groundedDraft = grounding.draft;
    const confidence = clampConfidence(groundedDraft.confidence);
    const temporalProjection = grounding.status === "grounded"
      ? selectObservedTemporalProjection(
          groundedDraft.matched_text,
          groundedDraft.temporal_projection,
          context.source_observed_at
        )
      : undefined;
    try {
      return CandidateMemorySignalSchema.parse(buildOfficialCandidateSignal({
        draft: groundedDraft,
        workspaceId: context.workspace_id,
        runId: context.run_id,
        surfaceId: context.surface_id,
        normalizedTurnContent,
        confidence,
        temporalProjection,
        distilledFact: groundedDraft.distilled_fact,
        providerKind: this.provider_kind,
        signalId: this.generateSignalId(),
        createdAt,
        sourceGrounding: grounding.audit
      }));
    } catch (error) {
      console.warn("garden/compute-provider: dropped one official-API signal", {
        runId: context.run_id,
        signalKind: draft.signal_kind,
        matchedTextChars: draft.matched_text.length,
        distilledFactChars: draft.distilled_fact?.length ?? 0,
        error: readErrorMessage(error, "unknown error")
      });
      return null;
    }
  }

  private async requestSignals(
    turnContent: string,
    context: GardenCompileContext
  ): Promise<readonly OfficialApiSignalDraft[]> {
    if (this.extractor === null) {
      throw new GardenProviderError("Official garden provider credentials are missing.", "auth");
    }

    const userPrompt = JSON.stringify({
      workspace_id: context.workspace_id,
      run_id: context.run_id,
      surface_id: context.surface_id,
      turn_content: turnContent,
      turn_messages: context.turn_messages
    });
    let rawJson: string | null = null;
    let extractorMeta: OfficialApiExtractorMeta | null = null;
    try {
      const extractor = this.extractor;
      const requestTimeoutMs = this.requestTimeoutMs;
      const response = await withWallClockTimeout(
        async (signal) =>
          extractor.extract({
            systemPrompt: OFFICIAL_API_SYSTEM_PROMPT,
            userPrompt,
            timeoutMs: requestTimeoutMs,
            abortSignal: signal
          }),
        { budgetMs: this.wallClockBudgetMs }
      );
      rawJson = response.rawJson;
      extractorMeta = response.extractorMeta ?? null;
      return parseOfficialApiSignals(rawJson);
    } catch (error) {
      return this.handleRequestFailure(error, { rawJson, userPrompt, context, extractorMeta });
    }
  }

  private handleRequestFailure(error: unknown, input: {
    readonly rawJson: string | null;
    readonly userPrompt: string;
    readonly context: GardenCompileContext;
    readonly extractorMeta: OfficialApiExtractorMeta | null;
  }): never {
    if (error instanceof WallClockTimeoutError) {
      throw new GardenProviderError(error.message, "network", { cause: error });
    }
    if (!(error instanceof SignalExtractorError) || error.kind === "invalid_json") {
      dumpOfficialApiRequestDiagnostic({
        diagnosticDir: this.diagnosticDir,
        error,
        ...input,
        providerKind: this.provider_kind,
        model: this.model,
        endpoint: this.endpoint,
        now: this.now
      });
    }
    if (error instanceof SignalExtractorError) {
      const invalid = error.kind === "invalid_json";
      throw new GardenProviderError(
        invalid ? "Official garden provider returned an invalid response." : error.message,
        invalid ? "invalid_response" : "network",
        { cause: error }
      );
    }
    throw new GardenProviderError("Official garden provider returned an invalid response.", "invalid_response", {
      cause: error
    });
  }
}
