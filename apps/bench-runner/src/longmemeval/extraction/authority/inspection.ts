import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, statfsSync } from "node:fs";
import { join } from "node:path";
import { OFFICIAL_API_SYSTEM_PROMPT } from "@do-soul/alaya-soul";
import { resolveCompileSeedExtractionConfig } from "../../compile-seed/compile-seed-config.js";
import { computeCacheKey, inspectCachedExtraction } from "../../compile-seed/compile-seed-cache.js";
import {
  EXTRACTION_CACHE_KEY_ALGO,
  computeSystemPromptSha256,
  readExtractionCacheManifestIdentity
} from "../cache/extraction-cache-manifest.js";
import type { LongMemEvalVariant } from "../../ingestion/dataset.js";
import { inspectExtractionFillCompletion } from "../fill/fill-completion.js";
import { prepareExtractionFillWindow } from "../fill/fill-window.js";
import type {
  ExtractionAuthorityObservation,
  ExtractionAuthorityReceipt
} from "./receipt.js";
import type { ExtractionRepairShard } from "./repair/repair-scope.js";
import {
  createExtractionPreservedValidClosure,
  type ExtractionPreservedValidClosure
} from "./repair/preserved-valid-closure.js";
import type { ExtractionContentClosureEntry } from "../content-closure.js";

const WRITE_LOCK_DIRECTORY = ".extraction-fill.lock";
const AUTHORIZED_EXTRACTION_OPERATION = "longmemeval-extraction-fill-v1";

export interface ExtractionAuthorityInspection {
  readonly observation: ExtractionAuthorityObservation;
  readonly missingKeys: readonly string[];
  readonly invalidShards: readonly ExtractionRepairShard[];
  readonly preservedValidClosure: ExtractionPreservedValidClosure;
  readonly writerLock: "absent" | "present";
  readonly disk: { readonly status: "available"; readonly freeBytes: number } |
    { readonly status: "unavailable" };
  readonly credentialStatus: "present" | "absent";
  readonly modelReadiness: "not_probed";
}

type ExtractionAuthorityInspectionInput = Parameters<typeof inspectExtractionAuthority>[0];
type ExtractionAuthorityWindow = Awaited<ReturnType<typeof prepareExtractionFillWindow>>;
type ExtractionAuthorityCompletion = ReturnType<typeof inspectExtractionFillCompletion>;

/**
 * Read only the local dataset, cache and runtime configuration needed to bind
 * an authority receipt. This function never constructs a transport delegate.
 */
export async function inspectExtractionAuthority(input: {
  readonly variant: LongMemEvalVariant;
  readonly limit?: number;
  readonly offset?: number;
  readonly questionBatchLimit?: number;
  readonly cacheRoot: string;
  readonly dataDir?: string;
  readonly pinnedMetaRoot?: string;
  readonly revision: string;
  readonly action: ExtractionAuthorityReceipt["action"];
  readonly repairInvalidShards?: boolean;
  readonly excludeContentClosureKeys?: readonly string[];
  readonly preservedValidExclusionKeys?: readonly string[];
}): Promise<ExtractionAuthorityInspection> {
  const manifestIdentity = readExtractionCacheManifestIdentity(input.cacheRoot);
  const config = resolveCompileSeedExtractionConfig(process.env, manifestIdentity?.manifest);
  const window = await prepareExtractionFillWindow(input, undefined);
  const authorizedTurns = input.repairInvalidShards === true
    ? window.executionTurns
    : window.distinctTurns;
  const completion = inspectAuthorityCompletion(input, config, authorizedTurns);
  const shardStatus = collectShardStatus(
    input.cacheRoot,
    config,
    authorizedTurns,
    new Set(input.preservedValidExclusionKeys ?? [])
  );
  const observation = buildAuthorityObservation(input, manifestIdentity, config, window, completion);
  return buildExtractionAuthorityInspection(input, config, shardStatus, observation);
}

function inspectAuthorityCompletion(
  input: ExtractionAuthorityInspectionInput,
  config: ReturnType<typeof resolveCompileSeedExtractionConfig>,
  authorizedTurns: readonly string[]
): ExtractionAuthorityCompletion {
  return inspectExtractionFillCompletion({
    cacheRoot: input.cacheRoot,
    model: config.model,
    requestProfile: config.requestProfile,
    systemPrompt: OFFICIAL_API_SYSTEM_PROMPT,
    turnContents: authorizedTurns,
    ...(input.excludeContentClosureKeys === undefined ? {} : {
      excludeContentClosureKeys: input.excludeContentClosureKeys
    })
  });
}

