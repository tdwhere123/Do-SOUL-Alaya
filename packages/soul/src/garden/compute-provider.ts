import {
  AlayaError,
  CandidateMemorySignalSchema,
  GardenProviderKind as GardenProviderKinds,
  type GardenProviderKind as GardenProviderKindValue,
  type OpenSemanticFactorGraphProposal,
  readErrorMessage,
  type CandidateMemorySignal,
  type ConversationMessage
} from "@do-soul/alaya-protocol";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import {
  SignalExtractorError,
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
  inspectObservedTemporalProjection,
  normalizeSourceObservedAt
} from "./temporal/observed-projection.js";
import { buildOfficialCandidateSignal } from "./official-api/signal-payload.js";
import {
  groundOfficialApiDraft,
  rejectOfficialApiDraftGrounding
} from "./official-api/source-grounding.js";
import { buildOfficialApiSourceCorpus } from "./grounding/source-locator.js";
import {
  buildOfficialApiExtractionRequests,
  stringifyOfficialApiExtractionRequest,
  type OfficialApiExtractionRequest
} from "./official-api/extraction-request.js";
import {
  dumpOfficialApiRequestDiagnostic,
  type OfficialApiExtractorMeta
} from "./official-api/request-diagnostic.js";
import { assessOfficialApiSourceTrust } from "./official-api/source-trust.js";
import { OFFICIAL_API_SYSTEM_PROMPT } from "./official-api/system-prompt.js";
import {
  createOpenSemanticFactorQueryCompiler,
  type OpenSemanticFactorQueryCompiler
} from "./semantic-factors/query-compiler.js";

export {
  OFFICIAL_API_SIGNAL_PARSER_SEMANTICS_VERSION,
  parseOfficialApiSemanticFactorGraphProjectionAudit,
  parseOfficialApiSignals,
  salvageRawSignalElements
} from "./official-api-signal-parser.js";
export type {
  OfficialApiSemanticFactorGraphProjectionAudit,
  OfficialApiSemanticFactorGraphProjectionReason,
  OfficialApiSignalDraft
} from "./official-api-signal-parser.js";
export {
  OFFICIAL_API_FORMATION_AUDIT_SEMANTICS_VERSION,
  auditOfficialApiSignalFormation,
  type OfficialApiSignalAuditDisposition,
  type OfficialApiSignalAuditStage,
  type OfficialApiSignalFormationAuditEntry,
  type OfficialApiSignalFormationAuditInput,
  type OfficialApiSignalFormationAuditResult
} from "./official-api/formation-audit.js";
export {
  OFFICIAL_API_SIGNAL_CONTRACT_VERSION,
  OFFICIAL_API_SOURCE_ASSERTION_REPAIR_SYSTEM_PROMPT,
  OFFICIAL_API_SYSTEM_PROMPT,
  resolveOfficialApiSystemPrompt
} from "./official-api/system-prompt.js";
export {
  OFFICIAL_API_EXTRACTION_ASSERTIONS_PER_BATCH,
  OFFICIAL_API_EXTRACTION_BATCH_CONTRACT_VERSION,
  OFFICIAL_API_EXTRACTION_REQUEST_SCHEMA_VERSION,
  buildOfficialApiExtractionRequest,
  buildOfficialApiExtractionRequests,
  computeOfficialApiSourceCorpusIdentity,
  parseOfficialApiExtractionRequest,
  stringifyOfficialApiExtractionRequest,
  type OfficialApiExtractionRequest
} from "./official-api/extraction-request.js";

export const GardenProviderKind = GardenProviderKinds;
export type GardenProviderKind = GardenProviderKindValue;

export interface GardenCompileContext {
  readonly workspace_id: string;
  readonly run_id: string;
  readonly surface_id: string | null;
  readonly turn_messages: readonly ConversationMessage[];
  readonly allow_legacy_single_user_source?: boolean;
  readonly source_observed_at?: string;
}

