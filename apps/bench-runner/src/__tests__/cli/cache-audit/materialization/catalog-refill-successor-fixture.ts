import { createHash } from "node:crypto";
import {
  mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OFFICIAL_API_SYSTEM_PROMPT } from "@do-soul/alaya-soul";
import { vi } from "vitest";

import type { BenchSignalExtractor } from
  "../../../../longmemeval/compile-seed.js";
import {
  cacheFilePath, computeExtractionTurnCacheKeys
} from "../../../../longmemeval/compile-seed/compile-seed-cache.js";
import { inspectTurnContentKeySpace } from
  "../../../../longmemeval/extraction/turn-contents.js";
import {
  EXTRACTION_CACHE_KEY_ALGO, computeSystemPromptSha256,
  writeExtractionCacheManifest
} from "../../../../longmemeval/extraction/cache/extraction-cache-manifest.js";
import {
  inspectExtractionAuthority, readCurrentExtractionAuthorityRevision
} from "../../../../longmemeval/extraction/authority/inspection.js";
import {
  readExtractionAuthorityReceipt
} from "../../../../longmemeval/extraction/authority/receipt.js";
import { createFreshExtractionTargetSelection } from
  "../../../../longmemeval/extraction/authority/target-selection/receipt.js";
import {
  hashExtractionCacheInventory, inspectExtractionCacheInventory
} from "../../../../longmemeval/extraction/cache-audit/inventory.js";
import { decideExtractionCacheCompatibility } from
  "../../../../longmemeval/extraction/cache-audit/compatibility.js";
import { buildExtractionCacheAuditReceipt } from
  "../../../../longmemeval/extraction/cache-audit/receipt.js";
import { computeExtractionKeySetSha256 } from
  "../../../../longmemeval/extraction/content-closure.js";
import { runExtractionFill } from
  "../../../../longmemeval/extraction/extraction-fill.js";
import type { LongMemEvalQuestion } from
  "../../../../longmemeval/ingestion/dataset.js";
import {
  buildAuthorityQuestion, buildGroundedSignalResponse
} from "../../../longmemeval/extraction-fill/fixture.js";
import { runCli } from "../../../../cli/cli.js";

const variant = "longmemeval_s";
export const model = "gpt-5.4-mini";
export const profile = "provider-default-v1" as const;
export const providerUrl = "https://fixture-provider.invalid/v1";

export interface CatalogRefillSuccessorOptions {
  readonly alternateTransport?: {
    readonly providerUrl?: string;
    readonly model?: string;
  };
  readonly onExtract?: () => void;
  readonly mutateInitialTarget?: (targetRoot: string) => void;
}

export interface CatalogRefillSuccessorFixture {
  readonly root: string;
  readonly sourceRoot: string;
  readonly targetRoot: string;
  readonly auditOutput: string;
  readonly selectionPath: string;
  readonly receiptPath: string;
  readonly authorityReceiptPath: string;
  readonly expectedKeys: readonly string[];
  readonly remainingKeys: readonly string[];
  readonly authorityReceipt: ReturnType<typeof readExtractionAuthorityReceipt>;
  cleanup(): void;
}

export async function createCatalogRefillSuccessorFixture(
  options: CatalogRefillSuccessorOptions = {}
): Promise<CatalogRefillSuccessorFixture> {
  const roots = createRoots();
  setEnvironment(options);
  const questions = buildQuestions();
  const datasetRevision = writeDataset(roots, questions);
  const expectedKeys = extractionKeys(questions);
  const remainingKeys = expectedKeys.slice(-2);
  writeInitialSource(roots.sourceRoot, expectedKeys, remainingKeys, datasetRevision);
  const sourceInspection = await inspect(roots, roots.sourceRoot);
  const emptyInspection = await inspect(roots, roots.emptyRoot);
  const auditReceipt = writeAuditBundle(roots, sourceInspection, emptyInspection, expectedKeys);
  const targetSelection = createFreshExtractionTargetSelection({
    cacheRoot: roots.targetRoot, auditReceipt, observation: emptyInspection.observation,
    now: new Date("2026-08-12T00:00:00.000Z")
  });
  writeFileSync(roots.selectionPath, json(targetSelection), "utf8");
  if (await runCli(commandArgs(roots)) !== 0) throw new Error("initial materialization failed");
  options.mutateInitialTarget?.(roots.targetRoot);
  const authorityReceipt = await fillRemaining(roots, remainingKeys, options);
  return {
    ...roots, expectedKeys, remainingKeys, authorityReceipt,
    cleanup: () => rmSync(roots.root, { recursive: true, force: true })
  };
}

