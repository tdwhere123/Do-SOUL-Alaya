import { OFFICIAL_API_SOURCE_PACKET_SYSTEM_PROMPT, parseOfficialApiSourcePacketRequest,
  type OfficialApiSourcePacketRequest } from "./official-api/source-packet-request.js";
import { receiveOfficialApiSourcePacket, completeEmptyOfficialApiSourcePacket } from "./official-api/source-packet-receive.js";
import { ExtractionSourcePackingSchema, DEFAULT_EXTRACTION_SOURCE_PACKING, type ExtractionSourcePacking } from "@do-soul/alaya-protocol";
import {
  AlayaError,
  GardenProviderKind as GardenProviderKinds,
  type GardenProviderKind as GardenProviderKindValue,
  type CertifiedQueryOsfGraph,
  type OpenSemanticFactorGraphProposal,
  type QueryFactFrameOsfObligation,
  type CandidateMemorySignal,
  type ConversationMessage,
  type SourceLocatedInterpretation
} from "@do-soul/alaya-protocol";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import {
  SignalExtractorError,
  type SignalExtractor
} from "../extraction/pi-mono-extractor.js";
import {
  WallClockTimeoutError,
  withWallClockTimeout
} from "../scheduling/wall-clock-timeout.js";
import {
  normalizeOptionalString,
  normalizePositiveTimeoutMs
} from "./official-api-signal-parser.js";
import {
  createOfficialApiGardenCompileReceipt,
  type OfficialApiGardenCompileReceipt
} from "./official-api/request-result.js";
import {
  receiveOfficialApiSourceInterpretations,
  type OfficialApiInterpretationEntryRejection
} from "./official-api/source-interpretation-receive.js";
import { emitLocatedInterpretationSignals } from "./official-api/source-interpretation-signal.js";
import { buildOfficialApiSourceCorpus } from "../triage/grounding/source-locator.js";
import {
  planOfficialApiExtractionWindow,
  stringifyOfficialApiExtractionRequest,
  type OfficialApiExtractionRequest,
  type SourceAssertionCatalogCursor,
  type SourceAssertionCatalogPage
} from "./official-api/extraction-request.js";
import {
  dumpOfficialApiRequestDiagnostic,
  type OfficialApiExtractorMeta
} from "./official-api/request-diagnostic.js";
import { OFFICIAL_API_SYSTEM_PROMPT } from "./official-api/system-prompt.js";
import {
  createOpenSemanticFactorQueryCompiler,
  type OpenSemanticFactorQueryCompiler
} from "../extraction/semantic-factors/query-compiler.js";

export const GardenProviderKind = GardenProviderKinds;
export type GardenProviderKind = GardenProviderKindValue;

export interface GardenCompileContext {
  readonly workspace_id: string;
  readonly run_id: string;
  readonly surface_id: string | null;
  readonly turn_messages: readonly ConversationMessage[];
  readonly allow_legacy_single_user_source?: boolean;
  readonly source_observed_at?: string;
  /** Source-id used by Core publication; must match the admitted retained source. */
  readonly artifact_key?: string;
  readonly source_observation?: NonNullable<CandidateMemorySignal["source_observation"]>;
}

export interface GardenComputeProvider {
  readonly provider_kind: GardenProviderKind;
  compile(turnContent: string, context: GardenCompileContext): Promise<readonly CandidateMemorySignal[]>;
  extractSourcePacket?(request: OfficialApiSourcePacketRequest, input: Readonly<{ sourceCorpus: string; artifactKey: string }>):
    Promise<ReturnType<typeof receiveOfficialApiSourcePacket>>;
  extractOpenSemanticFactors?(
    sourceKind: "evidence" | "query",
    sourceText: string
  ): Promise<Readonly<OpenSemanticFactorGraphProposal> | null>;
  extractCertifiedQueryOpenSemanticFactors?(
    sourceText: string,
    obligation: Readonly<QueryFactFrameOsfObligation>
  ): Promise<Readonly<CertifiedQueryOsfGraph> | null>;
}

type GardenProviderErrorKind = "auth" | "network" | "provider_failure" | "invalid_response";

interface OfficialApiGardenProviderDependencies {
  readonly sourcePacking?: ExtractionSourcePacking;
  readonly apiKey?: string | null;
  readonly model?: string | null;
  readonly endpoint?: string | null;
  readonly requestTimeoutMs?: number;
  // invariant: outer wall-clock budget. Defaults to readTimeoutMs + 30s.
  // Test seam.
  // see also: packages/soul/src/garden/scheduling/wall-clock-timeout.ts
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

export class OfficialApiGardenCompileIncompleteError extends GardenProviderError {
  public readonly receipt: OfficialApiGardenCompileReceipt;
  public readonly signals: readonly CandidateMemorySignal[];
  public readonly located: readonly SourceLocatedInterpretation[];

