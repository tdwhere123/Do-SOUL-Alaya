import { createHash } from "node:crypto";
import {
  existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync,
  symlinkSync, truncateSync, writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../../../cli/cli.js";
import { cacheFilePath } from
  "../../../longmemeval/compile-seed/compile-seed-cache.js";
import { computeExtractionKeySetSha256 } from
  "../../../longmemeval/extraction/content-closure.js";
import {
  hashExtractionCacheInventory,
  inspectExtractionCacheInventory
} from "../../../longmemeval/extraction/cache-audit/inventory.js";
import { buildExtractionCacheAuditReceipt } from
  "../../../longmemeval/extraction/cache-audit/receipt.js";
import { createFreshExtractionTargetSelectionRoot } from
  "../../../longmemeval/extraction/authority/target-selection/receipt.js";
import { digestExtractionTargetSelectionReceipt } from
  "../../../longmemeval/extraction/authority/target-selection/receipt-shape.js";
import { acquireExtractionCacheWriteLease } from
  "../../../longmemeval/extraction/fill/manifest/fill-root-guard.js";

const roots: string[] = [];
const cacheKey = "a".repeat(64);
const orphanKey = "b".repeat(64);
const model = "gpt-5.4-mini";
const requestProfile = "provider-default-v1" as const;

afterEach(() => {
  vi.restoreAllMocks();
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("materialize-audited-extraction-target command dispatch", () => {
  it("dispatches audited materialization without provider access and writes a bounded receipt summary", async () => {
    const fixture = createFixture();
    const stdout: string[] = [];
    const stderr: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((text) => {
      stdout.push(String(text));
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation((text) => {
      stderr.push(String(text));
      return true;
    });
    const fetch = vi.spyOn(globalThis, "fetch");

    const code = await runCli(commandArgs(fixture));

    expect(code).toBe(0);
    expect(stderr).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
    expect(readFileSync(cacheFilePath(fixture.targetRoot, cacheKey)))
      .toEqual(readFileSync(cacheFilePath(fixture.sourceRoot, cacheKey)));
    const receipt = JSON.parse(readFileSync(fixture.receiptPath, "utf8")) as {
      readonly kind: string;
      readonly audit_decision_digest: string;
      readonly raw_inventory_sha256: string;
      readonly target_selection_receipt_digest: string;
      readonly materialized_key_count: number;
    };
    expect(receipt).toMatchObject({
      kind: "longmemeval-extraction-cache-materialization",
      audit_decision_digest: fixture.auditReceipt.decision_digest,
      raw_inventory_sha256: fixture.auditReceipt.raw_inventory_sha256,
      target_selection_receipt_digest: fixture.targetSelection.receipt_digest,
      materialized_key_count: 1
    });
    expect(stdout.join("")).toMatch(/materializ(?:ed|ation).*1|1.*materializ/iu);
    expect(stdout.join("").length).toBeLessThanOrEqual(512);
  });

  it("rejects a non-strict raw-inventory wrapper before materialization", async () => {
    const fixture = createFixture({ inventoryExtension: { unbound: true } });

    const result = await runFailing(fixture);

    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/invalid.*raw.inventory|raw.inventory.*invalid/iu);
    expectTargetUntouched(fixture);
  });

  it("rejects an inventory whose digest differs from the audit receipt", async () => {
    const fixture = createFixture({ wrapperSha256: "9".repeat(64) });

    const result = await runFailing(fixture);

    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/inventory.*(?:sha|digest|audit)|(?:sha|digest).*inventory/iu);
    expectTargetUntouched(fixture);
  });
});

describe("materialize-audited-extraction-target command bounded inputs", () => {
  it("rejects an oversized raw-inventory artifact before materialization", async () => {
    const fixture = createFixture();
    truncateSync(join(fixture.auditOutput, "raw-inventory.json"), 64 * 1024 * 1024 + 1);

    const result = await runFailing(fixture);

    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/raw.inventory.*(?:size|limit|exceed)|(?:size|limit|exceed).*raw.inventory/iu);
    expectTargetUntouched(fixture);
  });

  it("rejects a symlinked raw-inventory artifact before materialization", async () => {
    const fixture = createFixture();
    const inventoryPath = join(fixture.auditOutput, "raw-inventory.json");
    rmSync(inventoryPath);
    symlinkSync(join(fixture.auditOutput, "audit-receipt.json"), inventoryPath);

    const result = await runFailing(fixture);

    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/raw.inventory.*(?:symlink|regular)|(?:symlink|regular).*raw.inventory/iu);
    expectTargetUntouched(fixture);
  });

  it("rejects an oversized audit receipt before materialization", async () => {
    const fixture = createFixture();
    truncateSync(join(fixture.auditOutput, "audit-receipt.json"), 64 * 1024 + 1);

    const result = await runFailing(fixture);

    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/audit.receipt.*(?:size|limit|exceed)|(?:size|limit|exceed).*audit.receipt/iu);
    expectTargetUntouched(fixture);
  });

  it("rejects a symlinked audit receipt before materialization", async () => {
    const fixture = createFixture();
    const receiptPath = join(fixture.auditOutput, "audit-receipt.json");
    rmSync(receiptPath);
    symlinkSync(join(fixture.auditOutput, "raw-inventory.json"), receiptPath);

    const result = await runFailing(fixture);

    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/audit.receipt.*(?:symlink|regular)|(?:symlink|regular).*audit.receipt/iu);
    expectTargetUntouched(fixture);
  });

  it("rejects an oversized target-selection receipt before materialization", async () => {
    const fixture = createFixture();
    truncateSync(fixture.selectionPath, 64 * 1024 + 1);

    const result = await runFailing(fixture);

    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/target.selection.*(?:size|limit|exceed)|(?:size|limit|exceed).*target.selection/iu);
    expectTargetUntouched(fixture);
  });

  it("rejects a symlinked target-selection receipt before materialization", async () => {
    const fixture = createFixture();
    rmSync(fixture.selectionPath);
    symlinkSync(join(fixture.auditOutput, "audit-receipt.json"), fixture.selectionPath);

    const result = await runFailing(fixture);

    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/target.selection.*(?:symlink|regular)|(?:symlink|regular).*target.selection/iu);
    expectTargetUntouched(fixture);
  });
});

