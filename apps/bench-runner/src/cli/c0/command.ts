import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
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
  assertFreshC0RebuildRoot,
  decideC0Reuse,
  type C0CacheCompatibilityIdentity,
  type C0ReuseDecision
} from "../../longmemeval/extraction/c0/decision.js";
import {
  buildC0DecisionReceipt,
  writeC0DecisionReceipt,
  writeC0EvidenceArtifact,
  type C0DecisionReceipt
} from "../../longmemeval/extraction/c0/decision-receipt.js";
import {
  buildC0OccurrenceIndex,
  hashC0OccurrenceIndex,
  type C0ExtractionOccurrence
} from "../../longmemeval/extraction/c0/occurrence-index.js";
import {
  hashC0RawShardInventory,
  inspectC0RawShardInventory,
  type C0RawShardInventory
} from "../../longmemeval/extraction/c0/raw-inventory.js";
import {
  hashC0Replay,
  replayC0Occurrences,
  type C0ReplayResult
} from "../../longmemeval/extraction/c0/replay.js";

const C0_TEMPORAL_SCHEMA_REVISION = "relation-assertion-v1";

interface C0CommandArgs {
  readonly sourceCacheRoot: string;
  readonly targetCacheRoot: string;
  readonly evidenceRoot: string;
  readonly finalModel: string;
  readonly finalModelFamily: string;
  readonly finalRequestProfile: ExtractionRequestProfile;
  readonly finalProviderUrl: string;
}

export interface C0ReuseEvidenceRun {
  readonly sourceRoot: string;
  readonly targetRoot: string;
  readonly evidenceRoot: string;
  readonly sourceManifestRaw: string;
  readonly sourceManifestSha256: string;
  readonly inventory: C0RawShardInventory;
  readonly inventorySha256: string;
  readonly occurrences: readonly C0ExtractionOccurrence[];
  readonly occurrenceIndexSha256: string;
  readonly replay: C0ReplayResult;
  readonly replaySha256: string;
  readonly decision: C0ReuseDecision;
  readonly receipt: C0DecisionReceipt;
}

export async function runC0ReuseDecisionCommand(
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
    assertC0Scope(flags.variant, flags.offset, flags.limit);
    const run = await buildC0ReuseEvidence({
      args: parseC0CommandArgs(args),
      dataDir: flags.dataDir,
      pinnedMetaRoot: flags.pinnedMetaRoot,
      loadDataset: dependencies.loadDataset ?? loadDatasetWithIdentity,
      now: dependencies.now ?? (() => new Date().toISOString())
    });
    writeC0EvidenceBundle(run);
    (dependencies.writeStdout ?? process.stdout.write.bind(process.stdout))(renderRun(run));
    return 0;
  } catch (error) {
    (dependencies.writeStderr ?? process.stderr.write.bind(process.stderr))(
      `alaya-bench-runner c0-reuse-decision: ${error instanceof Error ? error.message : String(error)}\n`
    );
    return 2;
  }
}

export async function buildC0ReuseEvidence(input: {
  readonly args: C0CommandArgs;
  readonly dataDir?: string;
  readonly pinnedMetaRoot?: string;
  readonly loadDataset: typeof loadDatasetWithIdentity;
  readonly now: () => string;
}): Promise<C0ReuseEvidenceRun> {
  const sourceRoot = requireCanonicalDirectory(input.args.sourceCacheRoot, "C0 source cache root");
  const targetRoot = resolve(input.args.targetCacheRoot);
  const evidenceRoot = resolve(input.args.evidenceRoot);
  assertNewPath(evidenceRoot, "C0 evidence root");
  assertTargetAndEvidenceRoots(sourceRoot, targetRoot, evidenceRoot);
  const source = readC0Source(sourceRoot);
  const dataset = await input.loadDataset("longmemeval_s", {
    ...(input.dataDir === undefined ? {} : { dataDir: input.dataDir }),
    ...(input.pinnedMetaRoot === undefined ? {} : { pinnedMetaRoot: input.pinnedMetaRoot })
  });
  if (dataset.questions.length < 100) throw new Error("C0 requires at least 100 LongMemEval-S questions");
  assertSourcePrompt(source.manifest);
  const occurrences = buildC0OccurrenceIndex({
    questions: dataset.questions.slice(0, 100),
    model: source.manifest.extraction_model,
    requestProfile: source.manifest.request_profile,
    systemPrompt: OFFICIAL_API_SYSTEM_PROMPT
  });
  const inventory = inspectC0RawShardInventory({
    cacheRoot: sourceRoot,
    cacheKeys: occurrences.map((occurrence) => occurrence.cacheKey),
    model: source.manifest.extraction_model,
    requestProfile: source.manifest.request_profile
  });
  const replay = replayC0Occurrences({
    cacheRoot: sourceRoot,
    model: source.manifest.extraction_model,
    requestProfile: source.manifest.request_profile,
    occurrences
  });
  const inventorySha256 = hashC0RawShardInventory(inventory);
  const occurrenceIndexSha256 = hashC0OccurrenceIndex(occurrences);
  const decision = decideC0Reuse({
    sourceRoot,
    source: sourceIdentity(source.manifest, inventorySha256),
    final: finalIdentity(input.args, dataset.sha256, inventorySha256),
    replay: replay.closure,
    rawInventoryClosed: inventory.orphanKeys.length === 0 && inventory.unexpectedPaths.length === 0
  });
  assertDecisionTarget(decision, sourceRoot, targetRoot);
  const receipt = buildC0DecisionReceipt({
    createdAt: input.now(),
    sourceRoot,
    sourceManifestSha256: source.manifestSha256,
    rawInventorySha256: inventorySha256,
    occurrenceIndexSha256,
    decision
  });
  return Object.freeze({
    sourceRoot,
    targetRoot,
    evidenceRoot,
    sourceManifestRaw: source.raw,
    sourceManifestSha256: source.manifestSha256,
    inventory,
    inventorySha256,
    occurrences,
    occurrenceIndexSha256,
    replay,
    replaySha256: hashC0Replay(replay),
    decision,
    receipt
  });
}