function createRoots() {
  const root = mkdtempSync(join(tmpdir(), "alaya-real-refill-successor-"));
  const roots = {
    root, sourceRoot: join(root, "source"), targetRoot: join(root, "target"),
    emptyRoot: join(root, "empty"), dataDir: join(root, "data"),
    pinnedMetaRoot: join(root, "pinned"), auditOutput: join(root, "audit"),
    selectionPath: join(root, "target-selection.json"),
    receiptPath: join(root, "materialization-receipt.json"),
    authorityReceiptPath: join(root, "catalog-refill-authority.json")
  };
  for (const path of [roots.sourceRoot, roots.emptyRoot, roots.dataDir,
    roots.pinnedMetaRoot, roots.auditOutput]) mkdirSync(path);
  return roots;
}

function setEnvironment(options: CatalogRefillSuccessorOptions): void {
  vi.stubEnv("OFFICIAL_API_GARDEN_MODEL", model);
  vi.stubEnv("ALAYA_BENCH_EXTRACTION_REQUEST_PROFILE", profile);
  vi.stubEnv("OFFICIAL_API_GARDEN_PROVIDER_URL", providerUrl);
  vi.stubEnv("ALAYA_OFFICIAL_GARDEN_SECRET_REF", "env:E0_TEST_GARDEN_KEY");
  vi.stubEnv("E0_TEST_GARDEN_KEY", "test-key");
  if (options.alternateTransport !== undefined) {
    if (options.alternateTransport.providerUrl !== undefined) {
      vi.stubEnv(
        "ALAYA_BENCH_EXTRACTION_TRANSPORT_PROVIDER_URL",
        options.alternateTransport.providerUrl
      );
    }
    if (options.alternateTransport.model !== undefined) {
      vi.stubEnv("ALAYA_BENCH_EXTRACTION_TRANSPORT_MODEL", options.alternateTransport.model);
    }
  }
}

function buildQuestions(): readonly LongMemEvalQuestion[] {
  return Array.from({ length: 100 }, (_, index) => {
    const id = `q${String(index + 1).padStart(3, "0")}`;
    return buildAuthorityQuestion(id, `fact ${id}`, `decoy ${id}`);
  });
}

function writeDataset(roots: ReturnType<typeof createRoots>, questions: readonly LongMemEvalQuestion[]) {
  const raw = JSON.stringify(questions);
  const sha256 = digest(raw);
  writeFileSync(join(roots.dataDir, `${variant}.json`), raw, "utf8");
  writeFileSync(join(roots.pinnedMetaRoot, `${variant}.meta.json`), JSON.stringify({
    name: variant, sha256, size_bytes: Buffer.byteLength(raw), question_count: questions.length
  }), "utf8");
  return sha256;
}

function extractionKeys(questions: readonly LongMemEvalQuestion[]): readonly string[] {
  const turns = inspectTurnContentKeySpace(questions).distinctExtractionTurns;
  return turns.flatMap((turn) => computeExtractionTurnCacheKeys(
    model, profile, OFFICIAL_API_SYSTEM_PROMPT, turn
  )).sort();
}

function writeInitialSource(
  sourceRoot: string,
  expectedKeys: readonly string[],
  remainingKeys: readonly string[],
  datasetRevision: string
): void {
  for (const key of expectedKeys.filter((candidate) => !remainingKeys.includes(candidate))) {
    const path = cacheFilePath(sourceRoot, key);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, json({
      model, request_profile: profile, cache_key: key,
      raw_json: "{\"signals\":[]}", extracted_at: "2026-08-12T00:00:00.000Z"
    }), "utf8");
  }
  writeExtractionCacheManifest(sourceRoot, initialManifest(
    expectedKeys, remainingKeys, datasetRevision
  ));
}

