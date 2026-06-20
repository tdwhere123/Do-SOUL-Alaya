import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import type { GardenCompileContext, OfficialApiGardenProvider } from "@do-soul/alaya-soul";
import type { BenchSignalSeedInput } from "../harness/daemon.js";
import { rotatingSeedObjectKind } from "../harness/seed-rotation.js";
import type {
  BenchRetryClassification,
  CompileSeedExtractionStats
} from "./compile-seed-types.js";

const COMPILE_SEED_CACHE_KEY_PREFIX_CHARS = 12;

type SeedInputDraft = Omit<BenchSignalSeedInput, "evidenceRef">;

type ExtractSeedInputsInput = {
  readonly provider: OfficialApiGardenProvider | null;
  readonly stats: CompileSeedExtractionStats;
  readonly turnContent: string;
  readonly seedIndex: number;
  readonly context: GardenCompileContext;
  // Absolute path or null when diagnostic dumps are disabled.
  readonly diagnosticDir?: string | null;
  readonly modelId?: string;
  readonly providerKind?: string;
};

type OfficialCompileSignals = Awaited<ReturnType<OfficialApiGardenProvider["compile"]>>;

export async function extractSeedInputs(
  input: ExtractSeedInputsInput
): Promise<readonly SeedInputDraft[]> {
  const provider = input.provider;
  if (provider === null) {
    return buildNoCredentialsFallback(input);
  }

  const signals = await compileOfficialSeedSignals(input, provider);
  recordOfficialSignalDrops(input.stats, signals.length);
  const drafts = buildOfficialSeedDrafts(input, signals);
  return drafts.length === 0 ? buildEmptyOfficialFallback(input) : finishSeedDrafts(input, drafts);
}

function buildNoCredentialsFallback(input: ExtractSeedInputsInput): readonly SeedInputDraft[] {
  // invariant: no garden credentials => deterministic no-LLM fallback. The
  // full turn becomes one candidate fact; credentialed extraction failures
  // are not allowed to reuse this degraded path.
  input.stats.offlineFallbacks += 1;
  return finishSeedDrafts(input, [
    buildFullTurnSeedDraft(input, "no_credentials_fallback")
  ]);
}

async function compileOfficialSeedSignals(
  input: ExtractSeedInputsInput,
  provider: OfficialApiGardenProvider
): Promise<OfficialCompileSignals> {
  try {
    return await provider.compile(input.turnContent, input.context);
  } catch (error) {
    recordExtractionFailureSource(input.stats);
    await dumpSeedExtractionFailureDiagnostic({
      diagnosticDir: input.diagnosticDir ?? null,
      stats: input.stats,
      modelId: input.modelId ?? null,
      providerKind: input.providerKind ?? null,
      error,
      context: input.context
    });
    throw error;
  }
}

function recordOfficialSignalDrops(
  stats: CompileSeedExtractionStats,
  signalCount: number
): void {
  const turnParseDropped = Math.max(
    0,
    stats.lastTurnRawSignalCount - stats.lastTurnDraftCount
  );
  const turnCompileOverflowDropped = Math.max(
    0,
    stats.lastTurnDraftCount - signalCount
  );
  stats.parseDropped += turnParseDropped;
  stats.compileOverflowDropped += turnCompileOverflowDropped;
  stats.signalsDropped += turnParseDropped + turnCompileOverflowDropped;
}

function buildOfficialSeedDrafts(
  input: ExtractSeedInputsInput,
  signals: OfficialCompileSignals
): readonly SeedInputDraft[] {
  const drafts: SeedInputDraft[] = [];
  for (const signal of signals) {
    const distilled =
      readRawString(signal.raw_payload, "distilled_fact") ??
      readRawString(signal.raw_payload, "matched_text");
    if (distilled === null) {
      continue;
    }
    const matchedText = readRawString(signal.raw_payload, "matched_text");
    drafts.push({
      signalKind: signal.signal_kind,
      objectKind: signal.object_kind,
      confidence: signal.confidence,
      distilledFact: distilled,
      turnContent: input.turnContent,
      turnSeedIndex: input.seedIndex,
      ...(matchedText === null ? {} : { matchedText }),
      productionRawPayload: stripSchemaGrounding(signal.raw_payload, signal.object_kind),
      extractionProvider: "official_api_compile"
    });
  }
  return drafts;
}