function readC0Source(sourceRoot: string): {
  readonly raw: string;
  readonly manifest: ExtractionCacheManifestV3;
  readonly manifestSha256: string;
} {
  const manifestPath = extractionCacheManifestPath(sourceRoot);
  const raw = readFileSync(manifestPath, "utf8");
  const identity = readExtractionCacheManifestIdentity(sourceRoot);
  if (identity === undefined || identity.manifest.schema_version !== 3) {
    throw new Error("C0 source cache requires a schema-version-3 manifest");
  }
  return { raw, manifest: identity.manifest, manifestSha256: identity.manifestSha256 };
}

function assertSourcePrompt(manifest: ExtractionCacheManifestV3): void {
  if (manifest.system_prompt_sha256 !== computeSystemPromptSha256(OFFICIAL_API_SYSTEM_PROMPT)) {
    throw new Error(
      "C0 cannot derive exact source cache keys because the source prompt differs from current code"
    );
  }
}

function sourceIdentity(
  manifest: ExtractionCacheManifestV3,
  rawClosureSha256: string
): C0CacheCompatibilityIdentity {
  return {
    datasetRevision: manifest.dataset_revision,
    model: manifest.extraction_model,
    modelFamily: extractionModelFamily(manifest),
    requestProfile: manifest.request_profile,
    providerUrl: normalizeProviderUrl(manifest.provider_url),
    systemPromptSha256: manifest.system_prompt_sha256,
    cacheKeyAlgorithm: manifest.cache_key_algo,
    rawClosureSha256,
    // Legacy cache manifests never recorded these execution semantics.
    parserSemanticsSha256: "",
    formationSemanticsSha256: "",
    temporalSchemaRevision: ""
  };
}

function finalIdentity(
  args: C0CommandArgs,
  datasetRevision: string,
  rawClosureSha256: string
): C0CacheCompatibilityIdentity {
  return {
    datasetRevision,
    model: args.finalModel,
    modelFamily: args.finalModelFamily,
    requestProfile: args.finalRequestProfile,
    providerUrl: args.finalProviderUrl,
    systemPromptSha256: computeSystemPromptSha256(OFFICIAL_API_SYSTEM_PROMPT),
    cacheKeyAlgorithm: EXTRACTION_CACHE_KEY_ALGO,
    rawClosureSha256,
    parserSemanticsSha256: hashString(OFFICIAL_API_SIGNAL_PARSER_SEMANTICS_VERSION),
    formationSemanticsSha256: hashString(OFFICIAL_API_FORMATION_AUDIT_SEMANTICS_VERSION),
    temporalSchemaRevision: C0_TEMPORAL_SCHEMA_REVISION
  };
}

function assertDecisionTarget(
  decision: C0ReuseDecision,
  sourceRoot: string,
  targetRoot: string
): void {
  if (decision.action === "rebuild") {
    assertFreshC0RebuildRoot({ sourceRoot, targetRoot });
    return;
  }
  if (sourceRoot !== targetRoot) {
    throw new Error("C0 reuse requires the target cache root to be the verified source root");
  }
}

function assertTargetAndEvidenceRoots(
  sourceRoot: string,
  targetRoot: string,
  evidenceRoot: string
): void {
  if (sourceRoot !== targetRoot) {
    assertNewPath(targetRoot, "C0 target cache root");
    if (pathsOverlap(sourceRoot, targetRoot)) {
      throw new Error("C0 source and rebuild target roots must not overlap");
    }
  }
  if (pathsOverlap(evidenceRoot, sourceRoot) || pathsOverlap(evidenceRoot, targetRoot)) {
    throw new Error("C0 evidence root must not overlap source or target cache roots");
  }
}