function initialManifest(
  expectedKeys: readonly string[],
  remainingKeys: readonly string[],
  datasetRevision: string
) {
  const cached = expectedKeys.length - remainingKeys.length;
  return {
    schema_version: 3 as const, extraction_model: model, model_family: model,
    request_profile: profile, provider_url: providerUrl,
    system_prompt_sha256: computeSystemPromptSha256(OFFICIAL_API_SYSTEM_PROMPT),
    cache_key_algo: EXTRACTION_CACHE_KEY_ALGO, dataset: "longmemeval-s",
    dataset_revision: datasetRevision, requested_turns: expectedKeys.length,
    cached_turns: cached, coverage: cached / expectedKeys.length,
    fill_status: "in_progress" as const, window_offset: 0, window_limit: 100,
    expected_turns: expectedKeys.length,
    expected_key_set_sha256: computeExtractionKeySetSha256(expectedKeys),
    storage: "git-tracked" as const, built_at: "2026-08-12T00:00:00.000Z",
    builder: "test-fixture"
  };
}

async function inspect(roots: ReturnType<typeof createRoots>, cacheRoot: string) {
  return await inspectExtractionAuthority({
    variant, cacheRoot, dataDir: roots.dataDir,
    pinnedMetaRoot: roots.pinnedMetaRoot,
    revision: readCurrentExtractionAuthorityRevision(), action: "fill"
  });
}

function writeAuditBundle(
  roots: ReturnType<typeof createRoots>,
  sourceInspection: Awaited<ReturnType<typeof inspectExtractionAuthority>>,
  emptyInspection: Awaited<ReturnType<typeof inspectExtractionAuthority>>,
  expectedKeys: readonly string[]
) {
  const inventory = inspectExtractionCacheInventory({
    cacheRoot: roots.sourceRoot, cacheKeys: expectedKeys, model, requestProfile: profile
  });
  const sourceManifestRaw = readFileSync(join(roots.sourceRoot, "manifest.json"), "utf8");
  const raw = rawIdentity(sourceInspection.observation);
  const projection = projectionIdentity(emptyInspection.observation.extraction.modelFamily);
  const decision = decideExtractionCacheCompatibility({
    sourceRoot: roots.sourceRoot, source: { raw, projection }, final: { raw, projection },
    replay: replayClosure(), rawInventoryClosed: false
  });
  const receipt = buildExtractionCacheAuditReceipt({
    createdAt: "2026-08-12T00:00:00.000Z", sourceRoot: roots.sourceRoot,
    sourceManifestSha256: digest(sourceManifestRaw),
    rawInventorySha256: hashExtractionCacheInventory(inventory),
    occurrenceIndexSha256: "f".repeat(64), decision
  });
  writeFileSync(join(roots.auditOutput, "audit-receipt.json"), json(receipt), "utf8");
  writeFileSync(join(roots.auditOutput, "raw-inventory.json"), json({
    sha256: receipt.raw_inventory_sha256, inventory
  }), "utf8");
  writeFileSync(join(roots.auditOutput, "source-manifest.json"), sourceManifestRaw, "utf8");
  return receipt;
}

function rawIdentity(observation: Awaited<ReturnType<typeof inspectExtractionAuthority>>["observation"]) {
  return {
    datasetRevision: observation.dataset.revisionSha256, model: observation.extraction.model,
    requestProfile: observation.extraction.requestProfile,
    providerUrl: observation.extraction.providerUrl,
    systemPromptSha256: observation.extraction.systemPromptSha256,
    cacheKeyAlgorithm: observation.extraction.cacheKeyAlgorithm,
    rawClosureSha256: observation.extraction.rawContentClosureSha256 ?? "0".repeat(64)
  };
}

function projectionIdentity(modelFamily: string) {
  return {
    modelFamily, parserSemanticsSha256: "1".repeat(64),
    formationSemanticsSha256: "2".repeat(64), temporalSchemaRevision: "relation-assertion-v1"
  };
}

