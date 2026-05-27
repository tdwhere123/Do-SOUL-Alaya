import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  EdgeAutoProducerLlmDecision,
  EdgeAutoProducerLlmPort
} from "@do-soul/alaya-core";

/**
 * @anchor edge-auto-producer-llm-adapter
 *
 * Pair-classifier adapter. Wraps the operator's official-api garden
 * compute config to ask an OpenAI-compatible chat model whether a
 * freshly materialized memory supports / is derived from a candidate
 * neighbor. The verdict (or null) flows back through
 * EdgeAutoProducerService.classifyPair so the proposal queue and the
 * confidence floor (LLM_CONFIDENCE_FLOOR in edge-auto-producer-service.ts)
 * remain the final gate.
 *
 * The transport mirrors apps/core-daemon/src/reconciliation-llm-decision.ts:
 * - garden compute local path only (invariant: no new cloud dependency
 *   may be introduced here — caller resolves the garden secret_ref the
 *   same way the official-api garden provider does)
 * - on-disk decision cache keyed by sha256(model + new fact + neighbor
 *   fact + tags) so a credentialled run populates the cache and later
 *   runs reuse it with zero LLM calls
 * - atomic temp-rename writes so a crash never leaves a truncated entry
 * - malformed / non-ok / timed-out responses degrade to null; the
 *   service then falls back to the local heuristic for that neighbor.
 *
 * see also: apps/core-daemon/src/reconciliation-llm-decision.ts
 * see also: packages/core/src/edge-auto-producer-llm-port.ts
 *
 * anti-patterns-lint-allow: cache + transport helpers structurally
 * mirror reconciliation-llm-decision.ts; extracting a shared
 * garden-llm-cache helper requires touching that file too, which is
 * out of scope here. Tracked for a follow-up commit once both files
 * are in the same write-ownership window.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));

const DECISION_CACHE_ROOT = resolve(
  __dirname,
  "../../../docs/bench-history/datasets/edge-auto-producer-decisions"
);

const DECISION_REQUEST_TIMEOUT_MS = 60_000;

const DECISION_SYSTEM_PROMPT = [
  "You classify the relationship between two memory rows in a memory store.",
  'Return strict JSON only, shape {"edge_type":"supports|derives_from|none","confidence":0..1,"rationale":"..."}, no markdown.',
  "edge_type=supports: the NEW row reinforces / corroborates / co-affirms the NEIGHBOR row about the same target.",
  "edge_type=derives_from: the NEW row is an inference / specialization built ON TOP of the NEIGHBOR row.",
  "edge_type=none: any other relationship, including contradiction, supersession, or unrelated facts.",
  "Never label two rows that assert different things as supports. When unsure, prefer none."
].join(" ");

export interface EdgeAutoProducerLlmAdapterConfig {
  /** OpenAI-compatible chat-completions base URL (…/v1). */
  readonly providerUrl: string;
  /** Chat model id. */
  readonly model: string;
  /** Resolved API key, or null when no garden credentials are configured. */
  readonly apiKey: string | null;
}

interface CachedVerdict {
  readonly model: string;
  readonly request_hash: string;
  readonly edge_type: "supports" | "derives_from" | "none";
  readonly confidence: number;
  readonly rationale: string;
  readonly decided_at: string;
}

interface PairInput {
  readonly newContent: string;
  readonly newTags: readonly string[];
  readonly neighborContent: string;
  readonly neighborTags: readonly string[];
  readonly dimension: string;
  readonly scopeClass: string;
}

/**
 * Build the disk-cached garden-LLM pair-classifier port. Returns null
 * when no garden credentials are configured — the caller then wires
 * EdgeAutoProducerService without an llmPort so the service uses the
 * deterministic local heuristic only. An optional `llmComplete`
 * dependency lets tests stub the transport without touching the network.
 */
export function createEdgeAutoProducerLlmPort(options: {
  readonly config: EdgeAutoProducerLlmAdapterConfig;
  readonly cacheRoot?: string;
  readonly llmComplete?: (
    prompt: string,
    config: EdgeAutoProducerLlmAdapterConfig
  ) => Promise<string>;
}): EdgeAutoProducerLlmPort | null {
  const { config } = options;
  if (config.apiKey === null) {
    return null;
  }
  const cacheRoot = options.cacheRoot ?? DECISION_CACHE_ROOT;
  const llmComplete = options.llmComplete ?? requestVerdictFromGarden;

  return {
    classifyPair: async ({ newMemory, neighbor }) => {
      const pair: PairInput = {
        newContent: newMemory.content,
        newTags: newMemory.domain_tags,
        neighborContent: neighbor.content,
        neighborTags: neighbor.domain_tags,
        dimension: newMemory.dimension,
        scopeClass: newMemory.scope_class
      };
      const requestKey = computeRequestKey(config.model, pair);
      const cached = readCachedVerdict(cacheRoot, requestKey);
      if (cached !== undefined) {
        return materializeDecision(cached.edge_type, cached.confidence, cached.rationale);
      }
      let raw: string;
      try {
        raw = await llmComplete(buildPrompt(pair), config);
      } catch {
        // Transport failure degrades to null. The service falls back to
        // the local heuristic for this neighbor and emits a warn event
        // — we do not duplicate that observability here.
        return null;
      }
      const parsed = parseVerdict(raw);
      // Persist `none` verdicts too: they save just as much budget on a
      // re-ingest of the same pair, and the cache is content-anchored
      // so neighbor re-materialization does not poison it.
      writeCachedVerdict(cacheRoot, requestKey, {
        model: config.model,
        request_hash: requestKey,
        edge_type: parsed.edgeType,
        confidence: parsed.confidence,
        rationale: parsed.rationale,
        decided_at: new Date().toISOString()
      });
      return materializeDecision(parsed.edgeType, parsed.confidence, parsed.rationale);
    }
  };
}