export interface GardenComputeProvider {
  readonly provider_kind: GardenProviderKind;
  compile(turnContent: string, context: GardenCompileContext): Promise<readonly CandidateMemorySignal[]>;
  extractOpenSemanticFactors?(
    sourceKind: "evidence" | "query",
    sourceText: string
  ): Promise<Readonly<OpenSemanticFactorGraphProposal> | null>;
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
  /** Allows a credentialless provider only for an explicitly injected cache reader. */
  readonly injectedExtractorCapability?: "cache_only";
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
export const OFFICIAL_API_SOURCE_GROUNDING_SEMANTICS_VERSION =
  "official-api-source-grounding-v3";

export class OfficialApiGardenProvider implements GardenComputeProvider {
  public readonly provider_kind = GardenProviderKind.OFFICIAL_API;
  private readonly apiKey: string | null;
  private readonly model: string;
  private readonly endpoint: string | null;
  private readonly requestTimeoutMs: number;
  private readonly wallClockBudgetMs: number;
  private readonly extractor: SignalExtractor | null;
  private readonly queryCompiler: OpenSemanticFactorQueryCompiler | null;
  private readonly canUseCredentiallessCacheExtractor: boolean;
  private readonly now: () => string;
  private readonly generateSignalId: () => string;
  // Absolute directory for invalid_response diagnostic dumps, or null when
  // dumps are disabled. Resolved once at construction so
  // a later cwd change does not retarget the dump file mid-run.
  private readonly diagnosticDir: string | null;

  public constructor(deps: OfficialApiGardenProviderDependencies = {}) {
    this.apiKey = normalizeOptionalString(deps.apiKey ?? null);
    this.canUseCredentiallessCacheExtractor =
      deps.injectedExtractorCapability === "cache_only";
    if (this.canUseCredentiallessCacheExtractor && deps.extractor === undefined) {
      throw new TypeError(
        "cache-only official garden capability requires an injected extractor"
      );
    }
    this.model = normalizeOptionalString(deps.model) ?? OFFICIAL_API_GARDEN_MODEL;
    this.endpoint = normalizeOptionalString(deps.endpoint);
    this.requestTimeoutMs = normalizePositiveTimeoutMs(deps.requestTimeoutMs) ?? DEFAULT_OFFICIAL_API_REQUEST_TIMEOUT_MS;
    this.wallClockBudgetMs =
      normalizePositiveTimeoutMs(deps.wallClockBudgetMs) ??
      wallClockBudgetFor(this.requestTimeoutMs);
    this.extractor = deps.extractor ?? null;
    if (this.extractor === null && this.apiKey !== null &&
        !this.canUseCredentiallessCacheExtractor) {
      throw new TypeError("OfficialApiGardenProvider requires an injected extractor");
    }
    this.queryCompiler = this.extractor === null
      ? null
      : createOpenSemanticFactorQueryCompiler({
        extractor: this.extractor,
        timeoutMs: this.requestTimeoutMs,
        wallClockBudgetMs: this.wallClockBudgetMs
      });
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

    if (this.apiKey === null && !this.canUseCredentiallessCacheExtractor) {
      throw new GardenProviderError("Official garden provider credentials are missing.", "auth");
    }

    const sourceCorpus = buildOfficialApiSourceCorpus(normalizedTurnContent, context.turn_messages);
    const drafts = await this.requestSignals(normalizedTurnContent, context);
    const createdAt = normalizeSourceObservedAt(context.source_observed_at) ?? this.now();

    const signals: CandidateMemorySignal[] = [];
    for (const draft of drafts) {
      const signal = this.buildSignalFromDraft(
        draft,
        context,
        normalizedTurnContent,
        sourceCorpus,
        createdAt
      );
      if (signal !== null) {
        signals.push(signal);
      }
    }

    return Object.freeze(signals);
  }

  public async extractOpenSemanticFactors(
    sourceKind: "evidence" | "query",
    sourceText: string
  ): Promise<Readonly<OpenSemanticFactorGraphProposal> | null> {
    if (sourceKind !== "query") return null;
    if (this.queryCompiler === null) {
      throw new GardenProviderError("Official garden provider credentials are missing.", "auth");
    }
    return await this.queryCompiler.compile(sourceText);
  }

