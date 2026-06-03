import {
  CandidateMemorySignalSchema,
  GardenProviderKind as GardenProviderKinds,
  type GardenProviderKind as GardenProviderKindValue,
  SignalKind,
  SignalSource,
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
import { DISTILLED_FACT_MAX_CHARS } from "./materialization-router.js";
import {
  WallClockTimeoutError,
  withWallClockTimeout
} from "./wall-clock-timeout.js";

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
  // Phase A.1 instrument: when set, a requestSignals invalid_response failure
  // dumps a diagnostic JSON envelope to <diagnosticDir>/<ISO-ts>-<uuid>.json
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
  private readonly wallClockBudgetMs: number;
  private readonly extractor: SignalExtractor | null;
  private readonly now: () => string;
  private readonly generateSignalId: () => string;
  // Phase A.1 instrument: absolute directory for invalid_response diagnostic
  // dumps, or null when dumps are disabled. Resolved once at construction so
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
      // Phase A.1 instrument: only the invalid_response branch — JSON shape
      // failure on the body the extractor returned, OR a SignalExtractorError
      // of kind "invalid_json" (empty/oversized/non-JSON content). Both are
      // what the bench preflight blocker rejects as `invalid_response`; the
      // dump tells A.3 whether the model truncated, the provider returned
      // chat noise, or the cache shard was torn. Network/timeout errors
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
        // await so a Phase A.2 preflight reading the dump immediately after
        // sees the file — but a dump that itself throws (e.g. read-only fs)
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
   * Phase A.1 instrument: best-effort diagnostic dump of one invalid_response
   * failure. Writes status (if surfaced via the cause chain) / response body
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
      // a Phase A.2 reader would mis-parse.
      const tmpPath = `${filePath}.${randomUUID()}.tmp`;
      writeFileSync(tmpPath, `${JSON.stringify(envelope, null, 2)}\n`, "utf8");
      renameSync(tmpPath, filePath);
    } catch (dumpError) {
      // observation-only — never mask the real exception by throwing here.
      // A single warn is enough; a chronically-failing dump path is the
      // operator's problem, not the extraction caller's.
      console.warn("garden/compute-provider: diagnostic dump failed", {
        error: readErrorMessage(dumpError)
      });
    }
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
  let parsed: unknown;
  try {
    parsed = JSON.parse(content) as unknown;
  } catch {
    // The whole envelope did not parse. One corrupt `signals[]` entry (a bad
    // `\'` escape, a stray `,""}` empty key, an unescaped inner quote, a
    // malformed key missing `":"`, or a max_tokens-truncated final element)
    // otherwise nukes every clean sibling signal. Degrade element-wise: walk
    // the `signals` array, JSON.parse each `{...}` independently, keep the
    // valid entries, drop the corrupt one(s), and tolerate a truncated final
    // element. This is the array-level analogue of the per-entry drop policy
    // applied below after a successful parse — a sibling's corruption is not
    // allowed to abort the turn's good signals.
    return salvageOfficialApiSignals(content);
  }
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

// Element-wise salvage for a `{"signals":[...]}` envelope whose strict
// JSON.parse threw. Reuses parseOfficialApiSignalEntry so every salvaged
// element passes the SAME per-entry validation/drop as the strict path — the
// downstream draft shape is byte-identical. THROWS when zero valid elements
// are recoverable (a degenerate envelope: no `signals` region, or only a
// truncated first/only element) so the caller's existing failure attribution
// (offline_fallbacks + recordExtractionFailureSource) still fires — a corrupt
// degenerate body must NOT masquerade as an empty `{"signals":[]}` extraction.
// see also: salvageRawSignalElements (string-aware balanced-brace walk).
function salvageOfficialApiSignals(content: string): readonly OfficialApiSignalDraft[] {
  const drafts: OfficialApiSignalDraft[] = [];
  for (const element of salvageRawSignalElements(content)) {
    if (drafts.length >= MAX_OFFICIAL_API_SIGNALS) {
      break;
    }
    let candidate: unknown;
    try {
      candidate = JSON.parse(element) as unknown;
    } catch {
      // A single corrupt element (bad escape / unescaped quote / malformed
      // key) — skip it, keep walking the clean siblings.
      continue;
    }
    const draft = parseOfficialApiSignalEntry(candidate);
    if (draft !== null) {
      drafts.push(draft);
    }
  }
  if (drafts.length === 0) {
    throw new Error("signals envelope unparseable and no element recoverable");
  }
  return Object.freeze(drafts);
}

