import type { ExtractionOpenSemanticsGeneration } from "../request-artifact.js";
import { AlayaError, type SourceInterpretationProfile, type ExtractionSourcePacking } from "@do-soul/alaya-protocol";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstatSync, realpathSync, statfsSync } from "node:fs";
import { samePhysicalLocation } from "../../fs/opened-contained-path.js";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtractionFillVariant } from "../fill/fill-window.js";
import type {
  ExtractionAuthorityObservation,
  ExtractionAuthorityReceipt
} from "./receipt.js";
import type { ExtractionRepairShard } from "./repair/repair-scope.js";
import type { ExtractionPreservedValidClosure } from "./repair/preserved-valid-closure.js";
import type { ExtractionContentClosureEntry } from "../content-closure.js";
import type { LongMemEvalExtractionTurn } from "../turn-contents.js";
import { nonCredentialChildEnv } from "../fill/manifest/non-credential-child-env.js";

const AUTHORIZED_EXTRACTION_OPERATION = "longmemeval-extraction-fill-v1";

export interface ExtractionAuthorityInspection {
  readonly observation: ExtractionAuthorityObservation;
  readonly sourceOccurrences: number;
  readonly unsupportedSourceOccurrences: number;
  readonly missingKeys: readonly string[];
  readonly pendingShards: readonly Readonly<{ cacheKey: string; attemptOrdinal: number;
    authorityLineageDigest: string }>[];
  readonly nonemptyKeys?: readonly string[];
  readonly invalidShards: readonly ExtractionRepairShard[];
  readonly preservedValidClosure: ExtractionPreservedValidClosure;
  readonly writerLock: "absent" | "present";
  readonly disk: { readonly status: "available"; readonly freeBytes: number } |
    { readonly status: "unavailable" };
  readonly credentialStatus: "present" | "absent";
  readonly modelReadiness: "not_probed";
}

type AuthorityInspectionRuntime = Awaited<ReturnType<typeof loadAuthorityInspectionRuntime>>;
type ExtractionAuthorityInspectionInput = Parameters<typeof inspectExtractionAuthority>[0];
type ExtractionAuthorityWindow = Awaited<ReturnType<AuthorityInspectionRuntime["prepareExtractionFillWindow"]>>;
type ExtractionAuthorityCompletion = ReturnType<AuthorityInspectionRuntime["inspectExtractionFillCompletion"]>;
type CompileSeedExtractionConfig = ReturnType<AuthorityInspectionRuntime["resolveCompileSeedExtractionConfig"]>;
type ExtractionCacheManifestIdentity = ReturnType<AuthorityInspectionRuntime["readExtractionCacheManifestIdentity"]>;

/** Defer heavy fill-window and compile-seed imports so synchronous Git revision checks stay lightweight. */
async function loadAuthorityInspectionRuntime() {
  const [
    requestArtifact, cacheShard, compileSeedConfig, transportRoute, providerCatalog, compileSeedCache,
    cacheManifest, sourceRequestWorkset, fillCompletion, fillWindow, preservedValidClosure, writerLock
  ] = await Promise.all([
    import("../request-artifact.js"),
    import("../../compile-seed/cache/cache-shard.js"),
    import("../../compile-seed/compile-seed-config.js"),
    import("../transport-route.js"),
    import("../../provider/catalog.js"),
    import("../../compile-seed/compile-seed-cache.js"),
    import("../cache/extraction-cache-manifest.js"),
    import("../fill/source-request-workset.js"),
    import("../fill/fill-completion.js"),
    import("../fill/fill-window.js"),
    import("./repair/preserved-valid-closure.js"),
    import("../fill/manifest/writer-lock.js")
  ]);
  return {
    ...requestArtifact, ...cacheShard, ...compileSeedConfig, ...transportRoute,
    ...providerCatalog, ...compileSeedCache, ...cacheManifest, ...sourceRequestWorkset,
    ...fillCompletion, ...fillWindow, ...preservedValidClosure, ...writerLock
  };
}

