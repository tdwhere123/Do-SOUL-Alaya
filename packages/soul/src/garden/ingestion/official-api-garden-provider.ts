import {
  AlayaError, GardenProviderKind as GardenProviderKinds,
  type GardenProviderKind as GardenProviderKindValue, type ExtractionSourcePacking,
  type CertifiedQueryOsfGraph, type OpenSemanticFactorGraphProposal, type QueryFactFrameOsfObligation,
  type CandidateMemorySignal, type ConversationMessage, type SourceStatementReceipt
} from "@do-soul/alaya-protocol";
import { randomUUID } from "node:crypto";
import type { SignalExtractor } from "../extraction/pi-mono-extractor.js";
import { withWallClockTimeout } from "../scheduling/wall-clock-timeout.js";
import { normalizeOptionalString, normalizePositiveTimeoutMs } from "./official-api-signal-parser.js";
import { createOpenSemanticFactorQueryCompiler, type OpenSemanticFactorQueryCompiler } from "../extraction/semantic-factors/query-compiler.js";
import { extractSourceStatementSession, type SourceStatementSessionEvent } from "./source-statements.js";
import { emitSourceStatementSignals, sourceStatementSessionInput } from "./source-statement-signals.js";

export const GardenProviderKind = GardenProviderKinds;
export type GardenProviderKind = GardenProviderKindValue;
export interface GardenCompileContext {
  readonly workspace_id: string;
  readonly run_id: string;
  readonly surface_id: string | null;
  readonly turn_messages: readonly ConversationMessage[];
  readonly allow_legacy_single_user_source?: boolean;
  readonly source_observed_at?: string;
  readonly artifact_key?: string;
  readonly source_root_id?: string;
  readonly source_observation?: CandidateMemorySignal["source_observation"];
}
export interface GardenComputeProvider {
  readonly provider_kind: GardenProviderKind;
  compile(turnContent: string, context: GardenCompileContext): Promise<readonly CandidateMemorySignal[]>;
  extractOpenSemanticFactors?(sourceKind: "evidence" | "query", sourceText: string): Promise<Readonly<OpenSemanticFactorGraphProposal> | null>;
  extractCertifiedQueryOpenSemanticFactors?(sourceText: string, obligation: Readonly<QueryFactFrameOsfObligation>): Promise<Readonly<CertifiedQueryOsfGraph> | null>;
}
type GardenProviderErrorKind = "auth" | "network" | "provider_failure" | "invalid_response";
interface OfficialApiGardenProviderDependencies {
  readonly sourcePacking?: ExtractionSourcePacking;
  readonly apiKey?: string | null;
  readonly model?: string | null;
  readonly endpoint?: string | null;
  readonly requestTimeoutMs?: number;
  readonly wallClockBudgetMs?: number;
  readonly extractor?: SignalExtractor;
  readonly injectedExtractorCapability?: "cache_only";
  readonly now?: () => string;
  readonly generateSignalId?: () => string;
  readonly diagnosticDir?: string | null;
  readonly recordSession?: (event: SourceStatementSessionEvent) => void | Promise<void>;
}
export class GardenProviderError extends AlayaError {
  public readonly kind: GardenProviderErrorKind;
  public constructor(message: string, kind: GardenProviderErrorKind, options?: { readonly cause?: unknown }) {
    super(kind, message, options); this.name = "GardenProviderError"; this.kind = kind;
  }
}
export class OfficialApiGardenCompileIncompleteError extends GardenProviderError {
  public readonly signals: readonly CandidateMemorySignal[];
  public constructor(public readonly receipt: SourceStatementReceipt,
    options?: { readonly cause?: unknown; readonly signals?: readonly CandidateMemorySignal[] }) {
    super("Official garden session compilation is incomplete.", "invalid_response", options);
    this.name = "OfficialApiGardenCompileIncompleteError";
    this.signals = Object.freeze([...(options?.signals ?? [])]);
  }
}
export const OFFICIAL_API_GARDEN_MODEL = "gpt-4.1-mini";
export const OFFICIAL_API_SOURCE_GROUNDING_SEMANTICS_VERSION = "official-api-source-statements-v1";

