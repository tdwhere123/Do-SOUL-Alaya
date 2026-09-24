import {
  extractionArtifactPrompt, extractionArtifactRequests, extractionTypedArtifactMode,
  type ExtractionOpenSemanticsGeneration
} from "../request-artifact.js";
import { inspectCachedExtractionArtifact } from "../../compile-seed/cache/cache-shard.js";
import { AlayaError, type SourceInterpretationProfile, type ExtractionSourcePacking } from "@do-soul/alaya-protocol";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstatSync, realpathSync, statfsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveCompileSeedExtractionConfig } from "../../compile-seed/compile-seed-config.js";
import {
  assertRequiredRequestProfile,
  resolveExtractionTransportRoute
} from "../transport-route.js";
import { isObsoleteRequestProfile } from "../../provider/catalog.js";
import {
  computeExtractionTurnCacheKeys
} from "../../compile-seed/compile-seed-cache.js";
import {
  EXTRACTION_CACHE_KEY_ALGO,
  computeSystemPromptSha256,
  readExtractionCacheManifestIdentity
} from "../cache/extraction-cache-manifest.js";
import type { LongMemEvalVariant } from "../../../datasets/longmemeval/ingestion/dataset.js";
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
import type { LongMemEvalExtractionTurn } from "../turn-contents.js";
import { inspectExtractionCacheWriterLock } from
  "../fill/manifest/writer-lock.js";

const AUTHORIZED_EXTRACTION_OPERATION = "longmemeval-extraction-fill-v1";

export interface ExtractionAuthorityInspection {
  readonly observation: ExtractionAuthorityObservation;
  readonly sourceOccurrences: number;
  readonly unsupportedSourceOccurrences: number;
  readonly missingKeys: readonly string[];
  readonly nonemptyKeys?: readonly string[];
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
  readonly sourcePacking?: ExtractionSourcePacking;
  readonly sourceInterpretationProfile?: SourceInterpretationProfile;
  readonly openSemantics?: boolean | ExtractionOpenSemanticsGeneration;
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
  const config = resolveCompileSeedExtractionConfig(process.env, manifestIdentity?.manifest, input.sourcePacking, input.sourceInterpretationProfile, input.openSemantics);
  assertRequiredRequestProfile(config);
  if (isObsoleteRequestProfile(config.requestProfile)) {
    throw new Error(
      `extraction authority refuses obsolete request profile ${config.requestProfile}`
    );
  }
  const window = await prepareExtractionFillWindow({ ...input, sourcePacking: config.sourcePacking, openSemantics: config.openSemantics !== undefined }, undefined);
  const authorizedTurns = input.repairInvalidShards === true
    ? window.executionExtractionTurns
    : window.distinctExtractionTurns;
  const completion = inspectAuthorityCompletion(input, config, authorizedTurns);
  const shardStatus = collectShardStatus(
    input.cacheRoot,
    config,
    authorizedTurns,
    new Set(input.preservedValidExclusionKeys ?? [])
  );
  const observation = buildAuthorityObservation(input, manifestIdentity, config, window, completion);
  return buildExtractionAuthorityInspection(input, config, shardStatus, observation, window);
}

function inspectAuthorityCompletion(
  input: ExtractionAuthorityInspectionInput,
  config: ReturnType<typeof resolveCompileSeedExtractionConfig>,
  authorizedTurns: readonly LongMemEvalExtractionTurn[]
): ExtractionAuthorityCompletion {
  return inspectExtractionFillCompletion({
    cacheRoot: input.cacheRoot,
    model: config.model,
    requestProfile: config.requestProfile,
    sourcePacking: config.sourcePacking,
    sourceInterpretationProfile: config.sourceInterpretationProfile,
    openSemantics: config.openSemantics,
    systemPrompt: extractionArtifactPrompt(config.sourceInterpretationProfile, config.openSemantics),
    extractionTurns: authorizedTurns,
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
      windowUniqueCacheKeys: window.windowUniqueCacheKeys,
      unsupportedSourceOccurrences: window.unsupportedSourceOccurrences,
      authorizedUniqueCacheKeys: completion.expectedTurns
    }),
    keyDigest: completion.expectedKeySetSha256,
    dataset: buildAuthorityDatasetObservation(input, window, completion),
    extraction: buildAuthorityExtractionObservation(config, manifestIdentity, completion),
    transport: resolveExtractionTransportRoute(config),
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
    windowUniqueCacheKeys: window.windowUniqueCacheKeys,
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
    ...(manifestIdentity !== undefined && manifestIdentity.manifest.schema_version < 4 ? {} : {
      sourcePacking: config.sourcePacking
    }),
    providerUrl: config.providerUrl,
    systemPromptSha256: computeSystemPromptSha256(extractionArtifactPrompt(config.sourceInterpretationProfile, config.openSemantics)),
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
  observation: ExtractionAuthorityObservation,
  window: ExtractionAuthorityWindow
): ExtractionAuthorityInspection {
  return Object.freeze({
    observation,
    sourceOccurrences: window.windowTurnOccurrences,
    unsupportedSourceOccurrences: window.unsupportedSourceOccurrences,
    missingKeys: Object.freeze(shardStatus.missingKeys),
    nonemptyKeys: Object.freeze(shardStatus.nonemptyKeys ?? []),
    invalidShards: Object.freeze(shardStatus.invalidShards),
    preservedValidClosure: createExtractionPreservedValidClosure(shardStatus.validEntries),
    writerLock: inspectExtractionCacheWriterLock(input.cacheRoot),
    disk: inspectExtractionAuthorityDisk(input.cacheRoot),
    credentialStatus: config.apiKey === null ? "absent" : "present",
    modelReadiness: "not_probed"
  });
}

