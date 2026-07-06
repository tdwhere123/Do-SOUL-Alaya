import { createHash, randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ReconciliationLlmDecisionPort } from "@do-soul/alaya-core";
import { requestGardenChatCompletionContent } from "./garden-chat-completion.js";

/**
 * @anchor reconciliation-llm-decision
 *
 * The ingest-time semantic judge for ingest reconciliation: given an
 * incoming distilled fact and the ambiguous-band candidate neighbors,
 * the garden LLM returns ADD / UPDATE / NOOP. This is the field standard
 * (Mem0 / Zep) — a token-superset heuristic is unsound for "refines vs
 * distinct", so the decision is delegated to an LLM. The LLM is allowed
 * at ingest time (it already runs for atomic-fact extraction); it never
 * runs at recall time.
 *
 * Repeatability: every decision is cached to an on-disk fixture keyed by
 * a hash of (model + incoming fact + neighbor contents) — exactly the
 * caching discipline of the LongMemEval compile-seed extraction cache. A
 * cached decision re-runs with zero LLM calls. The cache directory lives
 * beside the extraction cache under docs/bench-history/datasets and is
 * git-ignored like it: both are regenerable, model-keyed, and not source
 * truth, so a fresh checkout re-populates them from a credentialled run.
 *
 * see also: apps/bench-runner/src/longmemeval/compile-seed.ts
 *   (the extraction cache whose shape this mirrors)
 * see also: packages/core/src/governance/reconciliation-service.ts
 *   (ReconciliationLlmDecisionPort consumer)
 */

const __dirname = dirname(fileURLToPath(import.meta.url));

// Beside the LongMemEval atomic-fact cache, sharing its caching discipline
// and its git-ignore: a credentialled run populates it, later runs in the
// same checkout reuse it with zero LLM calls, and it is not committed
// (regenerable, model-keyed). Created lazily on the first credentialled
// decision.
const RECONCILIATION_DECISION_CACHE_ROOT = resolve(
  __dirname,
  "../../../../docs/bench-history/datasets/reconciliation-decisions"
);

const DECISION_REQUEST_TIMEOUT_MS = 60_000;

const DECISION_SYSTEM_PROMPT = [
  "You reconcile a new atomic fact against existing memory rows for a memory store.",
  "Return strict JSON only, shape {\"kind\":\"add|update|noop\",\"target_object_id\":\"...\",\"reason\":\"...\"}, no markdown.",
  "kind=update: the new fact refines / makes more specific exactly ONE candidate — set target_object_id to that candidate.",
  "kind=noop: the new fact is fully equivalent to a candidate and adds no new information — set target_object_id to it.",
  "kind=add: the new fact asserts something distinct from every candidate — even a same-topic fact about a different attribute is distinct; omit target_object_id.",
  "Never merge two facts that assert different things. When unsure, prefer add."
].join(" ");

export interface ReconciliationLlmDecisionConfig {
  /** OpenAI-compatible chat-completions base URL (…/v1). */
  readonly providerUrl: string;
  /** Chat model id. */
  readonly model: string;
  /** Resolved API key, or null when no garden credentials are configured. */
  readonly apiKey: string | null;
}

interface CachedDecision {
  readonly model: string;
  readonly request_hash: string;
  readonly kind: "add" | "update" | "noop";
  /**
   * The decision target, anchored to the target candidate's CONTENT (a
   * sha256 of its content text), not its object_id. A bare object_id can
   * go stale — the row may have been archived / re-materialized so the
   * id is no longer in the current candidate set. On a cache hit the
   * hash is resolved back to whichever current candidate carries that
   * content; if none does, the target is dropped and the core service
   * degrades the verdict to ADD. `null` for an `add` verdict.
   */
  readonly target_content_hash: string | null;
  readonly reason: string;
  readonly decided_at: string;
}

/**
 * Build the disk-cached garden-LLM reconciliation decision port. The
 * optional `llmComplete` dependency is for tests; production passes
 * nothing and the port uses the garden HTTP path. Returns null when no
 * garden credentials are configured — the caller then runs without
 * reconciliation rather than degrading every fact through a dead port.
 */
export function createReconciliationLlmDecisionPort(options: {
  readonly config: ReconciliationLlmDecisionConfig;
  readonly cacheRoot?: string;
  readonly llmComplete?: (
    prompt: string,
    config: ReconciliationLlmDecisionConfig
  ) => Promise<string>;
}): ReconciliationLlmDecisionPort | null {
  const { config } = options;
  if (config.apiKey === null) {
    return null;
  }
  const cacheRoot = options.cacheRoot ?? RECONCILIATION_DECISION_CACHE_ROOT;
  const llmComplete = options.llmComplete ?? requestDecisionFromGarden;

  return {
    decide: async ({ incomingContent, candidates }) =>
      await decideWithGardenCache(config, cacheRoot, llmComplete, incomingContent, candidates)
  };
}