/** Ordinary conversation extraction has exactly one session contract. Explicit H/Q/C is separate. */
export class OfficialApiGardenProvider implements GardenComputeProvider {
  public readonly provider_kind = GardenProviderKind.OFFICIAL_API;
  private readonly extractor: SignalExtractor | null;
  private readonly authorized: boolean;
  private readonly requestTimeoutMs: number;
  private readonly wallClockBudgetMs: number;
  private readonly queryCompiler: OpenSemanticFactorQueryCompiler | null;
  private readonly now: () => string;
  private readonly generateSignalId: () => string;
  private readonly recordSession: OfficialApiGardenProviderDependencies["recordSession"];
  public constructor(deps: OfficialApiGardenProviderDependencies = {}) {
    this.extractor = deps.extractor ?? null;
    this.authorized = normalizeOptionalString(deps.apiKey) !== null || deps.injectedExtractorCapability === "cache_only";
    if (deps.injectedExtractorCapability === "cache_only" && this.extractor === null) throw new TypeError("cache-only provider requires an injected extractor");
    if (this.authorized && this.extractor === null) throw new TypeError("OfficialApiGardenProvider requires an injected extractor");
    this.requestTimeoutMs = normalizePositiveTimeoutMs(deps.requestTimeoutMs) ?? 10000;
    this.wallClockBudgetMs = normalizePositiveTimeoutMs(deps.wallClockBudgetMs) ?? this.requestTimeoutMs + 30000;
    this.now = deps.now ?? (() => new Date().toISOString());
    this.generateSignalId = deps.generateSignalId ?? randomUUID;
    this.recordSession = deps.recordSession;
    this.queryCompiler = this.extractor === null ? null : createOpenSemanticFactorQueryCompiler({
      extractor: this.extractor, timeoutMs: this.requestTimeoutMs, wallClockBudgetMs: this.wallClockBudgetMs
    });
  }

  public async extractSourceStatements(_turnContent: string, context: GardenCompileContext): Promise<SourceStatementReceipt> {
    if (!this.authorized || this.extractor === null) throw new GardenProviderError("Official garden provider credentials are missing.", "auth");
    if (context.turn_messages.length === 0) throw new GardenProviderError("Conversation extraction requires host message identities.", "invalid_response");
    const source = sourceStatementSessionInput(context.turn_messages);
    const extract = this.extractor.extract.bind(this.extractor);
    let transportFailure: unknown;
    const receipt = await extractSourceStatementSession({ session_id: context.run_id, messages: source.messages,
      request_ceiling: source.messages.length, record: this.recordSession,
      transport: async request => {
        let result: Awaited<ReturnType<SignalExtractor["extract"]>>;
        try { result = await withWallClockTimeout(signal => extract({
          systemPrompt: request.systemPrompt, userPrompt: request.userPrompt,
          timeoutMs: this.requestTimeoutMs, abortSignal: signal, sourceCorpus: source.rendered.content,
          rawResponse: true, retryMode: "disabled"
        }), { budgetMs: this.wallClockBudgetMs }); }
        catch (cause) { transportFailure = cause; throw cause; }
        return { rawJson: result.rawJson,
          ...("extractionSkip" in result && result.extractionSkip === "plan_skipped" ? { skipped: true } : {}),
          ...(result.usage === undefined ? {} : {
          usage: { input_tokens: result.usage.inputTokens, output_tokens: result.usage.outputTokens }
        }) };
      }
    });
    if (transportFailure !== undefined) throw new OfficialApiGardenCompileIncompleteError(receipt, { cause: transportFailure });
    return receipt;
  }

  public async compile(turnContent: string, callerContext: GardenCompileContext): Promise<readonly CandidateMemorySignal[]> {
    const context = { ...callerContext, turn_messages: structuredClone(callerContext.turn_messages),
      source_observation: callerContext.source_observation == null ? callerContext.source_observation : { ...callerContext.source_observation } };
    if (turnContent.trim().length === 0 && context.turn_messages.length === 0) return [];
    if (context.artifact_key === undefined || context.source_root_id === undefined) {
      throw new GardenProviderError("Official garden compile requires admitted host source binding.", "invalid_response");
    }
    let receipt: SourceStatementReceipt, cause: unknown;
    try { receipt = await this.extractSourceStatements(turnContent, context); }
    catch (error) {
      if (!(error instanceof OfficialApiGardenCompileIncompleteError)) throw error;
      receipt = error.receipt; cause = error.cause;
    }
    const signals = emitSourceStatementSignals({ receipt, messages: context.turn_messages, artifactKey: context.artifact_key,
      sourceRootId: context.source_root_id,
      workspaceId: context.workspace_id, runId: context.run_id, surfaceId: context.surface_id, createdAt: this.now(),
      sourceObservation: context.source_observation ?? null, generateSignalId: this.generateSignalId });
    if (receipt.status !== "complete") throw new OfficialApiGardenCompileIncompleteError(receipt, { signals, cause });
    return signals;
  }
  public async extractOpenSemanticFactors(_sourceKind: "evidence" | "query", _sourceText: string): Promise<Readonly<OpenSemanticFactorGraphProposal> | null> {
    return null;
  }
  public async extractCertifiedQueryOpenSemanticFactors(sourceText: string,
    obligation: Readonly<QueryFactFrameOsfObligation>): Promise<Readonly<CertifiedQueryOsfGraph> | null> {
    if (!this.authorized || this.queryCompiler === null) throw new GardenProviderError("Official garden provider credentials are missing.", "auth");
    return this.queryCompiler.compile(sourceText, obligation);
  }
}
