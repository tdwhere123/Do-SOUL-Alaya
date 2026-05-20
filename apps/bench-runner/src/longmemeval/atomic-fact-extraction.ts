import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveSecretRef } from "@do-soul/alaya";
import type {
  SeededMemoryResult,
  SeedObjectKind
} from "../harness/daemon.js";

/**
 * @anchor longmemeval-atomic-fact-extraction
 *
 * Field-standard ingestion for the LongMemEval bench seed path: each
 * haystack turn is LLM-extracted into a list of atomic, self-contained
 * declarative facts (one assertion per fact, pronouns/dates resolved to
 * absolute form). The runner seeds one `memory_entry` per fact, passing
 * the fact as `proposeMemory(... { distilledFact })`.
 *
 * Extraction runs at seed/ingest time only — never at recall time.
 *
 * Repeatability: extraction is cached to an on-disk fixture keyed by a
 * hash of (model + turn content). The fixture directory is EMPTY on a
 * fresh checkout — it is not pre-populated. The first credentialled
 * bench run extracts via the garden LLM and writes the fixture; that
 * fixture must then be committed. Only after it is committed does a
 * later run (including CI and other contributors) reuse it with zero
 * LLM calls and become one-click repeatable. Until the fixture is
 * committed, a fresh checkout with credentials re-extracts live, and a
 * fresh checkout without credentials takes the deterministic no-LLM
 * single-fact fallback (see the `config.apiKey === null` branch in
 * `extract`) — those two paths produce different ingestion granularity.
 *
 * see also: apps/bench-runner/src/harness/daemon.ts proposeMemory
 * see also: packages/soul/src/garden/compute-provider.ts — the garden
 *   LLM provider this path mirrors (OpenAI-compatible chat completions).
 */

const __dirname = dirname(fileURLToPath(import.meta.url));

// The cache fixture lives beside the pinned dataset metadata under
// docs/bench-history/datasets so that, once a credentialled run has
// populated it, it can be committed and shared — the same repeatable-
// fixture discipline used by the pinned dataset meta. The directory is
// created lazily by writeCachedFacts on the first credentialled run; it
// is empty (absent) until then.
const ATOMIC_FACT_CACHE_ROOT = resolve(
  __dirname,
  "../../../../docs/bench-history/datasets/longmemeval-atomic-facts"
);

const GARDEN_SECRET_REF_ENV = "ALAYA_OFFICIAL_GARDEN_SECRET_REF";
const GARDEN_MODEL_ENV = "OFFICIAL_API_GARDEN_MODEL";
const GARDEN_PROVIDER_URL_ENV = "OFFICIAL_API_GARDEN_PROVIDER_URL";

const DEFAULT_GARDEN_MODEL = "gpt-5.4-mini";
const DEFAULT_GARDEN_PROVIDER_URL = "https://yunwu.ai/v1";
const EXTRACTION_REQUEST_TIMEOUT_MS = 60_000;
const MAX_FACTS_PER_TURN = 24;
const MAX_FACT_CHARS = 2_000;

const EXTRACTION_SYSTEM_PROMPT = [
  "You extract atomic facts from a single conversation turn for a memory store.",
  "Return strict JSON only, shape {\"facts\":[\"...\",\"...\"]}, no markdown.",
  "Each fact must be a self-contained declarative sentence carrying exactly one assertion.",
  "Resolve every pronoun, relative date, and reference to its absolute form using the turn text.",
  "Preserve every concrete detail (names, numbers, dates, places) that appears in the turn.",
  "Do not invent facts and do not summarize away detail; split compound statements into separate facts.",
  "Return {\"facts\":[]} only when the turn carries no declarative content (e.g. a bare acknowledgement)."
].join(" ");

export interface AtomicFactExtractionConfig {
  /** OpenAI-compatible chat-completions base URL (…/v1). */
  readonly providerUrl: string;
  /** Chat model id. */
  readonly model: string;
  /** Resolved API key, or null when no garden credentials are configured. */
  readonly apiKey: string | null;
}