// invariant: the cache anchors a decision target to the target
// candidate's content, not its object_id. Resolving it back returns the
// current candidate whose content hashes identically — but ONLY when
// exactly one does. Two distinct candidate rows can hold byte-identical
// content; picking either would be a guess, and acting on the wrong row
// is a silent wrong-target durable mutation. On an ambiguous (>1) match
// the target is dropped (returns undefined) so the core service degrades
// the verdict to ADD rather than guessing. A zero match also returns
// undefined (the content is gone from the candidate set).
function resolveTargetByContentHash(
  targetContentHash: string,
  candidates: readonly { readonly objectId: string; readonly content: string }[]
): string | undefined {
  const matches = candidates.filter(
    (candidate) => hashContent(candidate.content) === targetContentHash
  );
  return matches.length === 1 ? matches[0]!.objectId : undefined;
}

function hashContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function buildDecisionPrompt(
  incomingContent: string,
  candidates: readonly { readonly objectId: string; readonly content: string }[]
): string {
  const candidateLines = candidates
    .map((candidate, index) => `[${index}] id=${candidate.objectId}: ${candidate.content}`)
    .join("\n");
  return [
    "NEW FACT:",
    incomingContent,
    "",
    "EXISTING CANDIDATES:",
    candidateLines
  ].join("\n");
}

async function decideWithGardenCache(
  config: ReconciliationLlmDecisionConfig,
  cacheRoot: string,
  llmComplete: (prompt: string, config: ReconciliationLlmDecisionConfig) => Promise<string>,
  incomingContent: string,
  candidates: readonly { readonly objectId: string; readonly content: string }[]
): Promise<Awaited<ReturnType<NonNullable<ReconciliationLlmDecisionPort>["decide"]>>> {
  const requestKey = computeRequestKey(config.model, incomingContent, candidates);
  const cached = await readCachedDecision(cacheRoot, requestKey);
  if (cached !== undefined) {
    return materializeCachedReconciliationDecision(cached, candidates);
  }
  return await requestAndCacheReconciliationDecision(
    config,
    cacheRoot,
    llmComplete,
    incomingContent,
    candidates,
    requestKey
  );
}

function materializeCachedReconciliationDecision(
  cached: CachedDecision,
  candidates: readonly { readonly objectId: string; readonly content: string }[]
): { readonly kind: "add" | "update" | "noop"; readonly targetObjectId?: string; readonly reason: string } {
  const targetObjectId =
    cached.target_content_hash === null
      ? undefined
      : resolveTargetByContentHash(cached.target_content_hash, candidates);
  return {
    kind: cached.kind,
    ...(targetObjectId === undefined ? {} : { targetObjectId }),
    reason: cached.reason
  };
}

async function requestAndCacheReconciliationDecision(
  config: ReconciliationLlmDecisionConfig,
  cacheRoot: string,
  llmComplete: (prompt: string, config: ReconciliationLlmDecisionConfig) => Promise<string>,
  incomingContent: string,
  candidates: readonly { readonly objectId: string; readonly content: string }[],
  requestKey: string
): Promise<{ readonly kind: "add" | "update" | "noop"; readonly targetObjectId?: string; readonly reason: string }> {
  const prompt = buildDecisionPrompt(incomingContent, candidates);
  const raw = await llmComplete(prompt, config);
  const parsed = parseDecision(raw, candidates);
  const targetContent =
    parsed.targetObjectId === undefined
      ? undefined
      : candidates.find((candidate) => candidate.objectId === parsed.targetObjectId)?.content;
  await writeCachedDecision(cacheRoot, requestKey, {
    model: config.model,
    request_hash: requestKey,
    kind: parsed.kind,
    target_content_hash: targetContent === undefined ? null : hashContent(targetContent),
    reason: parsed.reason ?? "",
    decided_at: new Date().toISOString()
  });
  return {
    ...parsed,
    reason: parsed.reason ?? ""
  };
}

function computeRequestKey(
  model: string,
  incomingContent: string,
  candidates: readonly { readonly objectId: string; readonly content: string }[]
): string {
  // Keyed on candidate CONTENT only, not object_id: the LLM judges
  // refines-vs-distinct purely from the text, so two ingest events with
  // the same incoming fact + same neighbor contents reuse one cached
  // decision even if the neighbor rows were re-materialized under fresh
  // ids. The decision target is content-anchored and resolved back to a
  // current object_id on a hit (see decide / resolveTargetByContentHash),
  // so dropping the id from the key cannot serve a stale target.
  // Sorted so FTS row ordering does not change the key.
  const sortedCandidates = [...candidates]
    .map((candidate) => candidate.content)
    .sort();
  // A real field delimiter (0x1f unit separator — it cannot occur in a
  // model id or in distilled-fact text) between the hashed parts so that
  // e.g. ("ab","c") and ("a","bc") cannot hash to the same cache key.
  const FIELD_SEPARATOR = "\u001f";
  const hash = createHash("sha256");
  hash.update(model, "utf8");
  hash.update(FIELD_SEPARATOR, "utf8");
  hash.update(incomingContent, "utf8");
  for (const candidate of sortedCandidates) {
    hash.update(FIELD_SEPARATOR, "utf8");
    hash.update(candidate, "utf8");
  }
  return hash.digest("hex");
}