  private buildSignalFromDraft(
    draft: OfficialApiSignalDraft,
    context: GardenCompileContext,
    normalizedTurnContent: string,
    sourceCorpus: string,
    createdAt: string
  ): CandidateMemorySignal | null {
    const { groundingSourceText, grounding } = groundDraftForContext(
      draft, context, normalizedTurnContent, sourceCorpus
    );
    const groundedDraft = grounding.draft;
    const confidence = clampConfidence(groundedDraft.confidence);
    const temporalSelection = grounding.status === "grounded"
      ? inspectObservedTemporalProjection(
          groundedDraft.matched_text,
          groundedDraft.temporal_projection,
          context.source_observed_at,
          groundedDraft.temporal_projection_audit
        )
      : undefined;
    try {
      return CandidateMemorySignalSchema.parse(buildOfficialCandidateSignal({
        draft: groundedDraft,
        workspaceId: context.workspace_id,
        runId: context.run_id,
        surfaceId: context.surface_id,
        normalizedTurnContent,
        turnMessages: context.turn_messages,
        groundingSourceText,
        confidence,
        temporalProjection: temporalSelection?.projection,
        temporalProjectionAudit: temporalSelection?.audit,
        distilledFact: groundedDraft.distilled_fact,
        providerKind: this.provider_kind,
        signalId: this.generateSignalId(),
        createdAt,
        sourceObservedAt: normalizeSourceObservedAt(context.source_observed_at) ?? createdAt,
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

    const requests = buildOfficialApiExtractionRequests(turnContent, context.turn_messages);
    const drafts: OfficialApiSignalDraft[] = [];
    for (const request of requests) {
      drafts.push(...await this.requestSignalBatch(request, context));
    }
    return Object.freeze(drafts);
  }

  private async requestSignalBatch(
    request: OfficialApiExtractionRequest,
    context: GardenCompileContext
  ): Promise<readonly OfficialApiSignalDraft[]> {
    if (this.extractor === null) {
      throw new GardenProviderError("Official garden provider credentials are missing.", "auth");
    }
    let rawJson: string | null = null;
    let extractorMeta: OfficialApiExtractorMeta | null = null;
    const userPrompt = stringifyOfficialApiExtractionRequest(request);
    try {
      const extractor = this.extractor;
      const requestTimeoutMs = this.requestTimeoutMs;
      const response = await withWallClockTimeout(
        async (signal) =>
          extractor.extract({
            systemPrompt: OFFICIAL_API_SYSTEM_PROMPT,
            userPrompt,
            timeoutMs: requestTimeoutMs,
            abortSignal: signal,
            validateRawJson: (value: string) => {
              parseBoundedBatchSignals(value, request);
            }
          }),
        { budgetMs: this.wallClockBudgetMs }
      );
      rawJson = response.rawJson;
      extractorMeta = response.extractorMeta ?? null;
      return parseBoundedBatchSignals(rawJson, request);
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

function parseBoundedBatchSignals(
  rawJson: string,
  request: OfficialApiExtractionRequest
): readonly OfficialApiSignalDraft[] {
  const drafts = parseOfficialApiSignals(rawJson, { requireSemanticFactorGraph: true });
  const allowedIds = new Set(request.source_assertions.map(({ assertion_id }) => assertion_id));
  if (drafts.some(({ source_locator }) =>
    source_locator !== undefined && !allowedIds.has(source_locator.assertion_id)
  )) {
    throw new Error("official API signal locator is outside its bounded assertion batch");
  }
  return drafts;
}

function groundDraftForContext(
  draft: OfficialApiSignalDraft,
  context: GardenCompileContext,
  normalizedTurnContent: string,
  sourceCorpus: string
): Readonly<{
  groundingSourceText: string;
  grounding: ReturnType<typeof groundOfficialApiDraft>;
}> {
  const groundingSourceText = draft.source_locator === undefined
    ? normalizedTurnContent
    : sourceCorpus;
  const trustRejection = assessOfficialApiSourceTrust({
    hasSourceLocator: draft.source_locator !== undefined,
    turnContent: normalizedTurnContent,
    turnMessages: context.turn_messages,
    ...(context.allow_legacy_single_user_source === undefined ? {} : {
      allowLegacySingleUserSource: context.allow_legacy_single_user_source
    })
  });
  const grounding = trustRejection === null
    ? groundOfficialApiDraft(draft, groundingSourceText, sourceCorpus)
    : rejectOfficialApiDraftGrounding(draft, trustRejection);
  if (grounding.status === "rejected") {
    console.warn("garden/compute-provider: rejected ungrounded official-API signal", {
      runId: context.run_id,
      reasons: grounding.audit.reasons
    });
  }
  return { groundingSourceText, grounding };
}