function buildEmptyOfficialFallback(input: ExtractSeedInputsInput): readonly SeedInputDraft[] {
  return finishSeedDrafts(input, [
    buildFullTurnSeedDraft(input, "official_api_compile")
  ]);
}

function buildFullTurnSeedDraft(
  input: ExtractSeedInputsInput,
  extractionProvider: SeedInputDraft["extractionProvider"]
): SeedInputDraft {
  return {
    signalKind: "potential_preference",
    objectKind: rotatingSeedObjectKind(input.seedIndex),
    confidence: 0.9,
    distilledFact: input.turnContent,
    turnContent: input.turnContent,
    turnSeedIndex: input.seedIndex,
    extractionProvider
  };
}

function finishSeedDrafts(
  input: ExtractSeedInputsInput,
  drafts: readonly SeedInputDraft[]
): readonly SeedInputDraft[] {
  input.stats.factsProduced += drafts.length;
  return drafts;
}

function recordExtractionFailureSource(stats: CompileSeedExtractionStats): void {
  if (stats.lastExtractionSource === "cache") {
    stats.cachedExtractionFailures += 1;
    return;
  }
  if (stats.lastExtractionSource === "live") {
    stats.liveExtractionFailures += 1;
  }
}

// invariant: shape mirror of the `benchRetry` field createGardenHttpExtractor
// attaches via wrapBenchTransportError. A SignalExtractorError surfaces the
// same fields via direct properties (retryCount / retryClassification); we
// read whichever is present so a future transport switch keeps the dump
// shape stable.
interface BenchRetrySnapshot {
  readonly retryCount: number;
  readonly retryClassification: BenchRetryClassification;
}

interface SeedExtractionFailureDiagnosticInput {
  readonly diagnosticDir: string | null;
  readonly stats: CompileSeedExtractionStats;
  readonly modelId: string | null;
  readonly providerKind: string | null;
  readonly error: unknown;
  readonly context: GardenCompileContext;
}