  public constructor(
    receipt: OfficialApiGardenCompileReceipt,
    options?: {
      readonly cause?: unknown;
      readonly signals?: readonly CandidateMemorySignal[];
      readonly located?: readonly SourceLocatedInterpretation[];
    }
  ) {
    super(
      "Official garden compile is incomplete.",
      "invalid_response",
      options?.cause === undefined ? undefined : { cause: options.cause }
    );
    this.name = "OfficialApiGardenCompileIncompleteError";
    this.receipt = receipt;
    this.signals = Object.freeze([...(options?.signals ?? [])]);
    this.located = Object.freeze([...(options?.located ?? [])]);
  }
}
const DEFAULT_OFFICIAL_API_REQUEST_TIMEOUT_MS = 10_000;
// invariant: outer wall-clock budget = read timeout + grace. Read timeout
// drives the inner SDK abort; wall-clock catches stale sockets the monotonic
// timer cannot detect after host suspend.
// see also: packages/soul/src/garden/scheduling/wall-clock-timeout.ts
const WALL_CLOCK_OUTER_GRACE_MS = 30_000;
function wallClockBudgetFor(readTimeoutMs: number): number {
  return readTimeoutMs + WALL_CLOCK_OUTER_GRACE_MS;
}
export const OFFICIAL_API_GARDEN_MODEL = "gpt-4.1-mini";
export const OFFICIAL_API_SOURCE_GROUNDING_SEMANTICS_VERSION =
  "official-api-source-grounding-v5";

export class OfficialApiGardenProvider implements GardenComputeProvider {
  public readonly provider_kind = GardenProviderKind.OFFICIAL_API;
  private readonly sourcePacking: ExtractionSourcePacking;
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
    this.sourcePacking = ExtractionSourcePackingSchema.parse(deps.sourcePacking ?? DEFAULT_EXTRACTION_SOURCE_PACKING);
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
    if (turnContent.trim().length === 0) return [];
    const createdAt = this.now();
    const materialize = (located: readonly SourceLocatedInterpretation[]) =>
      this.emitLocatedSignals(located, context, createdAt);
    try {
      return materialize(await this.extractSourceInterpretations(turnContent, context));
    } catch (error) {
      if (!(error instanceof OfficialApiGardenCompileIncompleteError)) {
        throw error;
      }
      throw new OfficialApiGardenCompileIncompleteError(error.receipt, {
        cause: error,
        signals: materialize(error.located)
      });
    }
  }

  /** Extract proposals without publishing source-bound memory candidates. */
  public async extractSourceInterpretations(
    turnContent: string,
    context: GardenCompileContext
  ): Promise<readonly SourceLocatedInterpretation[]> {
    const normalizedTurnContent = turnContent.trim();
    if (normalizedTurnContent.length === 0) return [];
    if (this.apiKey === null && !this.canUseCredentiallessCacheExtractor) {
      throw new GardenProviderError("Official garden provider credentials are missing.", "auth");
    }
    // Incomplete reception retains the existing typed receipt and located proposals;
    // malformed or unknown reception must never become a successful empty result.
    return this.requestInterpretations(normalizedTurnContent, context);
  }

  /** Explicit packet capability; the legacy compile/signals path retains its recorded v1 meaning. */
  public async extractSourcePacket(requestValue: OfficialApiSourcePacketRequest,
    input: Readonly<{ sourceCorpus: string; artifactKey: string }>) {
    const request = parseOfficialApiSourcePacketRequest(requestValue);
    if (request.source_request.source_assertions.length === 0) return completeEmptyOfficialApiSourcePacket(request,
      { ...input, producerId: `official-api:${this.model}` }).received;
    if (this.extractor === null || (this.apiKey === null && !this.canUseCredentiallessCacheExtractor)) {
      throw new GardenProviderError("Official garden provider credentials are missing.", "auth");
    }
    const receive = (rawJson: string) => receiveOfficialApiSourcePacket(rawJson, request,
      { ...input, producerId: `official-api:${this.model}` });
    const response = await withWallClockTimeout((signal) => this.extractor!.extract({
      systemPrompt: OFFICIAL_API_SOURCE_PACKET_SYSTEM_PROMPT, userPrompt: JSON.stringify(request),
      timeoutMs: this.requestTimeoutMs, abortSignal: signal, sourceCorpus: input.sourceCorpus,
      validateRawJson: (rawJson) => { receive(rawJson); },
      responseSchemaRetryInstruction: "Return the exact source-interpretation-response-v2 envelope required by this request."
    }), { budgetMs: this.wallClockBudgetMs });
    return receive(response.rawJson);
  }

  public async extractOpenSemanticFactors(
    _sourceKind: "evidence" | "query",
    _sourceText: string
  ): Promise<Readonly<OpenSemanticFactorGraphProposal> | null> {
    return null;
  }

