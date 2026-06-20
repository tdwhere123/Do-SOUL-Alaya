import {
  CandidateMemorySignalSchema,
  GardenProviderKind as GardenProviderKinds,
  type GardenProviderKind as GardenProviderKindValue,
  SignalSource,
  readErrorMessage,
  type CandidateMemorySignal,
  type ConversationMessage
} from "@do-soul/alaya-protocol";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import {
  SignalExtractorError,
  createPiMonoExtractor,
  type SignalExtractor
} from "./pi-mono-extractor.js";
import { buildSchemaGroundedRawPayload } from "./schema-grounding.js";
import {
  WallClockTimeoutError,
  withWallClockTimeout
} from "./wall-clock-timeout.js";
import {
  buildTurnExcerpt,
  clampConfidence,
  clampFullTurnContent,
  normalizeOptionalString,
  normalizePositiveTimeoutMs,
  parseOfficialApiSignals,
  type OfficialApiSignalDraft
} from "./official-api-signal-parser.js";
import {
  extractHeadersFromCauseChain,
  extractRecoveryKindFromInputs,
  extractRetryClassificationFromInputs,
  extractRetryCountFromInputs,
  extractSignalErrorDiagnostic,
  extractStatusFromCauseChain
} from "./compute-provider-diagnostics.js";

