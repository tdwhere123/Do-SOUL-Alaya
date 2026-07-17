import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import process from "node:process";
import {
  OFFICIAL_API_FORMATION_AUDIT_SEMANTICS_VERSION,
  OFFICIAL_API_SIGNAL_PARSER_SEMANTICS_VERSION,
  OFFICIAL_API_SYSTEM_PROMPT
} from "@do-soul/alaya-soul";
import { parseFlags } from "../cli-options.js";
import {
  EXTRACTION_CACHE_KEY_ALGO,
  EXTRACTION_REQUEST_PROFILES,
  computeSystemPromptSha256,
  extractionCacheManifestPath,
  extractionModelFamily,
  readExtractionCacheManifestIdentity,
  type ExtractionCacheManifestV3,
  type ExtractionRequestProfile
} from "../../longmemeval/extraction-cache-manifest.js";
import { loadDatasetWithIdentity } from "../../longmemeval/fetch.js";
import {
  assertFreshExtractionCacheRoot,
  decideExtractionCacheCompatibility,
  type ExtractionCacheCompatibilityDecision,
  type ExtractionCacheCompatibilityIdentity
} from "../../longmemeval/extraction/cache-audit/compatibility.js";
import {
  buildExtractionCacheAuditReceipt,
  type ExtractionCacheAuditReceipt
} from "../../longmemeval/extraction/cache-audit/receipt.js";
import {
  buildExtractionOccurrenceIndex,
  hashExtractionOccurrenceIndex,
  type ExtractionOccurrence
} from "../../longmemeval/extraction/cache-audit/occurrence-index.js";
import {
  hashExtractionCacheInventory,
  inspectExtractionCacheInventory,
  type ExtractionCacheInventory
} from "../../longmemeval/extraction/cache-audit/inventory.js";
import {
  hashExtractionReplay,
  replayExtractionOccurrences,
  type ExtractionReplayResult
} from "../../longmemeval/extraction/cache-audit/replay.js";
import { writeExtractionCacheAuditBundle } from "./bundle-writer.js";

const TEMPORAL_SCHEMA_REVISION = "relation-assertion-v1";

interface CacheAuditCommandArgs {
  readonly sourceCacheRoot: string;
  readonly rebuildCacheRoot: string;
  readonly auditOutput: string;
  readonly targetModel: string;
  readonly targetModelFamily: string;
  readonly targetRequestProfile: ExtractionRequestProfile;
  readonly targetProviderUrl: string;
}

export interface ExtractionCacheAuditRun {
  readonly sourceRoot: string;
  readonly targetRoot: string;
  readonly auditOutput: string;
  readonly sourceManifestRaw: string;
  readonly sourceManifestSha256: string;
  readonly inventory: ExtractionCacheInventory;
  readonly inventorySha256: string;
  readonly occurrences: readonly ExtractionOccurrence[];
  readonly occurrenceIndexSha256: string;
  readonly replay: ExtractionReplayResult;
  readonly replaySha256: string;
  readonly decision: ExtractionCacheCompatibilityDecision;
  readonly receipt: ExtractionCacheAuditReceipt;
}

interface ExtractionCacheAnalysis {
  readonly inventory: ExtractionCacheInventory;
  readonly inventorySha256: string;
  readonly occurrences: readonly ExtractionOccurrence[];
  readonly occurrenceIndexSha256: string;
  readonly replay: ExtractionReplayResult;
  readonly replaySha256: string;
  readonly decision: ExtractionCacheCompatibilityDecision;
}

export async function runAuditExtractionCacheCommand(
  args: ReadonlyArray<string>,
  dependencies: {
    readonly loadDataset?: typeof loadDatasetWithIdentity;
    readonly now?: () => string;
    readonly writeStdout?: (text: string) => void;
    readonly writeStderr?: (text: string) => void;
  } = {}
): Promise<number> {
  try {
    const flags = parseFlags(args);
    assertCacheAuditScope(flags.variant, flags.offset, flags.limit);
    const run = await buildExtractionCacheAudit({
      args: parseCacheAuditCommandArgs(args),
      dataDir: flags.dataDir,
      pinnedMetaRoot: flags.pinnedMetaRoot,
      loadDataset: dependencies.loadDataset ?? loadDatasetWithIdentity,
      now: dependencies.now ?? (() => new Date().toISOString())
    });
    writeExtractionCacheAuditBundle(run);
    (dependencies.writeStdout ?? process.stdout.write.bind(process.stdout))(renderRun(run));
    return 0;
  } catch (error) {
    (dependencies.writeStderr ?? process.stderr.write.bind(process.stderr))(
      `alaya-bench-runner audit-extraction-cache: ${error instanceof Error ? error.message : String(error)}\n`
    );
    return 2;
  }
}