function readBenchRetryFromError(error: unknown): BenchRetrySnapshot | null {
  // invariant: depth-limited walk over the .cause chain so a
  // GardenProviderError wrapping the bench HTTP transport error (cause-chain
  // depth 1) still surfaces retry meta to the dump envelope. Two shapes are
  // accepted at each link: `.benchRetry` (the createGardenHttpExtractor
  // wrapBenchTransportError convention) and direct `.retryCount` /
  // `.retryClassification` properties (the SignalExtractorError shape from
  // pi-mono-extractor.ts).
  let current: unknown = error;
  for (let depth = 0; depth < 4; depth += 1) {
    if (current === null || current === undefined) return null;
    if (typeof current !== "object") return null;
    const benchRetry = (current as { benchRetry?: unknown }).benchRetry;
    if (typeof benchRetry === "object" && benchRetry !== null) {
      const retryCount = (benchRetry as { retryCount?: unknown }).retryCount;
      const classification = (benchRetry as { retryClassification?: unknown })
        .retryClassification;
      if (
        typeof retryCount === "number" &&
        Number.isFinite(retryCount) &&
        typeof classification === "string"
      ) {
        return {
          retryCount,
          retryClassification: classification as BenchRetryClassification
        };
      }
    }
    const retryCount = (current as { retryCount?: unknown }).retryCount;
    const classification = (current as { retryClassification?: unknown })
      .retryClassification;
    if (
      typeof retryCount === "number" &&
      Number.isFinite(retryCount) &&
      typeof classification === "string"
    ) {
      return {
        retryCount,
        retryClassification: classification as BenchRetryClassification
      };
    }
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

/**
 * Dump one seed-side extraction failure diagnostic to
 * `<diagnosticDir>/compile-seed-<ISO-ts>-<uuid>.json`. Captures the cache
 * key prefix, model id, provider kind, last-extraction-source classification,
 * and the immediate failure message so a bench preflight can attribute
 * the failure to a specific cache shard or live extraction call without
 * re-running the bench. Observation only — failures inside the dump are
 * caught and surfaced as a single warn so the seed loop continues.
 *
 * Co-located with the provider-side dump in
 * packages/soul/src/garden/compute-provider.ts:dumpInvalidResponseDiagnostic
 * so a single readdir + JSON pass surfaces every signal of the failure.
 */
async function dumpSeedExtractionFailureDiagnostic(
  input: SeedExtractionFailureDiagnosticInput
): Promise<void> {
  if (input.diagnosticDir === null) {
    return;
  }
  try {
    const timestamp = new Date().toISOString();
    writeSeedExtractionFailureDump(
      input.diagnosticDir,
      timestamp,
      buildSeedExtractionFailureEnvelope(input, timestamp)
    );
  } catch (dumpError) {
    process.stderr.write(
      `[longmemeval compile-seed] diagnostic dump failed: ${stringifyError(dumpError)}\n`
    );
  }
}

function buildSeedExtractionFailureEnvelope(
  input: SeedExtractionFailureDiagnosticInput,
  timestamp: string
) {
  const cacheKey = input.stats.lastCacheKey ?? null;
  const benchRetry = readBenchRetryFromError(input.error);
  return {
    captured_at: timestamp,
    surface: "compile-seed",
    provider_kind: input.providerKind,
    model_id: input.modelId,
    workspace_id: input.context.workspace_id,
    run_id: input.context.run_id,
    surface_id: input.context.surface_id,
    cache_key_prefix:
      cacheKey === null ? null : cacheKey.slice(0, COMPILE_SEED_CACHE_KEY_PREFIX_CHARS),
    last_extraction_source: input.stats.lastExtractionSource,
    live_extraction_failures: input.stats.liveExtractionFailures,
    cached_extraction_failures: input.stats.cachedExtractionFailures,
    retry_count: benchRetry?.retryCount ?? null,
    retry_classification: benchRetry?.retryClassification ?? "unknown",
    error_message: stringifyError(input.error)
  };
}

function writeSeedExtractionFailureDump(
  diagnosticDir: string,
  timestamp: string,
  envelope: ReturnType<typeof buildSeedExtractionFailureEnvelope>
): void {
  const fileName = `compile-seed-${timestamp.replace(/[:.]/gu, "-")}-${randomUUID()}.json`;
  const filePath = join(diagnosticDir, fileName);
  mkdirSync(dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${randomUUID()}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(envelope, null, 2)}\n`, "utf8");
  renameSync(tmpPath, filePath);
}

/**
 * Strip the compile()-attached schema-grounding block from a raw_payload so
 * the bench seed signal can be re-grounded against a canonicalized
 * object_kind. The four schema-grounding keys
 * (`schema_grounding` / `detected_object` / `field_candidates` /
 * `validation_result`) pin `detected_object.object_kind` to the ORIGINAL
 * LLM-extracted kind. Once the bench canonicalizes the routing object_kind
 * (canonicalizeSeedObjectKind), keeping that stale block makes
 * signal-service.ts `hasInvalidSchemaGrounding` see
 * `detected_object.object_kind !== signal.object_kind` and defer the signal
 * (no memory_entry). Dropping the block lets completeGardenTask's
 * `normalizeSchemaGroundedSignal` rebuild a consistent block from the
 * canonicalized kind plus the retained `matched_text`.
 *
 * The original kind is preserved under `extracted_object_kind` for audit
 * fidelity so the bench archive still records what the LLM actually chose.
 */
function stripSchemaGrounding(
  rawPayload: Readonly<Record<string, unknown>>,
  extractedObjectKind: string
): Readonly<Record<string, unknown>> {
  const {
    schema_grounding: _schemaGrounding,
    detected_object: _detectedObject,
    field_candidates: _fieldCandidates,
    validation_result: _validationResult,
    ...contentBearing
  } = rawPayload;
  return {
    ...contentBearing,
    extracted_object_kind: extractedObjectKind
  };
}

function readRawString(
  rawPayload: Readonly<Record<string, unknown>>,
  key: string
): string | null {
  const value = rawPayload[key];
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

export function stringifyError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// invariant: normalize ALAYA_SEED_EXTRACTION_DIAG_DIR. Empty strings and
// whitespace are equivalent to unset (the resolver then falls through
// to the cwd-rooted default). A literal "null" / "off" / "disabled" is
// NOT honored here — disabling the dump requires the explicit
// options.diagnosticDir = null wiring, since env-driven disables on a
// release-blocker instrument are too easy to mis-set.
export function normalizeEnvDiagDir(value: string | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}
