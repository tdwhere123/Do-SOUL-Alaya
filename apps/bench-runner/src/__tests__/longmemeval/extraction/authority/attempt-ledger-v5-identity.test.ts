import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { emptyBenchTerminalRetryClassifications } from
  "../../../../runs/compile-seed/compile-seed-types.js";
import {
  ensureForkedExtractionAttemptLedger,
  openExtractionAttemptLedger,
  readSettledExtractionAttemptLedger
} from "../../../../runs/extraction/authority/attempt-ledger.js";
import { createExtractionContinuationChildClaim } from
  "../../../../runs/extraction/authority/continuation/child-claim.js";
import type { ExtractionAuthorityReceipt } from
  "../../../../runs/extraction/authority/receipt.js";

const FOUR_KEY_V5_BYTES = readFileSync(new URL(
  "./fixtures/attempt-ledger-v5-four-terminal.json",
  import.meta.url
));
const LINEAGE = "f1".repeat(32);
const SUCCESSOR_LINEAGE = "a2".repeat(32);
const CACHE_IDENTITY = {
  model: "gpt-5.4-mini",
  requestProfile: "provider-default-v1"
} as const;
const FROZEN_RAW_LEDGER_SHA256 =
  "f02ef7c7aa29824c0a5403e414e8344d0dd79f937425fec1a4641ee4baf77794";
const FROZEN_CANONICAL_LEDGER_SHA256 =
  "0a3ad9d7477f7130a297c3068d16c65b39d1ca88f4881f36bf27ed23447c64dc";
const FIVE_KEY_ZERO_CANONICAL_SHA256 =
  "ae3e8a2c3d9c51eeea345a82c97f931493990b53567da1db869d59fd2bf1157d";
const BASE_TERMINAL_KEYS = [
  "failure_max_retries",
  "failure_non_retryable_4xx",
  "failure_timeout",
  "failure_aborted"
] as const;

let cacheRoot = "";

afterEach(async () => {
  if (cacheRoot !== "") await rm(cacheRoot, { recursive: true, force: true });
});

function ledgerPath(lineage = LINEAGE): string {
  return join(cacheRoot, `extraction-attempt-ledger.${lineage}.json`);
}

async function writeFixture(): Promise<void> {
  cacheRoot = await mkdtemp(join(tmpdir(), "attempt-ledger-v5-identity-"));
  await writeFile(ledgerPath(), FOUR_KEY_V5_BYTES);
}

function readSnapshot() {
  return readSettledExtractionAttemptLedger({
    cacheRoot,
    lineageDigest: LINEAGE,
    cacheIdentity: CACHE_IDENTITY
  });
}