export async function buildExtractionCacheAudit(input: {
  readonly args: CacheAuditCommandArgs;
  readonly dataDir?: string;
  readonly pinnedMetaRoot?: string;
  readonly loadDataset: typeof loadDatasetWithIdentity;
  readonly now: () => string;
}): Promise<ExtractionCacheAuditRun> {
  const { sourceRoot, targetRoot, auditOutput } = resolveCacheAuditRoots(input.args);
  const source = readAuditedSource(sourceRoot);
  const dataset = await input.loadDataset("longmemeval_s", {
    ...(input.dataDir === undefined ? {} : { dataDir: input.dataDir }),
    ...(input.pinnedMetaRoot === undefined ? {} : { pinnedMetaRoot: input.pinnedMetaRoot })
  });
  if (dataset.questions.length < 100) {
    throw new Error("cache audit requires at least 100 LongMemEval-S questions");
  }
  assertSourcePrompt(source.manifest);
  const analysis = analyzeExtractionCache({
    args: input.args,
    sourceRoot,
    sourceManifest: source.manifest,
    dataset
  });
  assertDecisionTarget(analysis.decision, sourceRoot, targetRoot);
  const receipt = buildExtractionCacheAuditReceipt({
    createdAt: input.now(),
    sourceRoot,
    sourceManifestSha256: source.manifestSha256,
    rawInventorySha256: analysis.inventorySha256,
    occurrenceIndexSha256: analysis.occurrenceIndexSha256,
    decision: analysis.decision
  });
  return Object.freeze({
    sourceRoot,
    targetRoot,
    auditOutput,
    sourceManifestRaw: source.raw,
    sourceManifestSha256: source.manifestSha256,
    ...analysis,
    receipt
  });
}

function resolveCacheAuditRoots(args: CacheAuditCommandArgs): {
  readonly sourceRoot: string;
  readonly targetRoot: string;
  readonly auditOutput: string;
} {
  const sourceRoot = requireCanonicalDirectory(
    args.sourceCacheRoot,
    "source extraction cache root"
  );
  const targetRoot = resolveCacheTarget(args.rebuildCacheRoot);
  const auditOutput = resolveNewChildPath(args.auditOutput, "cache audit output");
  assertTargetAndAuditRoots(sourceRoot, targetRoot, auditOutput);
  return { sourceRoot, targetRoot, auditOutput };
}

function analyzeExtractionCache(input: {
  readonly args: CacheAuditCommandArgs;
  readonly sourceRoot: string;
  readonly sourceManifest: ExtractionCacheManifestV3;
  readonly dataset: Awaited<ReturnType<typeof loadDatasetWithIdentity>>;
}): ExtractionCacheAnalysis {
  const occurrences = buildExtractionOccurrenceIndex({
    questions: input.dataset.questions.slice(0, 100),
    model: input.sourceManifest.extraction_model,
    requestProfile: input.sourceManifest.request_profile,
    systemPrompt: OFFICIAL_API_SYSTEM_PROMPT
  });
  const inventory = inspectExtractionCacheInventory({
    cacheRoot: input.sourceRoot,
    cacheKeys: occurrences.map((occurrence) => occurrence.cacheKey),
    model: input.sourceManifest.extraction_model,
    requestProfile: input.sourceManifest.request_profile
  });
  const inventorySha256 = hashExtractionCacheInventory(inventory);
  const replay = replayExtractionOccurrences({
    cacheRoot: input.sourceRoot,
    model: input.sourceManifest.extraction_model,
    requestProfile: input.sourceManifest.request_profile,
    occurrences
  });
  const decision = decideExtractionCacheCompatibility({
    sourceRoot: input.sourceRoot,
    source: sourceIdentity(input.sourceManifest, inventorySha256),
    final: finalIdentity(input.args, input.dataset.sha256, inventorySha256),
    replay: replay.closure,
    rawInventoryClosed: inventory.orphanKeys.length === 0 && inventory.unexpectedPaths.length === 0
  });
  return {
    inventory,
    inventorySha256,
    occurrences,
    occurrenceIndexSha256: hashExtractionOccurrenceIndex(occurrences),
    replay,
    replaySha256: hashExtractionReplay(replay),
    decision
  };
}