// Walk the `signals` array region of an envelope and return each top-level
// `{...}` element as an independent substring. String-aware (braces inside a
// JSON string literal do not change depth; `\` escapes the next char) so a
// `}` inside `matched_text` never miscounts. A truncated/incomplete FINAL
// element (the array ends before its closing `}`) is dropped — only complete
// balanced elements are returned. Returns [] when no `signals` array region
// is found, so the caller degrades to zero signals (existing fallback).
//
// Exported so the LongMemEval bench seed path can count the RAW salvageable
// element population (lastTurnRawSignalCount) when the strict envelope parse
// fails — otherwise the dropped corrupt entries would vanish from the
// parse-drop attribution instead of landing in parseDropped.
// see also: apps/bench-runner/src/longmemeval/compile-seed.ts
//   countRawEnvelopeSignals
export function salvageRawSignalElements(content: string): readonly string[] {
  const signalsKeyIndex = findSignalsArrayStart(content);
  if (signalsKeyIndex < 0) {
    return [];
  }
  const elements: string[] = [];
  let depth = 0;
  let inString = false;
  let escape = false;
  let elementStart = -1;
  for (let i = signalsKeyIndex; i < content.length; i += 1) {
    const ch = content[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\" && inString) {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) {
      continue;
    }
    if (ch === "{") {
      if (depth === 0) {
        elementStart = i;
      }
      depth += 1;
    } else if (ch === "}") {
      if (depth > 0) {
        depth -= 1;
        if (depth === 0 && elementStart >= 0) {
          elements.push(content.slice(elementStart, i + 1));
          elementStart = -1;
        }
      }
    } else if (ch === "]" && depth === 0) {
      // Closing the signals array at top level — no in-flight element.
      break;
    }
  }
  // An element still open (depth > 0 / elementStart set) at end-of-buffer is
  // the truncated final element — intentionally NOT pushed.
  return elements;
}