describe("materialize-audited-extraction-target command receipt publication", () => {
  it.each(["source", "target", "audit"] as const)(
    "rejects a materialization receipt inside the %s artifact root",
    async (rootKind) => {
      const fixture = createFixture();
      const artifactRoot = rootKind === "source"
        ? fixture.sourceRoot
        : rootKind === "target" ? fixture.targetRoot : fixture.auditOutput;
      fixture.receiptPath = join(artifactRoot, "materialization-receipt.json");

      const result = await runFailing(fixture);

      expect(result.code).toBe(2);
      expect(result.stderr).toMatch(/receipt.*(?:outside|overlap)|(?:outside|overlap).*receipt/iu);
      expectTargetUntouched(fixture);
    }
  );

  it("refuses an existing receipt before materialization and preserves its bytes", async () => {
    const fixture = createFixture();
    writeFileSync(fixture.receiptPath, "operator-owned\n", "utf8");

    const result = await runFailing(fixture);

    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/materialization receipt already exists/iu);
    expect(readFileSync(fixture.receiptPath, "utf8")).toBe("operator-owned\n");
    expectTargetUntouched(fixture, true);
  });

  it("verifies an identical receipt export on committed retry", async () => {
    const fixture = createFixture();
    vi.spyOn(process.stdout, "write").mockReturnValue(true);
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    expect(await runCli(commandArgs(fixture))).toBe(0);
    const receipt = readFileSync(fixture.receiptPath);

    expect(await runCli(commandArgs(fixture))).toBe(0);
    expect(readFileSync(fixture.receiptPath)).toEqual(receipt);
  });

  it.each(["initial", "successor"] as const)(
    "holds the target writer lease through %s receipt export and success output",
    async (phase) => {
      const fixture = createFixture();
      vi.spyOn(process.stderr, "write").mockReturnValue(true);
      if (phase === "successor") {
        vi.spyOn(process.stdout, "write").mockReturnValue(true);
        expect(await runCli(commandArgs(fixture))).toBe(0);
        rmSync(fixture.receiptPath);
        vi.restoreAllMocks();
        vi.spyOn(process.stderr, "write").mockReturnValue(true);
      }
      let observed = false;
      vi.spyOn(process.stdout, "write").mockImplementation(() => {
        expect(readFileSync(fixture.receiptPath, "utf8")).toContain(
          "longmemeval-extraction-cache-materialization"
        );
        expect(() => acquireExtractionCacheWriteLease(fixture.targetRoot))
          .toThrow(/writer lock/iu);
        observed = true;
        return true;
      });

      expect(await runCli(commandArgs(fixture))).toBe(0);
      expect(observed).toBe(true);
      const lease = acquireExtractionCacheWriteLease(fixture.targetRoot);
      lease.release();
    }
  );
});

