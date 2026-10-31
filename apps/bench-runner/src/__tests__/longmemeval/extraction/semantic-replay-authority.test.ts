import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../support/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
afterAll(() => { isolation.restore(); expect(isolation.violations).toEqual([]); });
import * as receiptApi from
  "../../../runs/extraction/fill/semantic-fill-receipt.js";
import {
  computeLazySemanticRunIdentity,
  LazySemanticRunReceiptSchema,
  unwrapVerifiedLazySemanticRunReceipt,
  type LazySemanticRunReceipt
} from "../../../runs/extraction/fill/semantic-fill-receipt.js";
import { semanticTask } from "./semantic-artifact-fixture.js";
import { writeAuthoredFailedLazyReceipt } from "./authored-lazy-receipt-test-support.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) =>
  rm(root, { recursive: true, force: true }))));

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function resign(
  receipt: LazySemanticRunReceipt,
  change: (unsigned: Record<string, unknown>) => Record<string, unknown>
): LazySemanticRunReceipt {
  const { runIdentity: _run, receiptDigest: _receipt, ...base } = receipt;
  const unsigned = change(base);
  const runIdentity = computeLazySemanticRunIdentity(unsigned as never);
  return {
    ...unsigned,
    runIdentity,
    receiptDigest: digest(JSON.stringify({ ...unsigned, runIdentity }))
  } as LazySemanticRunReceipt;
}

function failedReceipt() {
  const root = roots[roots.length - 1] ?? (() => {
    throw new Error("failed receipt requires an owned root");
  })();
  return { root, receipt: writeAuthoredFailedLazyReceipt(root, semanticTask()) };
}

describe("lazy semantic receipt authority", () => {
  it("does not trust a caller-written self-digested receipt or expose it to provenance", async () => {
    const root = await mkdtemp(join(tmpdir(), "semantic-receipt-authority-"));
    roots.push(root);
    const { receipt } = failedReceipt();
    const forged = resign(receipt, (unsigned) => ({
      ...unsigned,
      budget: { ...receipt.budget, maxCalls: receipt.budget.maxCalls + 1 }
    }));
    await mkdir(join(root, "receipts"), { recursive: true });
    await writeFile(
      join(root, "receipts", `${forged.runIdentity}.json`),
      `${JSON.stringify(forged)}\n`,
      "utf8"
    );

    expect(receiptApi).not.toHaveProperty("readVerifiedLazySemanticRunReceipt");
    expect(() => receiptApi.loadVerifiedLazySemanticRunReceipt({
      semanticRoot: root,
      extractionCacheRoot: join(root, "caller-claimed-extraction"),
      runIdentity: forged.runIdentity
    })).toThrow(/physical extraction authority/iu);
    expect(() => unwrapVerifiedLazySemanticRunReceipt({ receipt: forged } as never))
      .toThrow(/verified persisted receipt handle|receipt.*authority/iu);
  });

  it("rejects replayable receipts with empty demand or calls beyond budget", async () => {
    const root = await mkdtemp(join(tmpdir(), "semantic-receipt-schema-"));
    roots.push(root);
    const { receipt } = failedReceipt();
    const emptyDemand = resign(receipt, (unsigned) => ({
      ...unsigned,
      demandTraceIdentity: digest(""),
      demandUnits: [],
      attempts: [],
      uniqueUnits: 0,
      occurrenceCount: 0,
      bindingCount: 0,
      cold: 0,
      warm: 0,
      calls: 0,
      failures: 0,
      failedUnits: 0,
      unavailable: 0,
      attemptCount: 0
    }));
    const overBudget = resign(receipt, (unsigned) => ({
      ...unsigned,
      budget: { ...receipt.budget, maxCalls: 0 }
    }));

    expect(LazySemanticRunReceiptSchema.safeParse(emptyDemand).success).toBe(false);
    expect(LazySemanticRunReceiptSchema.safeParse(overBudget).success).toBe(false);
  });
});