function writeC0EvidenceBundle(run: C0ReuseEvidenceRun): void {
  writeC0EvidenceArtifact(`${run.evidenceRoot}/source-manifest.json`, run.sourceManifestRaw);
  writeC0EvidenceArtifact(`${run.evidenceRoot}/raw-inventory.json`, renderJson({
    sha256: run.inventorySha256,
    inventory: run.inventory
  }));
  writeC0EvidenceArtifact(`${run.evidenceRoot}/occurrence-index.json`, renderJson({
    sha256: run.occurrenceIndexSha256,
    occurrences: run.occurrences.map(renderOccurrence)
  }));
  writeC0EvidenceArtifact(`${run.evidenceRoot}/replay-ledger.json`, renderJson({
    sha256: run.replaySha256,
    closure: run.replay.closure,
    occurrences: run.replay.occurrences.map((occurrence) => ({
      occurrence: renderOccurrence(occurrence.occurrence),
      raw_json_sha256: occurrence.rawJsonSha256,
      entries: occurrence.entries
    }))
  }));
  writeC0DecisionReceipt(`${run.evidenceRoot}/decision.json`, run.receipt);
}

function renderOccurrence(occurrence: C0ExtractionOccurrence) {
  return {
    id: occurrence.id,
    evidence_ref: occurrence.evidenceRef,
    question_id: occurrence.questionId,
    session_index: occurrence.sessionIndex,
    round_index: occurrence.roundIndex,
    source_observed_at: occurrence.sourceObservedAt,
    turn_content_sha256: hashString(occurrence.turnContent),
    cache_key: occurrence.cacheKey
  };
}

function parseC0CommandArgs(args: ReadonlyArray<string>): C0CommandArgs {
  const requestProfile = requiredFlag(args, "--c0-final-request-profile");
  if (!EXTRACTION_REQUEST_PROFILES.includes(requestProfile as ExtractionRequestProfile)) {
    throw new Error("--c0-final-request-profile must name a supported extraction profile");
  }
  return {
    sourceCacheRoot: requiredFlag(args, "--extraction-cache-root"),
    targetCacheRoot: requiredFlag(args, "--c0-target-cache-root"),
    evidenceRoot: requiredFlag(args, "--c0-evidence-root"),
    finalModel: requiredNonEmptyFlag(args, "--c0-final-model"),
    finalModelFamily: requiredNonEmptyFlag(args, "--c0-final-model-family"),
    finalRequestProfile: requestProfile as ExtractionRequestProfile,
    finalProviderUrl: normalizeProviderUrl(requiredFlag(args, "--c0-final-provider-url"))
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

function assertC0Scope(variant: string, offset: number | undefined, limit: number | undefined): void {
  if (variant !== "longmemeval_s" || (offset ?? 0) !== 0 || limit !== 100) {
    throw new Error("C0 must replay exactly LongMemEval-S questions 0 through 99");
  }
}

function requireCanonicalDirectory(path: string, label: string): string {
  if (!existsSync(path) || lstatSync(path).isSymbolicLink() || !lstatSync(path).isDirectory()) {
    throw new Error(`${label} must be an existing non-symlink directory`);
  }
  return realpathSync(path);
}

function assertNewPath(path: string, label: string): void {
  if (existsSync(path)) throw new Error(`${label} must not exist before C0 evidence is written`);
  let ancestor = dirname(path);
  while (!existsSync(ancestor)) ancestor = dirname(ancestor);
  if (lstatSync(ancestor).isSymbolicLink()) {
    throw new Error(`${label} must not traverse a symbolic-link ancestor`);
  }
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
    throw new Error("C0 provider URL must be an http(s) base URL without credentials, query, or fragment");
  }
  const normalized = parsed.toString().replace(/\/+$/u, "");
  return normalized.endsWith("/chat/completions")
    ? normalized.slice(0, -"/chat/completions".length)
    : normalized;
}

function hashString(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function renderJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function renderRun(run: C0ReuseEvidenceRun): string {
  const counts = run.inventory.counts;
  return `C0 decision=${run.decision.action} receipt=${run.receipt.decision_digest}\n` +
    `  source_manifest=${run.sourceManifestSha256} inventory=${run.inventorySha256}\n` +
    `  occurrences=${run.occurrences.length} expected=${counts.expected} hit=${counts.hit} ` +
    `missing=${counts.missing} invalid=${counts.invalid} orphan=${counts.orphan}\n` +
    `  replay=${run.replaySha256} admitted=${run.replay.closure.admitted} ` +
    `deferred=${run.replay.closure.deferred} rejected=${run.replay.closure.rejected} ` +
    `invalid=${run.replay.closure.invalid}\n` +
    `  evidence=${run.evidenceRoot} lock_migration=not_attempted\n`;
}