function collectShardStatus(
  cacheRoot: string,
  config: ReturnType<typeof resolveCompileSeedExtractionConfig>,
  turns: readonly LongMemEvalExtractionTurn[],
  preservedValidExclusionKeys: ReadonlySet<string>
): {
  readonly missingKeys: readonly string[];
  readonly nonemptyKeys?: readonly string[];
  readonly invalidShards: readonly ExtractionRepairShard[];
  readonly validEntries: readonly ExtractionContentClosureEntry[];
} {
  const missingKeys: string[] = [];
  const nonemptyKeys: string[] = [];
  const invalidShards: ExtractionRepairShard[] = [];
  const validEntries: ExtractionContentClosureEntry[] = [];
  const revisionsSeen = new Set<string>();
  for (const turn of turns) {
    const keys = computeExtractionTurnCacheKeys(
      config.model, config.requestProfile, extractionArtifactPrompt(config.sourceInterpretationProfile, config.openSemantics), turn, config.sourcePacking, config.sourceInterpretationProfile, config.openSemantics
    );
    const requests = extractionArtifactRequests(turn, config.sourcePacking, config.sourceInterpretationProfile, config.openSemantics);
    for (const request of requests) {
      const revision = request.semantic?.source_request.revision;
      if (revision !== undefined) revisionsSeen.add(revision.base_request_sha256);
    }
    for (const [index, key] of keys.entries()) {
      if (requests[index]!.source.source_assertions.length > 0) nonemptyKeys.push(key);
      const shard = inspectCachedExtractionArtifact(
        cacheRoot, key, config.model, config.requestProfile, extractionTypedArtifactMode(config)
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
  }
  if (config.openSemantics?.revisions?.some((row) => !revisionsSeen.has(row.base_request_sha256))) {
    throw new AlayaError("CONFLICT", "source revision registry is not covered by the original source inventory");
  }
  return {
    missingKeys: missingKeys.sort(),
    nonemptyKeys: [...new Set(nonemptyKeys)].sort(),
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
  // Bind source state to the checkout that loaded this implementation, regardless of caller cwd.
  const checkoutRoot = resolve(dirname(realpathSync(fileURLToPath(import.meta.url))), "../../../../../..");
  let gitRoot: string;
  try {
    gitRoot = realpathSync(readGitText(["rev-parse", "--show-toplevel"], checkoutRoot));
  } catch (cause) {
    throw new AlayaError("CONFLICT", "cannot establish the loaded bench-runner Git checkout", { cause });
  }
  if (gitRoot !== checkoutRoot) {
    throw new AlayaError("CONFLICT", "loaded bench-runner module is outside its Git checkout root");
  }
  return computeExtractionAuthorityWorktreeRevision({
    head: readGitText(["rev-parse", "HEAD"], checkoutRoot),
    trackedDiff: readGitBuffer(["diff", "--no-ext-diff", "--binary", "HEAD", "--"], checkoutRoot),
    untrackedFiles: readUntrackedFileDigests(checkoutRoot)
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

function readUntrackedFileDigests(checkoutRoot: string): readonly {
  readonly path: string;
  readonly mode: number;
  readonly blobDigest: string;
}[] {
  return readGitBuffer(["ls-files", "--others", "--exclude-standard", "-z"], checkoutRoot)
    .toString("utf8").split("\0").filter((path) => path.length > 0)
    .map((path) => ({
      path,
      mode: lstatSync(join(checkoutRoot, path)).mode & 0o777,
      blobDigest: readGitText(["hash-object", "--no-filters", "--", path], checkoutRoot)
    }));
}

function readGitText(args: readonly string[], checkoutRoot: string): string {
  return execFileSync("git", args, {
    cwd: checkoutRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"]
  }).trim();
}

function readGitBuffer(args: readonly string[], checkoutRoot: string): Buffer {
  return execFileSync("git", args, {
    cwd: checkoutRoot,
    encoding: "buffer",
    // Authority binds the full patch; large legitimate retirements exceed Node's default.
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"]
  }) as Buffer;
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}
