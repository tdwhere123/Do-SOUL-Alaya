import { isDeepStrictEqual } from "node:util";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { ExtractionCacheManifestV3 } from
  "../../../cache/extraction-cache-manifest.js";
import type { ExtractionCacheInventory } from "../../inventory.js";
import {
  emptyAttemptTelemetry, readAttemptLedgerRecordEnvelope
} from "../../../authority/attempt-ledger/contract.js";
import { readCatalogRefillResumeManifestRecord } from
  "../../../authority/catalog-refill/resume-manifest.js";
import { computeExtractionFillAttemptCeiling } from
  "../../../authority/receipt-limits.js";
import {
  MATERIALIZATION_COMMIT_NAME, type ExtractionCacheMaterializationCommit
} from "../contract.js";

const TARGET_MARKER = ".alaya-extraction-target-root.json";
const WRITE_LOCK = ".extraction-fill.lock";
const LEDGER = /^extraction-attempt-ledger\.([a-f0-9]{64})\.json$/u;
const RESUME = /^\.catalog-refill-resume\.([a-f0-9]{64})\.json$/u;
const COMPLETION = /^\.catalog-refill-completion\.([a-f0-9]{64})\.json$/u;

export function assertPristineInProgressSuccessor(input: {
  readonly targetRoot: string;
  readonly commit: ExtractionCacheMaterializationCommit;
  readonly manifest: ExtractionCacheManifestV3;
  readonly manifestSha256: string;
  readonly inventory: ExtractionCacheInventory;
}): void {
  assertManifest(input.commit, input.manifest, input.manifestSha256);
  assertInventory(input.commit, input.inventory);
  const controls = classifyRootEntries(input.targetRoot, input.commit);
  if (controls.completions.length !== 0) throw unknownControl();
  const ledgers = readPristineLedgers(
    input.targetRoot, input.commit, controls.ledgers, undefined
  );
  assertResumeRecords(input.targetRoot, controls.resumes, ledgers);
  assertControlInventory(input.inventory, controls);
}

export function assertCompletedSuccessorControls(input: {
  readonly targetRoot: string;
  readonly commit: ExtractionCacheMaterializationCommit;
  readonly inventory: Pick<ExtractionCacheInventory, "controlArtifactPaths" | "unexpectedPaths"> |
    { readonly controlArtifactPaths: readonly string[]; readonly unexpectedPaths?: readonly string[] };
  readonly activeLineageDigest: string;
  readonly completionReceiptDigest: string;
}): void {
  const controls = classifyRootEntries(input.targetRoot, input.commit);
  const expectedCompletion = `.catalog-refill-completion.${input.completionReceiptDigest}.json`;
  if (!controls.ledgers.includes(`extraction-attempt-ledger.${input.activeLineageDigest}.json`) ||
      !sameStrings(controls.completions, [expectedCompletion])) throw unknownControl();
  const pristine = readPristineLedgers(
    input.targetRoot, input.commit, controls.ledgers, input.activeLineageDigest
  );
  assertResumeRecords(input.targetRoot, controls.resumes, pristine);
  assertControlInventory(input.inventory, controls);
}

function assertManifest(
  commit: ExtractionCacheMaterializationCommit,
  manifest: ExtractionCacheManifestV3,
  manifestSha256: string
): void {
  const initial = commit.initial_target_manifest;
  const expected = { ...initial, built_at: manifest.built_at, builder: "extraction-fill" };
  if (manifestSha256 === commit.target_manifest_sha256 ||
      manifest.fill_status !== "in_progress" ||
      !isDeepStrictEqual(manifest, expected) ||
      !Number.isFinite(Date.parse(manifest.built_at)) ||
      Date.parse(manifest.built_at) < Date.parse(initial.built_at)) {
    throw new Error("materialized successor manifest is not a pristine in-progress refill");
  }
}

function assertInventory(
  commit: ExtractionCacheMaterializationCommit,
  inventory: ExtractionCacheInventory
): void {
  const origin = new Set(commit.shards.map((shard) => shard.cache_key));
  const remaining = new Set(commit.remaining_keys);
  if (inventory.counts.expected !== commit.expected_turns ||
      inventory.counts.hit !== commit.shards.length ||
      inventory.counts.missing !== commit.remaining_key_count ||
      inventory.counts.invalid !== 0 || inventory.counts.orphan !== 0 ||
      inventory.shards.some((shard) => origin.has(shard.cacheKey)
        ? shard.status !== "hit"
        : !remaining.has(shard.cacheKey) || shard.status !== "missing")) {
    throw new Error("materialized in-progress successor inventory is not pristine");
  }
}