function readAuditedSource(sourceRoot: string): {
  readonly raw: string;
  readonly manifest: ExtractionCacheManifestV3;
  readonly manifestSha256: string;
} {
  const manifestPath = extractionCacheManifestPath(sourceRoot);
  const raw = readFileSync(manifestPath, "utf8");
  const identity = readExtractionCacheManifestIdentity(sourceRoot);
  if (identity === undefined || identity.manifest.schema_version !== 3) {
    throw new Error("cache audit source requires a schema-version-3 manifest");
  }
  return { raw, manifest: identity.manifest, manifestSha256: identity.manifestSha256 };
}

function assertSourcePrompt(manifest: ExtractionCacheManifestV3): void {
  if (manifest.system_prompt_sha256 !== computeSystemPromptSha256(OFFICIAL_API_SYSTEM_PROMPT)) {
    throw new Error(
      "cache audit cannot derive exact source keys because the source prompt differs from current code"
    );
  }
}

function sourceIdentity(
  manifest: ExtractionCacheManifestV3,
  rawClosureSha256: string
): ExtractionCacheCompatibilityIdentity {
  return {
    datasetRevision: manifest.dataset_revision,
    model: manifest.extraction_model,
    modelFamily: extractionModelFamily(manifest),
    requestProfile: manifest.request_profile,
    providerUrl: normalizeProviderUrl(manifest.provider_url),
    systemPromptSha256: manifest.system_prompt_sha256,
    cacheKeyAlgorithm: manifest.cache_key_algo,
    rawClosureSha256,
    // Schema-version-3 manifests do not record these execution semantics.
    parserSemanticsSha256: "",
    formationSemanticsSha256: "",
    temporalSchemaRevision: ""
  };
}

function finalIdentity(
  args: CacheAuditCommandArgs,
  datasetRevision: string,
  rawClosureSha256: string
): ExtractionCacheCompatibilityIdentity {
  return {
    datasetRevision,
    model: args.targetModel,
    modelFamily: args.targetModelFamily,
    requestProfile: args.targetRequestProfile,
    providerUrl: args.targetProviderUrl,
    systemPromptSha256: computeSystemPromptSha256(OFFICIAL_API_SYSTEM_PROMPT),
    cacheKeyAlgorithm: EXTRACTION_CACHE_KEY_ALGO,
    rawClosureSha256,
    parserSemanticsSha256: hashString(OFFICIAL_API_SIGNAL_PARSER_SEMANTICS_VERSION),
    formationSemanticsSha256: hashString(OFFICIAL_API_FORMATION_AUDIT_SEMANTICS_VERSION),
    temporalSchemaRevision: TEMPORAL_SCHEMA_REVISION
  };
}

function assertDecisionTarget(
  decision: ExtractionCacheCompatibilityDecision,
  sourceRoot: string,
  targetRoot: string
): void {
  if (decision.action === "rebuild") {
    assertFreshExtractionCacheRoot({ sourceRoot, targetRoot });
    return;
  }
  if (sourceRoot !== targetRoot) {
    throw new Error("cache reuse requires the target root to be the verified source root");
  }
}

function assertTargetAndAuditRoots(
  sourceRoot: string,
  targetRoot: string,
  auditOutput: string
): void {
  if (sourceRoot !== targetRoot) {
    if (pathsOverlap(sourceRoot, targetRoot)) {
      throw new Error("source and rebuild extraction cache roots must not overlap");
    }
  }
  if (pathsOverlap(auditOutput, sourceRoot) || pathsOverlap(auditOutput, targetRoot)) {
    throw new Error("cache audit output must not overlap source or rebuild cache roots");
  }
}

function parseCacheAuditCommandArgs(args: ReadonlyArray<string>): CacheAuditCommandArgs {
  const requestProfile = requiredFlag(args, "--target-request-profile");
  if (!EXTRACTION_REQUEST_PROFILES.includes(requestProfile as ExtractionRequestProfile)) {
    throw new Error("--target-request-profile must name a supported extraction profile");
  }
  return {
    sourceCacheRoot: requiredFlag(args, "--extraction-cache-root"),
    rebuildCacheRoot: requiredFlag(args, "--rebuild-cache-root"),
    auditOutput: requiredFlag(args, "--cache-audit-output"),
    targetModel: requiredNonEmptyFlag(args, "--target-model"),
    targetModelFamily: requiredNonEmptyFlag(args, "--target-model-family"),
    targetRequestProfile: requestProfile as ExtractionRequestProfile,
    targetProviderUrl: normalizeProviderUrl(requiredFlag(args, "--target-provider-url"))
  };
}