export { parseOfficialApiSignals, salvageRawSignalElements } from "./official-api-signal-parser.js";
export type { OfficialApiSignalDraft } from "./official-api-signal-parser.js";

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
const DIAGNOSTIC_BODY_PREFIX_MAX_CHARS = 4_096;
const DIAGNOSTIC_PROMPT_PREFIX_MAX_CHARS = 512;

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
    const createdAt = this.now();

    const signals: CandidateMemorySignal[] = [];
    let distilledFactOmittedCount = 0;
    for (const draft of drafts) {
      const confidence = clampConfidence(draft.confidence);
      // Observability: a draft with no distilled_fact makes
      // materialization-router/inputs.ts buildDistilledFact degrade to its rule
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
                // materialization-router/inputs.ts buildDistilledFact reads this
                // key when present; an absent value (model omitted it)
                // falls through to that file's rule distiller. Never write
                // a faked span here.
                ...(draft.distilled_fact === undefined
                  ? {}
                  : { distilled_fact: draft.distilled_fact }),
                provider_kind: this.provider_kind,
                extraction_reason: draft.reason ?? "official_api",
                turn_content_excerpt: buildTurnExcerpt(normalizedTurnContent, draft.matched_text),
                // reader keys on full_turn_content (inputs.ts buildEvidenceInput
                // widening); clamp keeps raw_payload under the 16 KB cap.
                full_turn_content: clampFullTurnContent(normalizedTurnContent)
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
          error: readErrorMessage(error, "unknown error")
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

    const userPrompt = JSON.stringify({
      workspace_id: context.workspace_id,
      run_id: context.run_id,
      surface_id: context.surface_id,
      turn_content: turnContent,
      turn_messages: context.turn_messages
    });
    let rawJson: string | null = null;
    let extractorMeta:
      | {
          readonly recoveryKind: string;
          readonly retryCount: number;
          readonly retryClassification?: string;
        }
      | null = null;
    try {
      // invariant: outer wall-clock guard. Inner timeoutMs drives the SDK's
      // monotonic-clock abort; wall-clock fires after suspend-aware grace if
      // the inner timer was frozen by host suspend.
      // see also: packages/soul/src/garden/wall-clock-timeout.ts withWallClockTimeout
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
      // Only the invalid_response branch — JSON shape failure on the body the
      // extractor returned, OR a SignalExtractorError of kind "invalid_json"
      // (empty/oversized/non-JSON content). Both are what the bench preflight
      // blocker rejects as `invalid_response`; the dump tells the diagnostic
      // reader whether the model truncated, the provider returned chat noise,
      // or the cache shard was torn. Network/timeout errors
      // skip the dump — they are observable from the bench log already
      // and the body is empty by definition.
      // invariant: wall-clock timeout is a network-class failure, not an
      // invalid_response. Body was never read; skip the diagnostic dump.
      if (error instanceof WallClockTimeoutError) {
        throw new GardenProviderError(error.message, "network", { cause: error });
      }
      const isInvalidResponse =
        !(error instanceof SignalExtractorError) ||
        error.kind === "invalid_json";
      if (isInvalidResponse) {
        // await so a preflight reading the dump immediately after sees the
        // file — but a dump that itself throws (e.g. read-only fs)
        // must not mask the real provider error.
        await this.dumpInvalidResponseDiagnostic({
          error,
          rawJson,
          userPrompt,
          context,
          extractorMeta
        });
      }
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

  /**
   * Best-effort diagnostic dump of one invalid_response failure. Writes
   * status (if surfaced via the cause chain) / response body
   * prefix / SignalExtractorError kind+message / user-prompt prefix / model /
   * provider kind / timestamp to a per-failure JSON file. Atomic (tmp + rename
   * on the same filesystem). Returns even if writing fails — observation must
   * never destabilize the production failure path.
   */
  private async dumpInvalidResponseDiagnostic(input: {
    readonly error: unknown;
    readonly rawJson: string | null;
    readonly userPrompt: string;
    readonly context: GardenCompileContext;
    // invariant: surfaces tryRecoverJson branch + extractor retry attempt
    // count + retry terminal classification when the body parsed but the
    // post-extract envelope shape was wrong. Null when extract() threw
    // before returning meta.
    readonly extractorMeta:
      | {
          readonly recoveryKind: string;
          readonly retryCount: number;
          readonly retryClassification?: string;
        }
      | null;
  }): Promise<void> {
    if (this.diagnosticDir === null) {
      return;
    }
    try {
      const timestamp = this.now();
      const envelope = {
        captured_at: timestamp,
        provider_kind: this.provider_kind,
        model_id: this.model,
        endpoint: this.endpoint,
        workspace_id: input.context.workspace_id,
        run_id: input.context.run_id,
        surface_id: input.context.surface_id,
        signal_extractor_error: extractSignalErrorDiagnostic(input.error),
        // HTTP status / headers are not surfaced through SignalExtractorError;
        // the pi-mono extractor swallows them. We capture whatever the cause
        // chain exposes (status, statusText, headers if present) so a future
        // transport wrapper that does pass them through gets recorded
        // automatically — the dump shape is forward-compatible.
        response_status: extractStatusFromCauseChain(input.error),
        response_headers: extractHeadersFromCauseChain(input.error),
        response_body_prefix:
          input.rawJson === null
            ? null
            : input.rawJson.slice(0, DIAGNOSTIC_BODY_PREFIX_MAX_CHARS),
        response_body_total_chars: input.rawJson === null ? null : input.rawJson.length,
        user_prompt_prefix: input.userPrompt.slice(
          0,
          DIAGNOSTIC_PROMPT_PREFIX_MAX_CHARS
        ),
        // invariant: recovery branch + retry attempts + retry classification.
        // recovery_kind is "none" when strict JSON parsed first try;
        // "markdown_strip" / "trailing_strip" / "balanced_close" when the
        // body was salvaged. extractor_retry_count is the count of
        // additional attempts beyond the first (0 = no retry, N = retried N
        // times). retry_classification labels the terminal outcome of the
        // retry loop (success_first_try / success_after_retry /
        // failure_max_retries / failure_non_retryable_4xx / failure_timeout
        // / failure_aborted) so a dump consumer can distinguish a partial
        // recovery from a chronic failure without re-deriving from
        // retry_count + error kind. Pulled from extractorMeta when the
        // extract() call succeeded; else from SignalExtractorError when the
        // typed error surfaced.
        recovery_kind: extractRecoveryKindFromInputs(input.extractorMeta, input.error),
        extractor_retry_count: extractRetryCountFromInputs(input.extractorMeta, input.error),
        retry_classification: extractRetryClassificationFromInputs(input.extractorMeta, input.error)
      };
      const fileName = `${timestamp.replace(/[:.]/gu, "-")}-${randomUUID()}.json`;
      const filePath = join(this.diagnosticDir, fileName);
      mkdirSync(dirname(filePath), { recursive: true });
      // Atomic write: tmp + rename guards against an interrupted dump
      // (WSL2 OOM is a known crash mode in this env) leaving a torn file
      // a reader would mis-parse.
      const tmpPath = `${filePath}.${randomUUID()}.tmp`;
      writeFileSync(tmpPath, `${JSON.stringify(envelope, null, 2)}\n`, "utf8");
      renameSync(tmpPath, filePath);
    } catch (dumpError) {
      // observation-only — never mask the real exception by throwing here.
      // A single warn is enough; a chronically-failing dump path is the
      // operator's problem, not the extraction caller's.
      console.warn("garden/compute-provider: diagnostic dump failed", {
        error: readErrorMessage(dumpError, "unknown error")
      });
    }
  }
}