function replayClosure() {
  return {
    occurrenceCount: 0, accountedOccurrences: 0, elementCount: 0,
    accountedElements: 0, admitted: 0, deferred: 0, rejected: 0, invalid: 0,
    ledgerSha256: "3".repeat(64)
  };
}

async function fillRemaining(
  roots: ReturnType<typeof createRoots>,
  remainingKeys: readonly string[],
  options: CatalogRefillSuccessorOptions
) {
  const targetSelection = await issueMaterializedSuccessorSelection(roots);
  const allowlistPath = join(roots.root, "catalog-refill-allowlist.json");
  const inspection = await inspect(roots, roots.targetRoot);
  writeFileSync(allowlistPath, json({
    kind: "test-catalog-refill",
    expected_turns: inspection.observation.inventory.expectedTurns,
    cached_turns: inspection.observation.inventory.validTurns,
    missing_turns: inspection.observation.inventory.missingTurns,
    expected_key_set_sha256: inspection.observation.dataset.expectedKeySetSha256,
    cache_keys: remainingKeys
  }), "utf8");
  const authorizationCode = await runCli([
    "authorize-extraction", "--variant", "s", "--offset", "0", "--limit", "100",
    "--data-dir", roots.dataDir, "--pinned-meta-root", roots.pinnedMetaRoot,
    "--extraction-cache-root", roots.targetRoot,
    "--catalog-refill-allowlist", allowlistPath,
    "--extraction-target-selection", roots.selectionPath,
    "--extraction-action", "fill",
    "--extraction-receipt-out", roots.authorityReceiptPath,
    "--extraction-output-token-cap", "512", "--extraction-output-token-field", "max_tokens",
    "--extraction-input-price-usd-per-million", "1",
    "--extraction-output-price-usd-per-million", "2",
    "--extraction-max-input-tokens", "300", "--extraction-disk-floor-bytes", "0"
  ]);
  if (authorizationCode !== 0) throw new Error("catalog refill authorization failed");
  const receipt = readExtractionAuthorityReceipt(roots.authorityReceiptPath);
  if (receipt.target_selection_digest !== targetSelection.receipt_digest) {
    throw new Error("catalog refill authority did not bind the adopted target selection");
  }
  const extract = async (input: Parameters<BenchSignalExtractor["extract"]>[0]) => {
    options.onExtract?.();
    await input.onTransportAttempt?.();
    return { rawJson: buildGroundedSignalResponse(input.userPrompt) };
  };
  await runExtractionFill({
    variant, cacheRoot: roots.targetRoot, dataDir: roots.dataDir,
    pinnedMetaRoot: roots.pinnedMetaRoot, authorityReceiptPath: roots.authorityReceiptPath,
    targetSelectionReceiptPath: roots.selectionPath,
    extractorFactory: () => ({ extract }), log: () => undefined
  });
  return receipt;
}

async function issueMaterializedSuccessorSelection(roots: ReturnType<typeof createRoots>) {
  const code = await runCli([
    "select-extraction-target", "--variant", "s", "--offset", "0", "--limit", "100",
    "--extraction-cache-root", roots.targetRoot,
    "--materialization-receipt", roots.receiptPath,
    "--target-selection-out", join(roots.root, "successor-target-selection.json"),
    "--data-dir", roots.dataDir, "--pinned-meta-root", roots.pinnedMetaRoot
  ]);
  if (code !== 0) {
    throw new Error(
      "materialized successor transport or supplemental verification failed before refill"
    );
  }
  roots.selectionPath = join(roots.root, "successor-target-selection.json");
  return JSON.parse(readFileSync(roots.selectionPath, "utf8")) as {
    readonly receipt_digest: string;
  };
}

export function commandArgs(fixture: Pick<CatalogRefillSuccessorFixture,
  "auditOutput" | "targetRoot" | "selectionPath" | "receiptPath">): string[] {
  return [
    "materialize-audited-extraction-target", "--cache-audit-output", fixture.auditOutput,
    "--extraction-cache-root", fixture.targetRoot,
    "--extraction-target-selection", fixture.selectionPath,
    "--materialization-receipt-out", fixture.receiptPath
  ];
}

function digest(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