export interface AtomicFactExtractionStats {
  /** Turns whose facts were served from the on-disk cache fixture. */
  cacheHits: number;
  /** Turns that triggered a live LLM extraction call. */
  llmCalls: number;
  /** Turns that fell back to the no-LLM single-fact path. */
  offlineFallbacks: number;
  /** Total atomic facts produced across all turns. */
  factsProduced: number;
}

export interface AtomicFactExtractor {
  readonly config: AtomicFactExtractionConfig;
  readonly stats: AtomicFactExtractionStats;
  /**
   * Extract the atomic-fact list for one turn. Cache-first; on a miss
   * calls the garden LLM (when credentials exist) and writes the fixture;
   * when no credentials exist, returns the full turn as a single fact.
   */
  extract(turnContent: string): Promise<readonly string[]>;
}

/**
 * Resolve garden LLM configuration from the process environment. When the
 * secret ref is absent or unresolvable, `apiKey` is null and extraction
 * falls back to the deterministic no-LLM path.
 */
export function resolveAtomicFactExtractionConfig(
  env: NodeJS.ProcessEnv = process.env
): AtomicFactExtractionConfig {
  const providerUrl = normalizeBaseUrl(
    readNonEmpty(env[GARDEN_PROVIDER_URL_ENV]) ?? DEFAULT_GARDEN_PROVIDER_URL
  );
  const model = readNonEmpty(env[GARDEN_MODEL_ENV]) ?? DEFAULT_GARDEN_MODEL;
  const secretRef = readNonEmpty(env[GARDEN_SECRET_REF_ENV]);
  if (secretRef === undefined) {
    return { providerUrl, model, apiKey: null };
  }
  const resolved = resolveSecretRef(secretRef);
  if ("value" in resolved) {
    return { providerUrl, model, apiKey: resolved.value };
  }
  return { providerUrl, model, apiKey: null };
}

/**
 * Build a turn-level atomic-fact extractor. The optional `llmComplete`
 * dependency is for tests; production passes nothing and the extractor
 * uses the garden HTTP path.
 */
export function createAtomicFactExtractor(options?: {
  readonly config?: AtomicFactExtractionConfig;
  readonly cacheRoot?: string;
  readonly llmComplete?: (
    turnContent: string,
    config: AtomicFactExtractionConfig
  ) => Promise<readonly string[]>;
}): AtomicFactExtractor {
  const config = options?.config ?? resolveAtomicFactExtractionConfig();
  const cacheRoot = options?.cacheRoot ?? ATOMIC_FACT_CACHE_ROOT;
  const llmComplete = options?.llmComplete ?? requestAtomicFactsFromGarden;
  const stats: AtomicFactExtractionStats = {
    cacheHits: 0,
    llmCalls: 0,
    offlineFallbacks: 0,
    factsProduced: 0
  };

  async function extract(turnContent: string): Promise<readonly string[]> {
    const normalized = turnContent.trim();
    if (normalized.length === 0) {
      return [];
    }

    const cacheKey = computeCacheKey(config.model, normalized);
    const cached = readCachedFacts(cacheRoot, cacheKey);
    if (cached !== undefined) {
      stats.cacheHits += 1;
      stats.factsProduced += cached.length;
      return cached;
    }

    // invariant: no garden credentials => deterministic no-LLM fallback.
    // The full turn becomes a single atomic fact. This is honest (no
    // fabricated split), repeatable, and strictly better than the rule
    // distiller's first-2-sentences truncation. The LLM multi-fact path
    // activates only when credentials are present.
    if (config.apiKey === null) {
      stats.offlineFallbacks += 1;
      const facts = sanitizeFacts([normalized], normalized);
      stats.factsProduced += facts.length;
      return facts;
    }

    let facts: readonly string[];
    try {
      const raw = await llmComplete(normalized, config);
      facts = sanitizeFacts(raw, normalized);
      stats.llmCalls += 1;
    } catch (error) {
      // A single failed extraction must not abort a 500-question bench.
      // Fall back to the full turn so the answer text stays seeded.
      stats.offlineFallbacks += 1;
      process.stderr.write(
        `[longmemeval atomic-fact] extraction failed, using full-turn fallback: ${stringifyError(error)}\n`
      );
      facts = sanitizeFacts([normalized], normalized);
      stats.factsProduced += facts.length;
      return facts;
    }

    writeCachedFacts(cacheRoot, cacheKey, {
      model: config.model,
      turn_content_hash: cacheKey,
      facts,
      extracted_at: new Date().toISOString()
    });
    stats.factsProduced += facts.length;
    return facts;
  }

  return { config, stats, extract };
}