describe("materialize-audited-extraction-target command committed recovery", () => {
  it("rejects a different receipt export without changing the committed target", async () => {
    const fixture = createFixture();
    vi.spyOn(process.stdout, "write").mockReturnValue(true);
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    expect(await runCli(commandArgs(fixture))).toBe(0);
    const targetBytes = readFileSync(cacheFilePath(fixture.targetRoot, cacheKey));
    const different = `${JSON.stringify({ operator_owned: true })}\n`;
    writeFileSync(fixture.receiptPath, different, "utf8");

    const result = await runFailing(fixture);

    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/receipt.*(?:different|authority)/iu);
    expect(readFileSync(fixture.receiptPath, "utf8")).toBe(different);
    expect(readFileSync(cacheFilePath(fixture.targetRoot, cacheKey))).toEqual(targetBytes);
  });

  it.each(["manifest", "shard"] as const)(
    "rejects arbitrary committed target %s tamper before receipt re-export",
    async (kind) => {
      const fixture = createFixture();
      vi.spyOn(process.stdout, "write").mockReturnValue(true);
      vi.spyOn(process.stderr, "write").mockReturnValue(true);
      expect(await runCli(commandArgs(fixture))).toBe(0);
      rmSync(fixture.receiptPath);
      writeFileSync(kind === "manifest" ? join(fixture.targetRoot, "manifest.json") :
        cacheFilePath(fixture.targetRoot, cacheKey), "tampered\n", "utf8");

      expect((await runFailing(fixture)).code).toBe(2);
      expect(existsSync(fixture.receiptPath)).toBe(false);
    }
  );

  it("prints actionable source writer-lease guidance with the exact root", async () => {
    const fixture = createFixture();
    const lease = acquireExtractionCacheWriteLease(fixture.sourceRoot);
    try {
      const result = await runFailing(fixture);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain(fixture.sourceRoot);
      expect(result.stderr).toMatch(/remove.*\.extraction-fill\.lock/iu);
      expect(result.stderr).toMatch(/verifying.*owner process|verify.*owner/iu);
    } finally {
      lease.release();
    }
  });

  it("prints the actionable writer-lease error verbatim", async () => {
    const fixture = createFixture();
    const lockPath = join(fixture.targetRoot, ".extraction-fill.lock");
    mkdirSync(lockPath);
    const actionable = `extraction cache root ${fixture.targetRoot} already has a writer lock; ` +
      `remove ${lockPath} only after verifying its owner process is stopped`;

    const result = await runFailing(fixture);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain(actionable);
    expect(existsSync(cacheFilePath(fixture.targetRoot, cacheKey))).toBe(false);
    expect(existsSync(fixture.receiptPath)).toBe(false);
  });
});

interface FixtureOptions {
  readonly inventoryExtension?: Readonly<Record<string, unknown>>;
  readonly wrapperSha256?: string;
}

function createFixture(options: FixtureOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), "alaya-cache-materialize-command-"));
  roots.push(root);
  const sourceRoot = join(root, "source");
  const targetRoot = join(root, "target");
  const auditOutput = join(root, "audit");
  const selectionPath = join(root, "target-selection.json");
  mkdirSync(sourceRoot);
  mkdirSync(auditOutput);
  writeShard(sourceRoot, cacheKey);
  const sourceManifestRaw = sourceManifest();
  writeFileSync(join(sourceRoot, "manifest.json"), sourceManifestRaw, "utf8");
  const inventory = inspectExtractionCacheInventory({
    cacheRoot: sourceRoot, cacheKeys: [cacheKey, orphanKey], model, requestProfile
  });
  const inventorySha256 = hashExtractionCacheInventory(inventory);
  const auditReceipt = auditReceiptFor(
    sourceRoot, sha256(sourceManifestRaw), inventorySha256
  );
  const targetSelection = targetSelectionFor(targetRoot, auditReceipt);
  writeFileSync(join(auditOutput, "audit-receipt.json"), json(auditReceipt), "utf8");
  writeFileSync(join(auditOutput, "raw-inventory.json"), json({
    sha256: options.wrapperSha256 ?? inventorySha256,
    inventory,
    ...options.inventoryExtension
  }), "utf8");
  writeFileSync(join(auditOutput, "source-manifest.json"), sourceManifestRaw, "utf8");
  writeFileSync(selectionPath, json(targetSelection), "utf8");
  return {
    root, sourceRoot, targetRoot, auditOutput, selectionPath,
    receiptPath: join(root, "materialization-receipt.json"),
    auditReceipt, targetSelection
  };
}

function commandArgs(fixture: ReturnType<typeof createFixture>): string[] {
  return [
    "materialize-audited-extraction-target",
    "--cache-audit-output", fixture.auditOutput,
    "--extraction-cache-root", fixture.targetRoot,
    "--extraction-target-selection", fixture.selectionPath,
    "--materialization-receipt-out", fixture.receiptPath
  ];
}