function cacheFilePath(cacheRoot: string, requestKey: string): string {
  return join(cacheRoot, requestKey.slice(0, 2), `${requestKey}.json`);
}

async function readCachedDecision(
  cacheRoot: string,
  requestKey: string
): Promise<CachedDecision | undefined> {
  const filePath = cacheFilePath(cacheRoot, requestKey);
  if (!(await fileExists(filePath))) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(await readFile(filePath, "utf8")) as Partial<CachedDecision>;
    if (parsed.kind !== "add" && parsed.kind !== "update" && parsed.kind !== "noop") {
      return undefined;
    }
    // Normalize the target anchor: a missing / non-string value (e.g. a
    // pre-content-anchor cache file, or an `add` verdict) resolves to a
    // null target, never undefined, so the hit path's `=== null` guard
    // is exact.
    const targetContentHash =
      typeof parsed.target_content_hash === "string" ? parsed.target_content_hash : null;
    return {
      model: typeof parsed.model === "string" ? parsed.model : "",
      request_hash: typeof parsed.request_hash === "string" ? parsed.request_hash : requestKey,
      kind: parsed.kind,
      target_content_hash: targetContentHash,
      reason: typeof parsed.reason === "string" ? parsed.reason : "",
      decided_at: typeof parsed.decided_at === "string" ? parsed.decided_at : ""
    };
  } catch (error) {
    // corrupt cache file → treated as a miss, which silently doubles LLM cost
    process.emitWarning("[Reconciliation] decision cache read failed; treating as miss", {
      code: "ALAYA_RECONCILIATION_CACHE_READ_FAILED",
      detail: JSON.stringify({
        path: filePath,
        code: (error as NodeJS.ErrnoException)?.code ?? (error instanceof Error ? error.name : "unknown")
      })
    });
    return undefined;
  }
}

async function writeCachedDecision(
  cacheRoot: string,
  requestKey: string,
  entry: CachedDecision
): Promise<void> {
  const filePath = cacheFilePath(cacheRoot, requestKey);
  await mkdir(dirname(filePath), { recursive: true });
  // Write to a temp file in the same directory then rename onto the
  // final path — rename is atomic on POSIX, so a crash or a concurrent
  // write can never leave a truncated .json that every future run would
  // treat as a permanent cache miss. The temp suffix is a per-write UUID
  // so two writers racing the same requestKey within one process never
  // collide on the temp path; a crash leaves at most a stale .tmp.
  const tempPath = `${filePath}.${randomUUID()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(entry, null, 2)}\n`, "utf8");
  await rename(tempPath, filePath);
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function parseDecision(
  rawJson: string,
  candidates: readonly { readonly objectId: string; readonly content: string }[]
): { kind: "add" | "update" | "noop"; targetObjectId?: string; reason?: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch (error) {
    throw new Error("garden reconciliation decision response was not valid JSON", {
      cause: error
    });
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("garden reconciliation decision response was not an object");
  }
  const record = parsed as {
    readonly kind?: unknown;
    readonly target_object_id?: unknown;
    readonly reason?: unknown;
  };
  if (record.kind !== "add" && record.kind !== "update" && record.kind !== "noop") {
    throw new Error("garden reconciliation decision kind was invalid");
  }
  const kind = record.kind;
  const reason = typeof record.reason === "string" ? record.reason : undefined;
  if (kind === "add") {
    return { kind, ...(reason === undefined ? {} : { reason }) };
  }
  const candidateIds = new Set(candidates.map((candidate) => candidate.objectId));
  const targetObjectId =
    typeof record.target_object_id === "string" &&
    candidateIds.has(record.target_object_id)
      ? record.target_object_id
      : undefined;
  // An update/noop without a valid target is unactionable; the core
  // service degrades it to ADD.
  return {
    kind,
    ...(targetObjectId === undefined ? {} : { targetObjectId }),
    ...(reason === undefined ? {} : { reason })
  };
}

/**
 * Live garden LLM call: OpenAI-compatible POST /chat/completions with a
 * JSON-object response format. Mirrors the LongMemEval extraction
 * transport without a new client dependency.
 */
async function requestDecisionFromGarden(
  prompt: string,
  config: ReconciliationLlmDecisionConfig
): Promise<string> {
  if (config.apiKey === null) {
    throw new Error("garden API key is unavailable");
  }
  return await requestGardenChatCompletionContent({
    config,
    systemPrompt: DECISION_SYSTEM_PROMPT,
    userPrompt: prompt,
    timeoutMs: DECISION_REQUEST_TIMEOUT_MS,
    failureLabel: "garden reconciliation decision"
  });
}