function classifyRootEntries(
  targetRoot: string,
  commit: ExtractionCacheMaterializationCommit
): {
  readonly ledgers: readonly string[];
  readonly resumes: readonly string[];
  readonly completions: readonly string[];
} {
  const ledgers: string[] = [];
  const resumes: string[] = [];
  const completions: string[] = [];
  const prefixes = new Set([
    ...commit.shards.map((shard) => shard.cache_key.slice(0, 2)),
    ...commit.remaining_keys.map((key) => key.slice(0, 2))
  ]);
  for (const entry of readdirSync(targetRoot, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw unknownControl();
    if (prefixes.has(entry.name) && entry.isDirectory()) continue;
    if (entry.name === WRITE_LOCK && entry.isDirectory()) continue;
    if ([TARGET_MARKER, MATERIALIZATION_COMMIT_NAME, "manifest.json"].includes(entry.name) &&
        entry.isFile()) continue;
    if (LEDGER.test(entry.name) && entry.isFile()) ledgers.push(entry.name);
    else if (RESUME.test(entry.name) && entry.isFile()) resumes.push(entry.name);
    else if (COMPLETION.test(entry.name) && entry.isFile()) completions.push(entry.name);
    else throw unknownControl();
  }
  if (ledgers.length === 0) {
    throw new Error("materialized in-progress successor has no pristine attempt ledger");
  }
  return {
    ledgers: ledgers.sort(), resumes: resumes.sort(), completions: completions.sort()
  };
}

function readPristineLedgers(
  targetRoot: string,
  commit: ExtractionCacheMaterializationCommit,
  names: readonly string[],
  skippedLineage: string | undefined
): ReadonlyMap<string, string> {
  const ledgers = new Map<string, string>();
  for (const name of names) {
    const lineage = LEDGER.exec(name)?.[1];
    if (lineage === skippedLineage) continue;
    const envelope = readAttemptLedgerRecordEnvelope(join(targetRoot, name));
    const record = envelope.record;
    if (lineage === undefined || record.lineage_digest !== lineage ||
        record.cache_identity.model !== commit.initial_target_manifest.extraction_model ||
        record.cache_identity.requestProfile !== commit.initial_target_manifest.request_profile ||
        record.starting_missing !== commit.remaining_key_count ||
        record.maximum_attempts !== computeExtractionFillAttemptCeiling(commit.remaining_key_count) ||
        record.successful_shard_ceiling !== commit.remaining_key_count ||
        record.attempts !== 0 || record.successful_shards.length !== 0 ||
        record.pending_keys.length !== 0 || record.unresolved_attempts.length !== 0 ||
        record.transport_failures.length !== 0 ||
        !isDeepStrictEqual(record.telemetry, emptyAttemptTelemetry())) {
      throw new Error("materialized in-progress successor attempt ledger is not pristine");
    }
    ledgers.set(lineage, envelope.rawSha256);
  }
  return ledgers;
}

function assertResumeRecords(
  targetRoot: string,
  names: readonly string[],
  ledgers: ReadonlyMap<string, string>
): void {
  const resumedLineages = new Set<string>();
  for (const name of names) {
    const receiptDigest = RESUME.exec(name)?.[1];
    const record = readCatalogRefillResumeManifestRecord(join(targetRoot, name));
    if (receiptDigest === undefined || record.receipt_digest !== receiptDigest ||
        ledgers.get(record.lineage_digest) !== record.ledger_raw_sha256 ||
        resumedLineages.has(record.lineage_digest)) {
      throw new Error("materialized in-progress successor resume record is not pristine");
    }
    resumedLineages.add(record.lineage_digest);
  }
}

function assertControlInventory(
  inventory: Pick<ExtractionCacheInventory, "controlArtifactPaths"> & {
    readonly unexpectedPaths?: readonly string[];
  },
  controls: {
    readonly ledgers: readonly string[];
    readonly resumes: readonly string[];
    readonly completions: readonly string[];
  }
): void {
  const expectedControls = [
    TARGET_MARKER, MATERIALIZATION_COMMIT_NAME, ...controls.ledgers, ...controls.completions
  ].sort();
  if (!sameStrings(inventory.controlArtifactPaths, expectedControls) ||
      (inventory.unexpectedPaths !== undefined &&
        !sameStrings(inventory.unexpectedPaths, controls.resumes))) {
    throw unknownControl();
  }
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function unknownControl(): Error {
  return new Error("materialized successor contains unknown or non-pristine control history");
}
