import { OFFICIAL_API_SYSTEM_PROMPT } from "@do-soul/alaya-soul";
import {
  resolveCompileSeedExtractionConfig,
  type CompileSeedExtractionConfig
} from "../compile-seed.js";
import { preflightExtractionCache } from "../compile-seed-preflight.js";
import {
  readExtractionCacheManifestIdentity,
  type ExtractionCacheManifest
} from "../extraction-cache-manifest.js";
import type { ExtractionFillOptions } from "../extraction-fill.js";
import type { LongMemEvalVariant } from "../dataset.js";
import { ExtractionCacheInvariantError } from "./cache-invariant-error.js";
import {
  assertExtractionFillComplete,
  inspectExtractionFillCompletion,
  type ExtractionFillCompletion
} from "./fill-completion.js";
import {
  pinExtractionCacheIdentity
} from "./fill-manifest.js";
import {
  captureExtractionCacheManifestSnapshot,
  restoreExtractionCacheManifestSnapshot,
  type ExtractionCacheManifestSnapshot
} from "./manifest-snapshot.js";
import {
  assertManifestlessCacheIsEmpty
} from "./fill-root-guard.js";
import { prepareExtractionFillWindow } from "./fill-window.js";
import type { LongMemEvalExpansionCapability } from
  "../promotion/expansion-capability.js";
import {
  revalidateExpansionFillAuthority,
  type PreparedExpansionFillAuthority
} from "./expansion-fill-authority.js";

export interface PreparedExtractionFill {
  readonly config: CompileSeedExtractionConfig;
  readonly existingManifest: ExtractionCacheManifest | undefined;
  readonly pinnedManifestSha256: string;
  readonly distinctTurns: readonly string[];
  readonly requestedTurns: number;
  readonly datasetRevision: string;
  readonly variant: LongMemEvalVariant;
  readonly windowOffset: number;
  readonly windowLimit: number;
  readonly expansion?: PreparedExpansionFillAuthority;
}

export interface InspectedExtractionFill {
  readonly manifestSnapshot: ExtractionCacheManifestSnapshot;
  readonly config: CompileSeedExtractionConfig;
  readonly distinctTurns: readonly string[];
  readonly requestedTurns: number;
  readonly datasetRevision: string;
  readonly variant: LongMemEvalVariant;
  readonly windowOffset: number;
  readonly windowLimit: number;
  readonly completion: ExtractionFillCompletion;
  readonly expansion?: PreparedExpansionFillAuthority;
}

export async function prepareExtractionFill(
  options: ExtractionFillOptions,
  cacheRoot: string,
  concurrency: number,
  log: (message: string) => void,
  expansion: PreparedExpansionFillAuthority | undefined
): Promise<PreparedExtractionFill> {
  const inspected = await inspectExtractionFillPreparation(options, cacheRoot, expansion);
  return pinInspectedExtractionFill(inspected, cacheRoot, concurrency, log);
}

export async function inspectExtractionFillPreparation(
  options: ExtractionFillOptions,
  cacheRoot: string,
  expansion: PreparedExpansionFillAuthority | undefined
): Promise<InspectedExtractionFill> {
  const manifestSnapshot = captureExtractionCacheManifestSnapshot(cacheRoot);
  const startingIdentity = manifestSnapshot.identity;
  const existingManifest = startingIdentity?.manifest;
  if (existingManifest === undefined) assertManifestlessCacheIsEmpty(cacheRoot);
  const config = resolveFillConfig(existingManifest);
  const { window, completion } = await inspectPreparedFillWindow({
    options, cacheRoot, startingIdentity, config, expansion
  });
  return {
    manifestSnapshot,
    config,
    distinctTurns: window.distinctTurns,
    requestedTurns: window.requestedTurns,
    datasetRevision: window.datasetRevision,
    variant: options.variant,
    windowOffset: window.windowOffset,
    windowLimit: window.questionCount,
    completion,
    ...(expansion === undefined ? {} : { expansion })
  };
}

export function pinInspectedExtractionFill(
  inspected: InspectedExtractionFill,
  cacheRoot: string,
  concurrency: number,
  log: (message: string) => void
): PreparedExtractionFill {
  const pinned = preflightAndPinExtractionIdentity({
    startingIdentity: inspected.manifestSnapshot.identity,
    cacheRoot,
    config: inspected.config,
    distinctTurns: inspected.distinctTurns,
    log,
    variant: inspected.variant,
    datasetRevision: inspected.datasetRevision,
    windowOffset: inspected.windowOffset,
    windowLimit: inspected.windowLimit,
    completion: inspected.completion,
    ...(inspected.expansion === undefined ? {} : {
      expansionSourceAnchor: inspected.expansion.sourceAnchor
    })
  });
  log(`[extraction-fill] variant=${inspected.variant} questions=${inspected.windowLimit} ` +
    `distinct_turns=${inspected.requestedTurns} model=${inspected.config.model} ` +
    `concurrency=${concurrency}`);
  return {
    config: inspected.config,
    existingManifest: pinned.manifest,
    pinnedManifestSha256: pinned.manifestSha256,
    distinctTurns: inspected.distinctTurns,
    requestedTurns: inspected.requestedTurns,
    datasetRevision: inspected.datasetRevision,
    variant: inspected.variant,
    windowOffset: inspected.windowOffset,
    windowLimit: inspected.windowLimit,
    ...(inspected.expansion === undefined ? {} : { expansion: inspected.expansion })
  };
}