/**
 * Read only the local dataset, cache and runtime configuration needed to bind
 * an authority receipt. This function never constructs a transport delegate.
 */
export async function inspectExtractionAuthority(input: {
  readonly sourcePacking?: ExtractionSourcePacking;
  readonly sourceInterpretationProfile?: SourceInterpretationProfile;
  readonly openSemantics?: boolean | ExtractionOpenSemanticsGeneration;
  readonly variant: ExtractionFillVariant;
  readonly nativeSourcePopulation?: Readonly<{ name: string; snapshotPath: string }>;
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
  const runtime = await loadAuthorityInspectionRuntime();
  const manifestIdentity = runtime.readExtractionCacheManifestIdentity(input.cacheRoot);
  const config = runtime.resolveCompileSeedExtractionConfig(process.env, manifestIdentity?.manifest, input.sourcePacking, input.sourceInterpretationProfile, input.openSemantics);
  runtime.assertRequiredRequestProfile(config);
  if (runtime.isObsoleteRequestProfile(config.requestProfile)) {
    throw new Error(
      `extraction authority refuses obsolete request profile ${config.requestProfile}`
    );
  }
  const window = await runtime.prepareExtractionFillWindow({ ...input, config,
    sourcePacking: config.sourcePacking, openSemantics: config.openSemantics !== undefined }, undefined);
  const authorizedTurns = input.repairInvalidShards === true
    ? window.executionExtractionTurns
    : window.distinctExtractionTurns;
  const completion = inspectAuthorityCompletion(runtime, input, config, authorizedTurns, window);
  const shardStatus = collectShardStatus(
    runtime,
    input.cacheRoot,
    config,
    authorizedTurns, window,
    new Set(input.preservedValidExclusionKeys ?? [])
  );
  const observation = buildAuthorityObservation(runtime, input, manifestIdentity, config, window, completion);
  return buildExtractionAuthorityInspection(runtime, input, config, shardStatus, observation, window);
}

function inspectAuthorityCompletion(
  runtime: AuthorityInspectionRuntime,
  input: ExtractionAuthorityInspectionInput,
  config: CompileSeedExtractionConfig,
  authorizedTurns: readonly LongMemEvalExtractionTurn[],
  window: ExtractionAuthorityWindow
): ExtractionAuthorityCompletion {
  return runtime.inspectExtractionFillCompletion({
    cacheRoot: input.cacheRoot,
    model: config.model,
    requestProfile: config.requestProfile,
    sourcePacking: config.sourcePacking,
    sourceInterpretationProfile: config.sourceInterpretationProfile,
    openSemantics: config.openSemantics,
    systemPrompt: runtime.extractionArtifactPrompt(config.sourceInterpretationProfile, config.openSemantics, config.sourcePacking),
    ...(window.nativeSourceRecords === undefined ? { extractionTurns: authorizedTurns } : {
      expectedRequestKeys: runtime.nativeSourceRequestInventory(window.nativeSourceRecords,
        window.datasetRevision, config).requests.map(item => item.line.key) }),
    ...(input.excludeContentClosureKeys === undefined ? {} : {
      excludeContentClosureKeys: input.excludeContentClosureKeys
    })
  });
}

function buildAuthorityObservation(
  runtime: AuthorityInspectionRuntime,
  input: ExtractionAuthorityInspectionInput,
  manifestIdentity: ExtractionCacheManifestIdentity,
  config: CompileSeedExtractionConfig,
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
    extraction: buildAuthorityExtractionObservation(runtime, config, manifestIdentity, completion),
    transport: runtime.resolveExtractionTransportRoute(config),
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
  runtime: AuthorityInspectionRuntime,
  config: CompileSeedExtractionConfig,
  manifestIdentity: ExtractionCacheManifestIdentity,
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
    systemPromptSha256: runtime.computeSystemPromptSha256(runtime.extractionArtifactPrompt(config.sourceInterpretationProfile, config.openSemantics, config.sourcePacking)),
    cacheKeyAlgorithm: runtime.EXTRACTION_CACHE_KEY_ALGO,
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
  runtime: AuthorityInspectionRuntime,
  input: ExtractionAuthorityInspectionInput,
  config: CompileSeedExtractionConfig,
  shardStatus: ReturnType<typeof collectShardStatus>,
  observation: ExtractionAuthorityObservation,
  window: ExtractionAuthorityWindow
): ExtractionAuthorityInspection {
  return Object.freeze({
    observation,
    sourceOccurrences: window.windowTurnOccurrences,
    unsupportedSourceOccurrences: window.unsupportedSourceOccurrences,
    missingKeys: Object.freeze(shardStatus.missingKeys),
    pendingShards: Object.freeze(shardStatus.pendingShards),
    nonemptyKeys: Object.freeze(shardStatus.nonemptyKeys ?? []),
    invalidShards: Object.freeze(shardStatus.invalidShards),
    preservedValidClosure: runtime.createExtractionPreservedValidClosure(shardStatus.validEntries),
    writerLock: runtime.inspectExtractionCacheWriterLock(input.cacheRoot),
    disk: inspectExtractionAuthorityDisk(input.cacheRoot),
    credentialStatus: config.apiKey === null ? "absent" : "present",
    modelReadiness: "not_probed"
  });
}

function collectShardStatus(
  runtime: AuthorityInspectionRuntime,
  cacheRoot: string,
  config: CompileSeedExtractionConfig,
  turns: readonly LongMemEvalExtractionTurn[],
  window: ExtractionAuthorityWindow,
  preservedValidExclusionKeys: ReadonlySet<string>
): {
  readonly missingKeys: readonly string[];
  readonly pendingShards: readonly Readonly<{ cacheKey: string; attemptOrdinal: number;
    authorityLineageDigest: string }>[];
  readonly nonemptyKeys?: readonly string[];
  readonly invalidShards: readonly ExtractionRepairShard[];
  readonly validEntries: readonly ExtractionContentClosureEntry[];
} {
  const missingKeys: string[] = [];
  const pendingShards: { cacheKey: string; attemptOrdinal: number; authorityLineageDigest: string }[] = [];
  const nonemptyKeys: string[] = [];
  const invalidShards: ExtractionRepairShard[] = [];
  const validEntries: ExtractionContentClosureEntry[] = [];
  const revisionsSeen = new Set<string>();
  const requests = window.nativeSourceRecords === undefined
    ? turns.flatMap(turn => {
      const keys = runtime.computeExtractionTurnCacheKeys(config.model, config.requestProfile,
        runtime.extractionArtifactPrompt(config.sourceInterpretationProfile, config.openSemantics, config.sourcePacking), turn,
        config.sourcePacking, config.sourceInterpretationProfile, config.openSemantics);
      return runtime.extractionArtifactRequests(turn, config.sourcePacking, config.sourceInterpretationProfile,
        config.openSemantics).map((request, index) => ({ key: keys[index]!,
          nonempty: runtime.extractionRequestUnitCount(request.source) > 0,
          revision: request.semantic?.source_request.revision?.base_request_sha256 }));
    })
    : runtime.nativeSourceRequestInventory(window.nativeSourceRecords, window.datasetRevision, config).requests
      .map(item => ({ key: item.line.key, nonempty: runtime.extractionRequestUnitCount(item.request) > 0,
        revision: JSON.parse(item.line.userPrompt).source_request.revision?.base_request_sha256 as string | undefined }));
  for (const request of requests) {
      const { key } = request;
      if (request.revision !== undefined) revisionsSeen.add(request.revision);
      if (request.nonempty) nonemptyKeys.push(key);
      const shard = runtime.inspectCachedExtractionArtifact(
        cacheRoot, key, config.model, config.requestProfile, runtime.extractionTypedArtifactMode(config)
      );
      if (shard.status === "missing") missingKeys.push(key);
      if (shard.status === "pending" && shard.attemptOrdinal !== undefined &&
          shard.authorityLineageDigest !== undefined) {
        pendingShards.push({ cacheKey: key, attemptOrdinal: shard.attemptOrdinal,
          authorityLineageDigest: shard.authorityLineageDigest });
      }
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
  if (config.openSemantics?.revisions?.some((row) => !revisionsSeen.has(row.base_request_sha256))) {
    throw new AlayaError("CONFLICT", "source revision registry is not covered by the original source inventory");
  }
  return {
    missingKeys: missingKeys.sort(),
    pendingShards: pendingShards.sort((left, right) => left.cacheKey.localeCompare(right.cacheKey)),
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
  let head: string;
  try {
    const identity = readGitText(["rev-parse", "HEAD", "--show-toplevel"], checkoutRoot);
    const separator = identity.indexOf("\n");
    head = identity.slice(0, separator).trim();
    gitRoot = realpathSync(identity.slice(separator + 1));
  } catch (cause) {
    throw new AlayaError("CONFLICT", "cannot establish the loaded bench-runner Git checkout", { cause });
  }
  if (!samePhysicalLocation(gitRoot, checkoutRoot)) {
    throw new AlayaError("CONFLICT", "loaded bench-runner module is outside its Git checkout root");
  }
  return computeExtractionAuthorityWorktreeRevision({
    head,
    trackedDiff: readGitBuffer([
      "diff", "--no-ext-diff", "--no-textconv", "--binary", "HEAD", "--"
    ], checkoutRoot),
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
  const files = readGitBuffer(["ls-files", "--others", "--exclude-standard", "-z"], checkoutRoot)
    .toString("utf8").split("\0").filter((path) => path.length > 0)
    .map((path) => ({ path, mode: lstatSync(join(checkoutRoot, path)).mode & 0o777, blobDigest: "" }));
  // Keep Git's raw blob hashing (including symlink handling), with bounded argv
  // on Windows. Every inspection still reads every untracked file afresh.
  for (let start = 0; start < files.length;) {
    let end = start, argumentLength = 0;
    do { argumentLength += files[end++]!.path.length + 1; }
    while (end < files.length && argumentLength + files[end]!.path.length + 1 <= 8192);
    const batch = files.slice(start, end);
    const digests = readGitText(["hash-object", "--no-filters", "--", ...batch.map((file) => file.path)], checkoutRoot)
      .split(/\r?\n/u);
    if (digests.length !== batch.length || digests.some((digest) => !/^[a-f0-9]{40,64}$/u.test(digest))) {
      throw new AlayaError("CONFLICT", "cannot bind untracked files to Git blob identities");
    }
    batch.forEach((file, index) => { file.blobDigest = digests[index]!; });
    start = end;
  }
  return files;
}

const AUTHORITY_GIT_CONFIG = [
  "-c", "core.autocrlf=true",
  "-c", "core.fsmonitor=false",
  "-c", "core.untrackedCache=false",
  "-c", "credential.helper=",
  "-c", "core.askPass="
] as const;

function readGitText(args: readonly string[], checkoutRoot: string): string {
  return execFileSync("git", [...AUTHORITY_GIT_CONFIG, ...args], {
    cwd: checkoutRoot,
    env: gitProcessEnv(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"]
  }).trim();
}

function readGitBuffer(args: readonly string[], checkoutRoot: string): Buffer {
  return execFileSync("git", [...AUTHORITY_GIT_CONFIG, "--no-pager", ...args], {
    cwd: checkoutRoot,
    env: gitProcessEnv(),
    encoding: "buffer",
    // Authority binds the full patch; large legitimate retirements exceed Node's default.
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"]
  }) as Buffer;
}

/** Checkout identity does not read the caller's credentials or wait on a prompt. */
function gitProcessEnv(): NodeJS.ProcessEnv {
  return {
    ...nonCredentialChildEnv(),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_CONFIG_SYSTEM: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
    LC_ALL: "C"
  };
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}