async function runFailing(fixture: ReturnType<typeof createFixture>) {
  const stderr: string[] = [];
  vi.spyOn(process.stdout, "write").mockReturnValue(true);
  vi.spyOn(process.stderr, "write").mockImplementation((text) => {
    stderr.push(String(text));
    return true;
  });
  return { code: await runCli(commandArgs(fixture)), stderr: stderr.join("") };
}

function expectTargetUntouched(
  fixture: ReturnType<typeof createFixture>,
  receiptAlreadyExists = false
): void {
  expect(readdirSync(fixture.targetRoot)).toEqual([".alaya-extraction-target-root.json"]);
  if (!receiptAlreadyExists) expect(existsSync(fixture.receiptPath)).toBe(false);
}

function targetSelectionFor(
  targetRoot: string,
  auditReceipt: ReturnType<typeof auditReceiptFor>
) {
  const targetBinding = createFreshExtractionTargetSelectionRoot({
    cacheRoot: targetRoot, auditReceipt
  });
  const unsigned = {
    schema_version: 2 as const,
    kind: "longmemeval-extraction-target-selection" as const,
    created_at: "2026-08-12T00:00:00.000Z",
    selection_basis: {
      kind: "cache_audit" as const,
      audit_decision_digest: auditReceipt.decision_digest
    },
    target_root: targetBinding,
    final_identity: {
      revision: "a".repeat(40), dataset_variant: "longmemeval_s",
      dataset_revision_sha256: "2".repeat(64), model, model_family: model,
      request_profile: requestProfile, provider_url: "https://example.test/v1",
      system_prompt_sha256: "3".repeat(64),
      cache_key_algorithm: "sha256(model\\0requestProfile\\0systemPrompt\\0turnContent)"
    },
    initial_selection: {
      selection_digest: "c".repeat(64),
      key_digest: computeExtractionKeySetSha256([cacheKey, orphanKey]),
      offset: 0, limit: 100, expected_turns: 2
    }
  };
  return Object.freeze({
    ...unsigned,
    receipt_digest: digestExtractionTargetSelectionReceipt(unsigned)
  });
}

function auditReceiptFor(
  sourceRoot: string,
  sourceManifestSha256: string,
  inventorySha256: string
) {
  const raw = {
    datasetRevision: "2".repeat(64), model, requestProfile,
    providerUrl: "https://example.test/v1", systemPromptSha256: "3".repeat(64),
    cacheKeyAlgorithm: "sha256(model\\0requestProfile\\0systemPrompt\\0turnContent)",
    rawClosureSha256: "6".repeat(64)
  };
  const projection = {
    modelFamily: model, parserSemanticsSha256: "4".repeat(64),
    formationSemanticsSha256: "5".repeat(64),
    temporalSchemaRevision: "relation-assertion-v1"
  };
  return buildExtractionCacheAuditReceipt({
    createdAt: "2026-08-12T00:00:00.000Z",
    sourceRoot,
    sourceManifestSha256,
    rawInventorySha256: inventorySha256,
    occurrenceIndexSha256: "f".repeat(64),
    decision: {
      sourceRoot,
      raw: { action: "rebuild", reasons: ["raw_inventory_not_closed"], source: raw, final: raw },
      projection: {
        action: "replay", reasons: ["raw_cache_rebuild"],
        source: projection, final: projection,
        replay: {
          occurrenceCount: 1, accountedOccurrences: 1,
          elementCount: 1, accountedElements: 1,
          admitted: 1, deferred: 0, rejected: 0, invalid: 0,
          ledgerSha256: "1".repeat(64)
        }
      }
    }
  });
}

function writeShard(root: string, key: string): void {
  const path = cacheFilePath(root, key);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify({
    cache_key: key, model, request_profile: requestProfile,
    raw_json: JSON.stringify({ signals: [] })
  }), "utf8");
}

function sourceManifest(): string {
  return json({
    schema_version: 3, extraction_model: model, model_family: model,
    request_profile: requestProfile, provider_url: "https://example.test/v1",
    system_prompt_sha256: "3".repeat(64),
    cache_key_algo: "sha256(model\\0requestProfile\\0systemPrompt\\0turnContent)",
    dataset: "longmemeval-s", dataset_revision: "2".repeat(64),
    requested_turns: 2, cached_turns: 1, coverage: 0.5,
    fill_status: "in_progress", window_offset: 0, window_limit: 100,
    expected_turns: 2,
    expected_key_set_sha256: computeExtractionKeySetSha256([cacheKey, orphanKey]),
    storage: "git-tracked", built_at: "2026-08-12T00:00:00.000Z", builder: "test"
  });
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