export function restoreInspectedExtractionFill(
  inspected: InspectedExtractionFill,
  prepared: PreparedExtractionFill,
  cacheRoot: string
): void {
  restoreExtractionCacheManifestSnapshot(
    cacheRoot, inspected.manifestSnapshot, prepared.pinnedManifestSha256
  );
}

export function inspectFillWindow(
  cacheRoot: string,
  config: CompileSeedExtractionConfig,
  distinctTurns: readonly string[]
): ExtractionFillCompletion {
  return inspectExtractionFillCompletion({
    cacheRoot,
    model: config.model,
    requestProfile: config.requestProfile,
    systemPrompt: OFFICIAL_API_SYSTEM_PROMPT,
    turnContents: distinctTurns
  });
}

export function assertPinnedFillIdentity(
  prepared: PreparedExtractionFill,
  cacheRoot: string,
  writeLease: { assertOwned(): void }
): void {
  writeLease.assertOwned();
  const identity = readExtractionCacheManifestIdentity(cacheRoot);
  if (identity?.manifestSha256 !== prepared.pinnedManifestSha256) {
    throw new ExtractionCacheInvariantError(
      "extraction-fill cache manifest identity changed before finalization"
    );
  }
}

async function inspectPreparedFillWindow(input: {
  readonly options: ExtractionFillOptions;
  readonly cacheRoot: string;
  readonly startingIdentity: ReturnType<typeof readExtractionCacheManifestIdentity>;
  readonly config: CompileSeedExtractionConfig;
  readonly expansion: PreparedExpansionFillAuthority | undefined;
}) {
  const window = await prepareExtractionFillWindow(input.options, input.expansion);
  assertPreparationIdentityUnchanged(
    input.startingIdentity,
    readExtractionCacheManifestIdentity(input.cacheRoot)
  );
  const completion = inspectFillWindow(input.cacheRoot, input.config, window.distinctTurns);
  if (input.expansion !== undefined) revalidateExpansionFillAuthority(input.expansion);
  assertNoOrphanFillSubstrate(completion);
  return { window, completion };
}

function preflightAndPinExtractionIdentity(input: {
  readonly startingIdentity: ReturnType<typeof readExtractionCacheManifestIdentity>;
  readonly cacheRoot: string;
  readonly config: CompileSeedExtractionConfig;
  readonly distinctTurns: readonly string[];
  readonly log: (message: string) => void;
  readonly variant: LongMemEvalVariant;
  readonly datasetRevision: string;
  readonly windowOffset: number;
  readonly windowLimit: number;
  readonly completion: ExtractionFillCompletion;
  readonly expansionSourceAnchor?: PreparedExpansionFillAuthority["sourceAnchor"];
}) {
  const currentIdentity = readExtractionCacheManifestIdentity(input.cacheRoot);
  assertPreparationIdentityUnchanged(input.startingIdentity, currentIdentity);
  if (currentIdentity === undefined) assertManifestlessCacheIsEmpty(input.cacheRoot);
  preflightExtractionCache({
    cacheRoot: input.cacheRoot,
    manifest: currentIdentity?.manifest,
    config: input.config,
    systemPrompt: OFFICIAL_API_SYSTEM_PROMPT,
    requiredTurnContents: input.distinctTurns,
    requiredQuestionWindow: {
      offset: input.windowOffset,
      limit: input.windowLimit
    },
    allowLiveExtraction: true,
    liveExtractionPossible: input.config.apiKey !== null,
    warn: input.log
  });
  return pinExtractionCacheIdentity({
    cacheRoot: input.cacheRoot,
    config: input.config,
    variant: input.variant,
    existingIdentity: currentIdentity,
    datasetRevision: input.datasetRevision,
    windowOffset: input.windowOffset,
    windowLimit: input.windowLimit,
    completion: input.completion,
    ...(input.expansionSourceAnchor === undefined ? {} : {
      expansionSourceAnchor: input.expansionSourceAnchor
    })
  });
}

function resolveFillConfig(
  manifest: ExtractionCacheManifest | undefined
): CompileSeedExtractionConfig {
  const config = resolveCompileSeedExtractionConfig(process.env, manifest);
  if (config.model.trim().length > 0) return config;
  throw new Error(
    "extraction-fill: resolved extraction model is empty; refusing to fill " +
      "the cache with an unkeyable model."
  );
}

function assertPreparationIdentityUnchanged(
  starting: ReturnType<typeof readExtractionCacheManifestIdentity>,
  current: ReturnType<typeof readExtractionCacheManifestIdentity>
): void {
  if (starting?.manifestSha256 === current?.manifestSha256) return;
  throw new ExtractionCacheInvariantError(
    "extraction cache manifest changed during dataset preparation"
  );
}

function assertNoOrphanFillSubstrate(completion: ExtractionFillCompletion): void {
  if (completion.orphanTurns === 0) return;
  throw new ExtractionCacheInvariantError(
    `extraction-fill cache contains ${completion.orphanTurns} shard(s) outside ` +
      "the requested window; use a dedicated cache root for this exact window"
  );
}