function materializeDecision(
  edgeType: "supports" | "derives_from" | "none",
  confidence: number,
  rationale: string
): EdgeAutoProducerLlmDecision | null {
  if (edgeType === "none") {
    return null;
  }
  return {
    edgeType,
    confidence,
    rationale
  };
}

function buildPrompt(pair: PairInput): string {
  return [
    `Dimension: ${pair.dimension}`,
    `Scope: ${pair.scopeClass}`,
    "",
    "NEW MEMORY:",
    `content: ${pair.newContent}`,
    `tags: ${pair.newTags.join(", ")}`,
    "",
    "NEIGHBOR MEMORY:",
    `content: ${pair.neighborContent}`,
    `tags: ${pair.neighborTags.join(", ")}`
  ].join("\n");
}

function computeRequestKey(model: string, pair: PairInput): string {
  // Field-separator hashing so disjoint splits cannot collide. Tags are
  // sorted so FTS row ordering does not change the key.
  const FIELD_SEPARATOR = "";
  const hash = createHash("sha256");
  hash.update(model, "utf8");
  hash.update(FIELD_SEPARATOR, "utf8");
  hash.update(pair.dimension, "utf8");
  hash.update(FIELD_SEPARATOR, "utf8");
  hash.update(pair.scopeClass, "utf8");
  hash.update(FIELD_SEPARATOR, "utf8");
  hash.update(pair.newContent, "utf8");
  hash.update(FIELD_SEPARATOR, "utf8");
  hash.update([...pair.newTags].sort().join(""), "utf8");
  hash.update(FIELD_SEPARATOR, "utf8");
  hash.update(pair.neighborContent, "utf8");
  hash.update(FIELD_SEPARATOR, "utf8");
  hash.update([...pair.neighborTags].sort().join(""), "utf8");
  return hash.digest("hex");
}

function cacheFilePath(cacheRoot: string, requestKey: string): string {
  return join(cacheRoot, requestKey.slice(0, 2), `${requestKey}.json`);
}

function readCachedVerdict(cacheRoot: string, requestKey: string): CachedVerdict | undefined {
  const filePath = cacheFilePath(cacheRoot, requestKey);
  if (!existsSync(filePath)) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as Partial<CachedVerdict>;
    if (
      parsed.edge_type !== "supports" &&
      parsed.edge_type !== "derives_from" &&
      parsed.edge_type !== "none"
    ) {
      return undefined;
    }
    const confidence = typeof parsed.confidence === "number" ? parsed.confidence : 0;
    return {
      model: typeof parsed.model === "string" ? parsed.model : "",
      request_hash: typeof parsed.request_hash === "string" ? parsed.request_hash : requestKey,
      edge_type: parsed.edge_type,
      confidence,
      rationale: typeof parsed.rationale === "string" ? parsed.rationale : "",
      decided_at: typeof parsed.decided_at === "string" ? parsed.decided_at : ""
    };
  } catch {
    return undefined;
  }
}

function writeCachedVerdict(cacheRoot: string, requestKey: string, entry: CachedVerdict): void {
  const filePath = cacheFilePath(cacheRoot, requestKey);
  mkdirSync(dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${randomUUID()}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(entry, null, 2)}\n`, "utf8");
  renameSync(tempPath, filePath);
}

function parseVerdict(rawJson: string): {
  edgeType: "supports" | "derives_from" | "none";
  confidence: number;
  rationale: string;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    return { edgeType: "none", confidence: 0, rationale: "non-json response" };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { edgeType: "none", confidence: 0, rationale: "non-object response" };
  }
  const record = parsed as {
    readonly edge_type?: unknown;
    readonly confidence?: unknown;
    readonly rationale?: unknown;
  };
  const edgeType =
    record.edge_type === "supports" || record.edge_type === "derives_from"
      ? record.edge_type
      : "none";
  const confidence =
    typeof record.confidence === "number" && Number.isFinite(record.confidence)
      ? record.confidence
      : 0;
  const rationale = typeof record.rationale === "string" ? record.rationale : "";
  return { edgeType, confidence, rationale };
}

async function requestVerdictFromGarden(
  prompt: string,
  config: EdgeAutoProducerLlmAdapterConfig
): Promise<string> {
  if (config.apiKey === null) {
    throw new Error("garden API key is unavailable");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DECISION_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${normalizeBaseUrl(config.providerUrl)}/chat/completions`, {
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
          { role: "system", content: DECISION_SYSTEM_PROMPT },
          { role: "user", content: prompt }
        ]
      }),
      signal: controller.signal
    });
    if (!response.ok) {
      throw new Error(
        `garden edge auto producer pair classifier HTTP ${response.status} ${response.statusText}`
      );
    }
    const payload = (await response.json()) as {
      readonly choices?: readonly { readonly message?: { readonly content?: unknown } }[];
    };
    const content = payload.choices?.[0]?.message?.content;
    if (typeof content !== "string" || content.trim().length === 0) {
      throw new Error("garden edge auto producer pair classifier returned no content");
    }
    return content;
  } finally {
    clearTimeout(timer);
  }
}

function normalizeBaseUrl(url: string): string {
  const trimmed = url.trim().replace(/\/+$/u, "");
  return trimmed.endsWith("/chat/completions")
    ? trimmed.slice(0, -"/chat/completions".length)
    : trimmed;
}