function buildAuthorityObservation(
  input: ExtractionAuthorityInspectionInput,
  manifestIdentity: ReturnType<typeof readExtractionCacheManifestIdentity>,
  config: ReturnType<typeof resolveCompileSeedExtractionConfig>,
  window: ExtractionAuthorityWindow,
  completion: ExtractionAuthorityCompletion
): ExtractionAuthorityObservation {
  return Object.freeze({
    revision: input.revision,
    commandDigest: digest({
      operation: AUTHORIZED_EXTRACTION_OPERATION,
      action: input.action,
      repairInvalidShards: input.repairInvalidShards === true
    }),
    selectionDigest: digest({
      variant: input.variant,
      datasetRevision: window.datasetRevision,
      offset: window.windowOffset,
      limit: window.questionCount,
      windowUniqueCacheKeys: window.requestedTurns,
      authorizedUniqueCacheKeys: completion.expectedTurns
    }),
    keyDigest: completion.expectedKeySetSha256,
    dataset: buildAuthorityDatasetObservation(input, window, completion),
    extraction: buildAuthorityExtractionObservation(config, manifestIdentity, completion),
    inventory: buildAuthorityInventoryObservation(completion)
  } satisfies ExtractionAuthorityObservation);
}

function buildAuthorityDatasetObservation(
  input: ExtractionAuthorityInspectionInput,
  window: ExtractionAuthorityWindow,
  completion: ExtractionAuthorityCompletion
) {
  return Object.freeze({
    variant: input.variant,
    revisionSha256: window.datasetRevision,
    windowOffset: window.windowOffset,
    windowLimit: window.questionCount,
    windowTurnOccurrences: window.windowTurnOccurrences,
    windowUniqueCacheKeys: window.requestedTurns,
    authorizedQuestionCount: window.questionBatchLimit ?? window.questionCount,
    authorizedTurnOccurrences: input.repairInvalidShards === true
      ? window.executionTurnOccurrences
      : window.windowTurnOccurrences,
    authorizedUniqueCacheKeys: completion.expectedTurns,
    expectedKeySetSha256: completion.expectedKeySetSha256
  });
}

function buildAuthorityExtractionObservation(
  config: ReturnType<typeof resolveCompileSeedExtractionConfig>,
  manifestIdentity: ReturnType<typeof readExtractionCacheManifestIdentity>,
  completion: ExtractionAuthorityCompletion
) {
  return Object.freeze({
    model: config.model,
    modelFamily: config.modelFamily ?? config.model,
    requestProfile: config.requestProfile,
    providerUrl: config.providerUrl,
    systemPromptSha256: computeSystemPromptSha256(OFFICIAL_API_SYSTEM_PROMPT),
    cacheKeyAlgorithm: EXTRACTION_CACHE_KEY_ALGO,
    manifestSha256: manifestIdentity?.manifestSha256 ?? null,
    rawContentClosureSha256: completion.partialContentClosureSha256
  });
}

function buildAuthorityInventoryObservation(completion: ExtractionAuthorityCompletion) {
  return Object.freeze({
    expectedTurns: completion.expectedTurns,
    validTurns: completion.validTurns,
    missingTurns: completion.missingTurns,
    invalidTurns: completion.invalidTurns,
    orphanTurns: completion.orphanTurns
  });
}

function buildExtractionAuthorityInspection(
  input: ExtractionAuthorityInspectionInput,
  config: ReturnType<typeof resolveCompileSeedExtractionConfig>,
  shardStatus: ReturnType<typeof collectShardStatus>,
  observation: ExtractionAuthorityObservation
): ExtractionAuthorityInspection {
  return Object.freeze({
    observation,
    missingKeys: Object.freeze(shardStatus.missingKeys),
    invalidShards: Object.freeze(shardStatus.invalidShards),
    preservedValidClosure: createExtractionPreservedValidClosure(shardStatus.validEntries),
    writerLock: existsSync(join(input.cacheRoot, WRITE_LOCK_DIRECTORY)) ? "present" : "absent",
    disk: inspectExtractionAuthorityDisk(input.cacheRoot),
    credentialStatus: config.apiKey === null ? "absent" : "present",
    modelReadiness: "not_probed"
  });
}