// Find the index of the `[` that opens the `signals` array, scanning past the
// `"signals"` key. String-aware so a `"signals"` substring inside an earlier
// string value is not mistaken for the key. Returns -1 when not found.
function findSignalsArrayStart(content: string): number {
  const keyMatch = /"signals"\s*:\s*\[/u.exec(content);
  if (keyMatch === null) {
    return -1;
  }
  // Position the walk at the `[` so the first `{` after it starts element 0.
  return keyMatch.index + keyMatch[0].length - 1;
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

interface SignalErrorDiagnostic {
  readonly is_signal_extractor_error: boolean;
  readonly kind: string | null;
  readonly name: string;
  readonly message: string;
  readonly cause_message: string | null;
}

type ExtractorMetaSnapshot = {
  readonly recoveryKind: string;
  readonly retryCount: number;
  readonly retryClassification?: string;
};

function extractRecoveryKindFromInputs(
  meta: ExtractorMetaSnapshot | null,
  _error: unknown
): string {
  if (meta !== null) {
    return meta.recoveryKind;
  }
  // No meta available — the extract() call threw before returning. The
  // recovery branch is unknowable in that case; emit "none" so the dump
  // shape stays stable for the Phase A.2 / Phase F readers.
  return "none";
}

function extractRetryCountFromInputs(
  meta: ExtractorMetaSnapshot | null,
  error: unknown
): number {
  if (meta !== null) {
    return meta.retryCount;
  }
  if (error instanceof SignalExtractorError) {
    return error.retryCount;
  }
  return 0;
}

// invariant: the dump envelope's retry_classification field is "unknown"
// only when neither extractorMeta nor a typed SignalExtractorError carries
// the label — happens when a transport error fires before the extractor
// loop even started. The closed enum branches stay in sync with
// RetryClassification in pi-mono-extractor.ts.
function extractRetryClassificationFromInputs(
  meta: ExtractorMetaSnapshot | null,
  error: unknown
): string {
  if (meta?.retryClassification !== undefined) {
    return meta.retryClassification;
  }
  if (error instanceof SignalExtractorError) {
    return error.retryClassification;
  }
  return "unknown";
}

function extractSignalErrorDiagnostic(error: unknown): SignalErrorDiagnostic {
  if (error instanceof SignalExtractorError) {
    const cause = (error as { readonly cause?: unknown }).cause;
    return {
      is_signal_extractor_error: true,
      kind: error.kind,
      name: error.name,
      message: error.message,
      cause_message: cause instanceof Error ? cause.message : null
    };
  }
  if (error instanceof Error) {
    const cause = (error as { readonly cause?: unknown }).cause;
    return {
      is_signal_extractor_error: false,
      kind: null,
      name: error.name,
      message: error.message,
      cause_message: cause instanceof Error ? cause.message : null
    };
  }
  return {
    is_signal_extractor_error: false,
    kind: null,
    name: "UnknownError",
    message: String(error),
    cause_message: null
  };
}

// Walk the .cause chain and surface any numeric HTTP status the transport
// happened to attach. The pi-mono extractor currently does not, but
// createGardenHttpExtractor (bench-runner) throws an Error whose .message
// embeds the status — we read both shapes so the dump captures whichever
// transport raised the failure.
function extractStatusFromCauseChain(error: unknown): number | null {
  let current: unknown = error;
  for (let depth = 0; depth < 4; depth += 1) {
    if (current === null || current === undefined) {
      return null;
    }
    if (typeof current === "object") {
      const candidate = (current as { readonly status?: unknown }).status;
      if (typeof candidate === "number" && Number.isFinite(candidate)) {
        return candidate;
      }
      const messageStatus = readStatusFromMessage(current);
      if (messageStatus !== null) {
        return messageStatus;
      }
      current = (current as { readonly cause?: unknown }).cause;
      continue;
    }
    return null;
  }
  return null;
}

function readStatusFromMessage(value: object): number | null {
  if (!(value instanceof Error)) {
    return null;
  }
  const match = /\bHTTP\s+(\d{3})\b/u.exec(value.message);
  if (match === null) {
    return null;
  }
  const parsed = Number.parseInt(match[1]!, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function extractHeadersFromCauseChain(error: unknown): Record<string, string> | null {
  let current: unknown = error;
  for (let depth = 0; depth < 4; depth += 1) {
    if (current === null || current === undefined) {
      return null;
    }
    if (typeof current === "object") {
      const candidate = (current as { readonly headers?: unknown }).headers;
      const normalized = normalizeHeadersValue(candidate);
      if (normalized !== null) {
        return normalized;
      }
      current = (current as { readonly cause?: unknown }).cause;
      continue;
    }
    return null;
  }
  return null;
}

function normalizeHeadersValue(value: unknown): Record<string, string> | null {
  if (value === null || value === undefined) {
    return null;
  }
  // Web Headers / Node Headers expose .entries(); plain Records expose keys.
  if (typeof value === "object" && typeof (value as { entries?: unknown }).entries === "function") {
    const out: Record<string, string> = {};
    try {
      for (const [key, val] of (value as Iterable<[string, string]>)) {
        if (typeof key === "string" && typeof val === "string") {
          out[key.toLowerCase()] = val;
        }
      }
      return out;
    } catch {
      return null;
    }
  }
  if (typeof value === "object") {
    const out: Record<string, string> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      if (typeof val === "string") {
        out[key.toLowerCase()] = val;
      }
    }
    return Object.keys(out).length > 0 ? out : null;
  }
  return null;
}
