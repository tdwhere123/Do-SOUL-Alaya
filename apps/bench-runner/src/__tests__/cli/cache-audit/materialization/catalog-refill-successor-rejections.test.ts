import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { cacheFilePath } from
  "../../../../longmemeval/compile-seed/compile-seed-cache.js";
import { verifyCommittedAuditedExtractionCacheSuccessor } from
  "../../../../longmemeval/extraction/cache-audit/target-materializer.js";
import { catalogRefillCompletionPath } from
  "../../../../longmemeval/extraction/authority/catalog-refill/completion-witness.js";
import { MATERIALIZATION_COMMIT_NAME } from
  "../../../../longmemeval/extraction/cache-audit/materialization/contract.js";
import {
  createCatalogRefillSuccessorFixture,
  type CatalogRefillSuccessorFixture
} from "./catalog-refill-successor-fixture.js";

let fixture: CatalogRefillSuccessorFixture | undefined;

beforeEach(() => {
  vi.spyOn(process.stdout, "write").mockReturnValue(true);
  vi.spyOn(process.stderr, "write").mockReturnValue(true);
});

afterEach(() => {
  fixture?.cleanup();
  fixture = undefined;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("catalog-refill successor target-only rejection", () => {
  it("accepts preserved pristine ledger and resume history", async () => {
    fixture = await createCatalogRefillSuccessorFixture();
    addPristineHistory(fixture);

    expect(() => verify(fixture!)).not.toThrow();
  }, 15_000);

  it("rejects preserved non-pristine ledger history", async () => {
    fixture = await createCatalogRefillSuccessorFixture();
    const path = addPristineHistory(fixture);
    mutateJson(path, (record) => { record.attempts = 1; });

    expect(() => verify(fixture!)).toThrow(/non-pristine control history|not pristine/iu);
  }, 15_000);

  it.each([
    ["partial successor", removeRemainingShard, /ENOENT|no such file/iu],
    ["pending ledger", addPendingLedgerKey, /not durably settled/iu],
    ["unresolved ledger", addUnresolvedLedgerAttempt, /not durably settled/iu],
    ["wrong remaining set", changeWitnessRemainingSet,
      /completion witness (?:is invalid|is missing)|not exactly complete/iu],
    ["wrong initial manifest", changeWitnessInitialManifest,
      /completion witness (?:is invalid|is missing)|not exactly complete/iu]
  ] as const)("rejects a %s", async (_label, mutate, expected) => {
    fixture = await createCatalogRefillSuccessorFixture();
    mutate(fixture);

    expect(() => verify(fixture!)).toThrow(expected);
  }, 15_000);

  it.each([
    ["extra cache key", addExtraShard, /not exactly complete/iu],
    ["unknown control", addUnknownControl, /not exactly complete|unknown.*control/iu],
    ["changed origin and refill shards", changeOriginAndRemainingShards,
      /shard|descriptor|content|JSON/iu],
    ["non-canonical UTF-8 refill shard", makeRemainingShardNonCanonicalUtf8,
      /UTF-8|not exactly complete|invalid/iu]
  ] as const)("rejects %s", async (_label, mutate, expected) => {
    fixture = await createCatalogRefillSuccessorFixture();
    mutate(fixture);

    expect(() => verify(fixture!)).toThrow(expected);
  }, 15_000);
});

function verify(value: CatalogRefillSuccessorFixture) {
  return verifyCommittedAuditedExtractionCacheSuccessor({ targetRoot: value.targetRoot });
}

function removeRemainingShard(value: CatalogRefillSuccessorFixture): void {
  rmSync(cacheFilePath(value.targetRoot, value.remainingKeys[0]!));
}

function addPendingLedgerKey(value: CatalogRefillSuccessorFixture): void {
  mutateLedger(value, (record) => {
    const successful = record.successful_shards as Array<{ cacheKey: string }>;
    const key = value.remainingKeys[0]!;
    record.successful_shards = successful.filter((row) => row.cacheKey !== key);
    record.pending_keys = [key];
  });
}

function addUnresolvedLedgerAttempt(value: CatalogRefillSuccessorFixture): void {
  mutateLedger(value, (record) => {
    record.unresolved_attempts = [{ attempt_ordinal: 1, cache_key: value.remainingKeys[0]! }];
  });
}

function changeWitnessRemainingSet(value: CatalogRefillSuccessorFixture): void {
  mutateWitness(value, (record) => {
    const receipt = record.authority_receipt as Record<string, unknown>;
    const scope = receipt.catalog_refill as Record<string, unknown>;
    scope.keys = [value.expectedKeys[0], value.remainingKeys[1]];
  });
}

function changeWitnessInitialManifest(value: CatalogRefillSuccessorFixture): void {
  mutateWitness(value, (record) => {
    const receipt = record.authority_receipt as Record<string, unknown>;
    const scope = receipt.catalog_refill as Record<string, unknown>;
    scope.initial_manifest_sha256 = "0".repeat(64);
  });
}

function addExtraShard(value: CatalogRefillSuccessorFixture): void {
  const key = "f".repeat(64);
  const path = cacheFilePath(value.targetRoot, key);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify({
    model: "gpt-5.4-mini", request_profile: "provider-default-v1", cache_key: key,
    raw_json: "{\"signals\":[]}", extracted_at: "2026-08-12T00:00:00.000Z"
  }), "utf8");
}

function addUnknownControl(value: CatalogRefillSuccessorFixture): void {
  writeFileSync(join(value.targetRoot, ".unknown-control.json"), "{}\n", "utf8");
}

function addPristineHistory(value: CatalogRefillSuccessorFixture): string {
  const activePath = join(value.targetRoot,
    `extraction-attempt-ledger.${value.authorityReceipt.lineage_digest}.json`);
  const record = JSON.parse(readFileSync(activePath, "utf8")) as Record<string, unknown>;
  const lineage = "d".repeat(64);
  const pristine = {
    ...record, lineage_digest: lineage, attempts: 0, successful_shards: [], pending_keys: [],
    unresolved_attempts: [], transport_failures: [], telemetry: {
      retry_successes: 0, rate_limit_retries: 0,
      terminal: {
        failure_max_retries: 0, failure_non_retryable_4xx: 0,
        failure_timeout: 0, failure_aborted: 0
      },
      input_tokens: 0, output_tokens: 0, total_tokens: 0, usage_unavailable_requests: 0
    }
  };
  const ledgerPath = join(value.targetRoot, `extraction-attempt-ledger.${lineage}.json`);
  const bytes = `${JSON.stringify(pristine)}\n`;
  writeFileSync(ledgerPath, bytes, "utf8");
  const receipt = "e".repeat(64);
  writeFileSync(join(value.targetRoot, `.catalog-refill-resume.${receipt}.json`),
    `${JSON.stringify({
      schema_version: 1, receipt_digest: receipt, lineage_digest: lineage,
      ledger_raw_sha256: createHash("sha256").update(bytes).digest("hex"),
      manifest_sha256: "f".repeat(64)
    })}\n`, "utf8");
  return ledgerPath;
}

function changeOriginAndRemainingShards(value: CatalogRefillSuccessorFixture): void {
  const commit = JSON.parse(readFileSync(
    join(value.targetRoot, MATERIALIZATION_COMMIT_NAME), "utf8"
  )) as { shards: Array<{ cache_key: string }> };
  writeFileSync(cacheFilePath(value.targetRoot, commit.shards[0]!.cache_key), "changed\n", "utf8");
  writeFileSync(cacheFilePath(value.targetRoot, value.remainingKeys[0]!), "changed\n", "utf8");
}

function makeRemainingShardNonCanonicalUtf8(value: CatalogRefillSuccessorFixture): void {
  const path = cacheFilePath(value.targetRoot, value.remainingKeys[0]!);
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  const bytes = Buffer.from(JSON.stringify({ ...parsed, ignored: "XX" }), "utf8");
  const offset = bytes.indexOf("XX");
  bytes[offset] = 0xc3;
  bytes[offset + 1] = 0x28;
  writeFileSync(path, bytes);
}

function mutateLedger(
  value: CatalogRefillSuccessorFixture,
  mutate: (record: Record<string, unknown>) => void
): void {
  const path = join(value.targetRoot,
    `extraction-attempt-ledger.${value.authorityReceipt.lineage_digest}.json`);
  mutateJson(path, mutate);
}

function mutateWitness(
  value: CatalogRefillSuccessorFixture,
  mutate: (record: Record<string, unknown>) => void
): void {
  mutateJson(catalogRefillCompletionPath(
    value.targetRoot, value.authorityReceipt.receipt_digest
  ), mutate);
}

function mutateJson(path: string, mutate: (record: Record<string, unknown>) => void): void {
  const record = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  mutate(record);
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, "utf8");
}