function collectShardStatus(
  cacheRoot: string,
  config: ReturnType<typeof resolveCompileSeedExtractionConfig>,
  turns: readonly string[],
  preservedValidExclusionKeys: ReadonlySet<string>
): {
  readonly missingKeys: readonly string[];
  readonly invalidShards: readonly ExtractionRepairShard[];
  readonly validEntries: readonly ExtractionContentClosureEntry[];
} {
  const missingKeys: string[] = [];
  const invalidShards: ExtractionRepairShard[] = [];
  const validEntries: ExtractionContentClosureEntry[] = [];
  for (const turn of turns) {
    const key = computeCacheKey(
      config.model, config.requestProfile, OFFICIAL_API_SYSTEM_PROMPT, turn
    );
    const shard = inspectCachedExtraction(
      cacheRoot, key, config.model, config.requestProfile
    );
    if (shard.status === "missing") missingKeys.push(key);
    if (shard.status === "hit" && !preservedValidExclusionKeys.has(key)) {
      validEntries.push({
        cacheKey: key,
        model: config.model,
        requestProfile: config.requestProfile,
        rawJsonSha256: shard.rawJsonSha256,
        rawSignalCount: shard.rawSignalCount,
        parsedDraftCount: shard.parsedDraftCount
      });
    }
    if (shard.status === "invalid" && shard.rawJsonSha256 !== undefined) {
      invalidShards.push({ cache_key: key, raw_json_sha256: shard.rawJsonSha256 });
    }
  }
  return {
    missingKeys: missingKeys.sort(),
    validEntries,
    invalidShards: invalidShards.sort((left, right) =>
      left.cache_key.localeCompare(right.cache_key)
    )
  };
}

export function inspectExtractionAuthorityDisk(
  cacheRoot: string
): ExtractionAuthorityInspection["disk"] {
  try {
    const stat = statfsSync(cacheRoot);
    const freeBytes = Number(stat.bavail) * Number(stat.bsize);
    if (!Number.isSafeInteger(freeBytes) || freeBytes < 0) {
      return { status: "unavailable" };
    }
    return { status: "available", freeBytes };
  } catch {
    return { status: "unavailable" };
  }
}

export function readCurrentExtractionAuthorityRevision(): string {
  return computeExtractionAuthorityWorktreeRevision({
    head: readGitText(["rev-parse", "HEAD"]),
    trackedDiff: readGitBuffer(["diff", "--no-ext-diff", "--binary", "HEAD", "--"]),
    untrackedFiles: readUntrackedFileDigests()
  });
}

export function computeExtractionAuthorityWorktreeRevision(input: {
  readonly head: string;
  readonly trackedDiff: Uint8Array;
  readonly untrackedFiles: readonly {
    readonly path: string;
    readonly mode: number;
    readonly blobDigest: string;
  }[];
}): string {
  if (!/^[a-f0-9]{40}$/u.test(input.head)) {
    throw new Error("cannot bind extraction authority receipt to the current Git revision");
  }
  const digest = createHash("sha256").update("git-worktree-v1\0", "utf8")
    .update(input.head, "utf8").update("\0", "utf8").update(input.trackedDiff);
  for (const file of [...input.untrackedFiles].sort((left, right) => left.path.localeCompare(right.path))) {
    if (file.path.length === 0 || !Number.isSafeInteger(file.mode) ||
        !/^[a-f0-9]{40,64}$/u.test(file.blobDigest)) {
      throw new Error("cannot bind extraction authority receipt to the current Git worktree");
    }
    digest.update(`\0${file.path}\0${file.mode}\0${file.blobDigest}`, "utf8");
  }
  return `git-worktree-v1:${input.head}:${digest.digest("hex")}`;
}

function readUntrackedFileDigests(): readonly {
  readonly path: string;
  readonly mode: number;
  readonly blobDigest: string;
}[] {
  return readGitBuffer(["ls-files", "--others", "--exclude-standard", "-z"])
    .toString("utf8").split("\0").filter((path) => path.length > 0)
    .map((path) => ({
      path,
      mode: lstatSync(path).mode & 0o777,
      blobDigest: readGitText(["hash-object", "--no-filters", "--", path])
    }));
}

function readGitText(args: readonly string[]): string {
  return execFileSync("git", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"]
  }).trim();
}

function readGitBuffer(args: readonly string[]): Buffer {
  return execFileSync("git", args, {
    encoding: "buffer",
    stdio: ["ignore", "pipe", "ignore"]
  }) as Buffer;
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}