interface CachedAtomicFacts {
  readonly model: string;
  readonly turn_content_hash: string;
  readonly facts: readonly string[];
  readonly extracted_at: string;
}

function computeCacheKey(model: string, turnContent: string): string {
  return createHash("sha256")
    .update(model, "utf8")
    .update(":", "utf8")
    .update(turnContent, "utf8")
    .digest("hex");
}

function cacheFilePath(cacheRoot: string, cacheKey: string): string {
  // Shard by the first two hex chars so a 500-question haystack does not
  // dump tens of thousands of files into one directory.
  return join(cacheRoot, cacheKey.slice(0, 2), `${cacheKey}.json`);
}

function readCachedFacts(
  cacheRoot: string,
  cacheKey: string
): readonly string[] | undefined {
  const filePath = cacheFilePath(cacheRoot, cacheKey);
  if (!existsSync(filePath)) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as CachedAtomicFacts;
    if (!Array.isArray(parsed.facts)) {
      return undefined;
    }
    return parsed.facts.filter(
      (fact): fact is string => typeof fact === "string" && fact.trim().length > 0
    );
  } catch {
    return undefined;
  }
}

function writeCachedFacts(
  cacheRoot: string,
  cacheKey: string,
  entry: CachedAtomicFacts
): void {
  const filePath = cacheFilePath(cacheRoot, cacheKey);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(entry, null, 2)}\n`, "utf8");
}

/**
 * Normalize an extracted fact list: trim, drop empties, cap fact length
 * and fact count, dedupe. Falls back to the full turn when extraction
 * yields nothing usable so the answer text always survives ingest.
 */
function sanitizeFacts(
  rawFacts: readonly string[],
  turnContent: string
): readonly string[] {
  const seen = new Set<string>();
  const cleaned: string[] = [];
  for (const candidate of rawFacts) {
    if (typeof candidate !== "string") {
      continue;
    }
    const trimmed = candidate.trim();
    if (trimmed.length === 0) {
      continue;
    }
    const capped =
      trimmed.length > MAX_FACT_CHARS ? trimmed.slice(0, MAX_FACT_CHARS) : trimmed;
    const dedupeKey = capped.toLowerCase();
    if (seen.has(dedupeKey)) {
      continue;
    }
    seen.add(dedupeKey);
    cleaned.push(capped);
    if (cleaned.length >= MAX_FACTS_PER_TURN) {
      break;
    }
  }
  if (cleaned.length === 0) {
    const fallback = turnContent.trim();
    return fallback.length === 0
      ? []
      : [fallback.length > MAX_FACT_CHARS ? fallback.slice(0, MAX_FACT_CHARS) : fallback];
  }
  return Object.freeze(cleaned);
}

/**
 * Live garden LLM call: OpenAI-compatible POST /chat/completions with a
 * JSON-object response format. Mirrors the official garden provider's
 * transport (packages/soul/src/garden/compute-provider.ts) without a new
 * client dependency.
 */
async function requestAtomicFactsFromGarden(
  turnContent: string,
  config: AtomicFactExtractionConfig
): Promise<readonly string[]> {
  if (config.apiKey === null) {
    throw new Error("garden API key is unavailable");
  }
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    EXTRACTION_REQUEST_TIMEOUT_MS
  );
  try {
    const response = await fetch(`${config.providerUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.apiKey}`
      },
      body: JSON.stringify({
        model: config.model,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: EXTRACTION_SYSTEM_PROMPT },
          { role: "user", content: turnContent }
        ]
      }),
      signal: controller.signal
    });
    if (!response.ok) {
      throw new Error(
        `garden extraction HTTP ${response.status} ${response.statusText}`
      );
    }
    const payload = (await response.json()) as {
      readonly choices?: readonly {
        readonly message?: { readonly content?: unknown };
      }[];
    };
    const content = payload.choices?.[0]?.message?.content;
    if (typeof content !== "string" || content.trim().length === 0) {
      throw new Error("garden extraction returned no content");
    }
    return parseFactList(content);
  } finally {
    clearTimeout(timer);
  }
}

function parseFactList(rawJson: string): readonly string[] {
  const parsed = JSON.parse(rawJson) as unknown;
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !Array.isArray((parsed as { readonly facts?: unknown }).facts)
  ) {
    throw new Error("garden extraction response missing facts array");
  }
  return (parsed as { readonly facts: readonly unknown[] }).facts.map((fact) =>
    typeof fact === "string" ? fact : String(fact)
  );
}

function normalizeBaseUrl(url: string): string {
  const trimmed = url.trim().replace(/\/+$/u, "");
  return trimmed.endsWith("/chat/completions")
    ? trimmed.slice(0, -"/chat/completions".length)
    : trimmed;
}

function readNonEmpty(value: string | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function stringifyError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

/** Minimal daemon surface this helper needs — keeps it test-stubbable. */
export interface AtomicFactSeedDaemon {
  proposeMemory(
    content: string,
    evidenceRef: string,
    options?: {
      readonly objectKind?: SeedObjectKind;
      readonly distilledFact?: string;
    }
  ): Promise<SeededMemoryResult>;
}

export interface AtomicFactSeedResult {
  /** One SeededMemoryResult per extracted atomic fact (N per turn). */
  readonly seeds: readonly SeededMemoryResult[];
  /**
   * Whether THIS turn's source content exceeded the seed content cap.
   * Truncation is a property of the turn, not of each extracted fact:
   * every fact of one turn carries the same full `turnContent` as
   * evidence, so the daemon flags `truncated` identically for all N
   * seeds. This boolean is counted once per turn so the bench report.md
   * truncation diagnostics reflect turns, not the fact fan-out factor.
   */
  readonly turnTruncated: boolean;
  /** Chars clipped from this turn's content (counted once, not per fact). */
  readonly charsClipped: number;
}

/**
 * Seed one haystack turn as N atomic-fact `memory_entry` rows.
 *
 * The turn is extracted into a fact list, then `proposeMemory` is called
 * once per fact: the fact is passed as `distilledFact` (it becomes
 * `memory_entry.content`) and the original turn is passed as the evidence
 * `content` (it remains reachable through the evidence capsule). Returns
 * every `SeededMemoryResult` so the caller maps ALL N object_ids back to
 * the source answer turn — a partial map silently undercounts recall.
 *
 * `soul.emit_candidate_signal` stays 1:1: N facts produce N independent
 * proposeMemory calls; no signal schema changes.
 */
export async function seedTurnAsAtomicFacts(input: {
  readonly daemon: AtomicFactSeedDaemon;
  readonly extractor: AtomicFactExtractor;
  readonly turnContent: string;
  readonly evidenceRefBase: string;
  readonly objectKind: SeedObjectKind;
}): Promise<AtomicFactSeedResult> {
  const facts = await input.extractor.extract(input.turnContent);
  const seeds: SeededMemoryResult[] = [];
  let turnTruncated = false;
  let charsClipped = 0;
  for (let factIndex = 0; factIndex < facts.length; factIndex++) {
    const fact = facts[factIndex];
    if (fact === undefined) {
      continue;
    }
    // invariant: every fact gets a distinct evidence_ref so the audit
    // trail and the per-fact materialized object_id stay 1:1.
    const evidenceRef =
      facts.length === 1
        ? input.evidenceRefBase
        : `${input.evidenceRefBase}-f${factIndex}`;
    const seed = await input.daemon.proposeMemory(input.turnContent, evidenceRef, {
      objectKind: input.objectKind,
      distilledFact: fact
    });
    seeds.push(seed);
    // Truncation is keyed on the turn's source content, which is the
    // same string for every fact of this turn — record it once instead
    // of summing it N times across the fact fan-out.
    if (seed.truncated) {
      turnTruncated = true;
      charsClipped = seed.charsClipped;
    }
  }
  return { seeds, turnTruncated, charsClipped };
}