  public async extractCertifiedQueryOpenSemanticFactors(
    sourceText: string,
    obligation: Readonly<QueryFactFrameOsfObligation>
  ): Promise<Readonly<CertifiedQueryOsfGraph> | null> {
    if (this.queryCompiler === null) {
      throw new GardenProviderError("Official garden provider credentials are missing.", "auth");
    }
    return await this.queryCompiler.compile(sourceText, obligation);
  }

  private emitLocatedSignals(
    located: readonly SourceLocatedInterpretation[],
    context: GardenCompileContext,
    createdAt: string
  ): readonly CandidateMemorySignal[] {
    const sourceObservation = context.source_observation;
    if (sourceObservation === undefined) {
      throw new GardenProviderError(
        "Official garden compile requires admitted source observation.",
        "invalid_response"
      );
    }
    return emitLocatedInterpretationSignals({
      located,
      workspaceId: context.workspace_id,
      runId: context.run_id,
      surfaceId: context.surface_id,
      createdAt,
      sourceObservation,
      generateSignalId: this.generateSignalId,
      scopeHint: "project"
    });
  }

  private async requestInterpretations(
    turnContent: string,
    context: GardenCompileContext
  ): Promise<readonly SourceLocatedInterpretation[]> {
    if (this.extractor === null) {
      throw new GardenProviderError("Official garden provider credentials are missing.", "auth");
    }

    const sourceCorpus = buildOfficialApiSourceCorpus(turnContent, context.turn_messages);
    const located: SourceLocatedInterpretation[] = [];
    const rejections: OfficialApiInterpretationEntryRejection[] = [];
    const unsent: OfficialApiExtractionRequest[] = [];
    let failedRequest: OfficialApiExtractionRequest | null = null;
    let incompleteError: unknown = null;
    let partialReceive = false;
    let cursor: SourceAssertionCatalogCursor | null | undefined;
    let catalog: SourceAssertionCatalogPage | undefined;
    let stopped = false;
    let previousCursorId: number | undefined;

    do {
      if (cursor != null) {
        if (cursor.after_assertion_id === previousCursorId) {
          throw new TypeError("catalog cursor did not advance");
        }
        previousCursorId = cursor.after_assertion_id;
      }
      const window = planOfficialApiExtractionWindow(
        turnContent, context.turn_messages, this.sourcePacking, cursor
      );
      if (!stopped) catalog = window.catalog;
      for (const request of window.requests) {
        if (stopped) {
          unsent.push(request);
          continue;
        }
        try {
          const received = await this.requestInterpretationBatch(request, context, sourceCorpus);
          located.push(...received.located);
          rejections.push(...received.rejections);
          // Parser isolation of malformed siblings is not a compile abort.
          // Request-bound mismatches and empty partials stay incomplete.
          if (received.status !== "complete" &&
              (received.rejections.length > 0 || received.located.length === 0)) {
            partialReceive = true;
            stopped = true;
            catalog = window.catalog;
          }
        } catch (error) {
          if (error instanceof GardenProviderError && error.kind === "auth") {
            throw error;
          }
          incompleteError = error;
          failedRequest = request;
          stopped = true;
          catalog = window.catalog;
        }
      }
      cursor = window.catalog.next_cursor;
    } while (cursor !== null);

    if (catalog === undefined) {
      throw new TypeError("official API compile produced no catalog page");
    }
    if (incompleteError !== null && located.length === 0 && !partialReceive && unsent.length === 0) {
      throw incompleteError;
    }
    if (partialReceive || incompleteError !== null) {
      throw new OfficialApiGardenCompileIncompleteError(
        createOfficialApiGardenCompileReceipt({
          drafts: [],
          rejections,
          pending: [
            ...(failedRequest === null ? [] : [failedRequest]),
            ...unsent
          ],
          catalog
        }),
        {
          ...(incompleteError === null ? {} : { cause: incompleteError }),
          located
        }
      );
    }
    return Object.freeze(located);
  }

  private async requestInterpretationBatch(
    request: OfficialApiExtractionRequest,
    context: GardenCompileContext,
    sourceCorpus: string
  ) {
    if (this.extractor === null) {
      throw new GardenProviderError("Official garden provider credentials are missing.", "auth");
    }
    let rawJson: string | null = null;
    let extractorMeta: OfficialApiExtractorMeta | null = null;
    const userPrompt = stringifyOfficialApiExtractionRequest(request);
    const artifactKey = context.artifact_key ??
      `garden-compile:${context.workspace_id}:${context.run_id}`;
    const receive = (value: string) => receiveOfficialApiSourceInterpretations(value, request, {
      sourceCorpus,
      artifactKey
    });
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
            sourceCorpus,
            validateRawJson: (value: string) => {
              const received = receive(value);
              if (received.status !== "complete" && received.located.length === 0) {
                throw new Error("official API request receive is incomplete");
              }
            }
          }),
        { budgetMs: this.wallClockBudgetMs }
      );
      rawJson = response.rawJson;
      extractorMeta = response.extractorMeta ?? null;
      return receive(rawJson);
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