describe("extraction attempt ledger v5 four-key identity", () => {
  it("preserves HEAD raw/canonical witnesses and continuation bindings", async () => {
    await writeFixture();
    const snapshot = readSnapshot();
    expect(snapshot.rawLedgerSha256).toBe(FROZEN_RAW_LEDGER_SHA256);
    expect(snapshot.ledgerSha256).toBe(FROZEN_CANONICAL_LEDGER_SHA256);
    expect(snapshot.ledgerSha256).not.toBe(FIVE_KEY_ZERO_CANONICAL_SHA256);
    expect(snapshot.telemetry.terminalRetryClassifications).toEqual(
      emptyBenchTerminalRetryClassifications()
    );
    expect(Buffer.compare(await readFile(ledgerPath()), FOUR_KEY_V5_BYTES)).toBe(0);

    openExtractionAttemptLedger({
      cacheRoot,
      lineageDigest: LINEAGE,
      cacheIdentity: CACHE_IDENTITY,
      startingMissing: 1
    });
    expect(Buffer.compare(await readFile(ledgerPath()), FOUR_KEY_V5_BYTES)).toBe(0);

    const forked = ensureForkedExtractionAttemptLedger({
      cacheRoot,
      predecessorLineageDigest: LINEAGE,
      predecessorLedgerSha256: FROZEN_CANONICAL_LEDGER_SHA256,
      predecessorRawLedgerSha256: FROZEN_RAW_LEDGER_SHA256,
      successorLineageDigest: SUCCESSOR_LINEAGE,
      cacheIdentity: CACHE_IDENTITY
    });
    expect(forked.lineageDigest).toBe(SUCCESSOR_LINEAGE);
    const successor = JSON.parse(await readFile(ledgerPath(SUCCESSOR_LINEAGE), "utf8")) as {
      telemetry: { terminal: Record<string, number> };
    };
    expect(Object.keys(successor.telemetry.terminal)).toEqual([...BASE_TERMINAL_KEYS]);

    const claim = createExtractionContinuationChildClaim({
      predecessorReceiptDigest: "b3".repeat(32),
      predecessorLedger: snapshot,
      successor: {
        target_selection_digest: "c4".repeat(32),
        lineage_digest: SUCCESSOR_LINEAGE,
        receipt_digest: "d5".repeat(32),
        continuation: { mode: "output_token_cap_renewal" }
      } as ExtractionAuthorityReceipt
    });
    expect(claim.predecessor.ledger_raw_sha256).toBe(FROZEN_RAW_LEDGER_SHA256);
    expect(claim.predecessor.ledger_canonical_sha256).toBe(FROZEN_CANONICAL_LEDGER_SHA256);
  });

  it("writes a new empty v5 ledger with the frozen four-key bytes", async () => {
    cacheRoot = await mkdtemp(join(tmpdir(), "attempt-ledger-v5-empty-"));
    openExtractionAttemptLedger({
      cacheRoot,
      lineageDigest: LINEAGE,
      cacheIdentity: CACHE_IDENTITY,
      startingMissing: 1
    });
    expect(Buffer.compare(await readFile(ledgerPath()), FOUR_KEY_V5_BYTES)).toBe(0);
    const snapshot = readSnapshot();
    expect(snapshot.rawLedgerSha256).toBe(FROZEN_RAW_LEDGER_SHA256);
    expect(snapshot.ledgerSha256).toBe(FROZEN_CANONICAL_LEDGER_SHA256);
  });

  it("rejects missing base keys and unknown terminal keys", async () => {
    await writeFixture();
    const record = JSON.parse(FOUR_KEY_V5_BYTES.toString("utf8")) as {
      telemetry: { terminal: Record<string, number> };
    };

    const missing = structuredClone(record);
    delete missing.telemetry.terminal.failure_timeout;
    await writeFile(ledgerPath(), `${JSON.stringify(missing)}\n`);
    expect(() => readSnapshot()).toThrow(/invalid/u);

    const unknown = structuredClone(record);
    unknown.telemetry.terminal.failure_unknown = 1;
    await writeFile(ledgerPath(), `${JSON.stringify(unknown)}\n`);
    expect(() => readSnapshot()).toThrow(/invalid/u);
  });

  it("keeps additive zero canonical-identical and changes identity when nonzero", async () => {
    await writeFixture();
    const record = JSON.parse(FOUR_KEY_V5_BYTES.toString("utf8")) as {
      telemetry: { terminal: Record<string, number> };
    };
    record.telemetry.terminal.failure_non_retryable_response = 0;
    await writeFile(ledgerPath(), `${JSON.stringify(record)}\n`);
    const zero = readSnapshot();
    expect(zero.ledgerSha256).toBe(FROZEN_CANONICAL_LEDGER_SHA256);
    expect(zero.rawLedgerSha256).not.toBe(FROZEN_RAW_LEDGER_SHA256);

    record.telemetry.terminal.failure_non_retryable_response = 1;
    await writeFile(ledgerPath(), `${JSON.stringify(record)}\n`);
    const nonzero = readSnapshot();
    expect(nonzero.ledgerSha256).not.toBe(FROZEN_CANONICAL_LEDGER_SHA256);
    expect(nonzero.rawLedgerSha256).not.toBe(FROZEN_RAW_LEDGER_SHA256);
    expect(nonzero.telemetry.terminalRetryClassifications).toMatchObject({
      failure_non_retryable_response: 1,
      failure_max_retries: 0
    });
  });
});