function requiredFlag(args: ReadonlyArray<string>, flag: string): string {
  const values = flagValues(args, flag);
  if (values.length !== 1 || values[0] === undefined || values[0].startsWith("--")) {
    throw new Error(`${flag} requires exactly one value`);
  }
  return values[0];
}

function requiredNonEmptyFlag(args: ReadonlyArray<string>, flag: string): string {
  const value = requiredFlag(args, flag).trim();
  if (value.length === 0) throw new Error(`${flag} must not be empty`);
  return value;
}

function flagValues(args: ReadonlyArray<string>, flag: string): readonly string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === flag) values.push(args[index + 1] ?? "");
    if (token?.startsWith(`${flag}=`)) values.push(token.slice(flag.length + 1));
  }
  return values;
}

function assertCacheAuditScope(
  variant: string,
  offset: number | undefined,
  limit: number | undefined
): void {
  if (variant !== "longmemeval_s" || (offset ?? 0) !== 0 || limit !== 100) {
    throw new Error("cache audit must replay exactly LongMemEval-S questions 0 through 99");
  }
}

function requireCanonicalDirectory(path: string, label: string): string {
  if (!existsSync(path) || lstatSync(path).isSymbolicLink() || !lstatSync(path).isDirectory()) {
    throw new Error(`${label} must be an existing non-symlink directory`);
  }
  return realpathSync(path);
}

function resolveCacheTarget(path: string): string {
  const resolved = resolve(path);
  if (!existsSync(resolved)) {
    return resolveNewChildPath(resolved, "extraction cache rebuild root");
  }
  if (lstatSync(resolved).isSymbolicLink() || !lstatSync(resolved).isDirectory()) {
    throw new Error("extraction cache target must be a directory or a fresh child path");
  }
  return realpathSync(resolved);
}

function resolveNewChildPath(path: string, label: string): string {
  const resolved = resolve(path);
  if (existsSync(resolved)) throw new Error(`${label} must not exist before the audit is written`);
  const parent = dirname(resolved);
  if (!existsSync(parent) || lstatSync(parent).isSymbolicLink() ||
      !lstatSync(parent).isDirectory()) {
    throw new Error(`${label} parent must be an existing non-symlink directory`);
  }
  const canonical = join(realpathSync(parent), basename(resolved));
  if (existsSync(canonical)) throw new Error(`${label} canonical path already exists`);
  return canonical;
}

function pathsOverlap(left: string, right: string): boolean {
  return isNested(left, right) || isNested(right, left);
}

function isNested(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

function normalizeProviderUrl(value: string): string {
  const parsed = new URL(value.trim());
  if ((parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
      parsed.username !== "" || parsed.password !== "" || parsed.search !== "" || parsed.hash !== "") {
    throw new Error(
      "target provider URL must be an http(s) base URL without credentials, query, or fragment"
    );
  }
  const normalized = parsed.toString().replace(/\/+$/u, "");
  return normalized.endsWith("/chat/completions")
    ? normalized.slice(0, -"/chat/completions".length)
    : normalized;
}

function hashString(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function renderRun(run: ExtractionCacheAuditRun): string {
  const counts = run.inventory.counts;
  return `Extraction cache compatibility=${run.decision.action} ` +
    `receipt=${run.receipt.decision_digest}\n` +
    `  source_manifest=${run.sourceManifestSha256} inventory=${run.inventorySha256}\n` +
    `  occurrences=${run.occurrences.length} expected=${counts.expected} hit=${counts.hit} ` +
    `missing=${counts.missing} invalid=${counts.invalid} orphan=${counts.orphan}\n` +
    `  replay=${run.replaySha256} admitted=${run.replay.closure.admitted} ` +
    `deferred=${run.replay.closure.deferred} rejected=${run.replay.closure.rejected} ` +
    `invalid=${run.replay.closure.invalid}\n` +
    `  audit_output=${run.auditOutput}\n`;
}
