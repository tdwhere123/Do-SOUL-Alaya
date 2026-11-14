import { createHash } from "node:crypto";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../../../../../scripts/test-support/provider-free/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
afterAll(() => { isolation.restore(); expect(isolation.violations).toEqual([]); });
import {
  LazySemanticRunReceiptSchema,
  readPersistedLazySemanticRunReceipt,
  sealLazySemanticRunReceipt,
  type LazySemanticRunReceipt
} from "../../../runs/extraction/fill/semantic-fill-receipt.js";
import { semanticTask, semanticTasks } from "./semantic-artifact-fixture.js";
import {
  writeAuthoredAdmittedLazyReceipt,
  writeAuthoredFailedLazyReceipt,
  writeAuthoredSkippedLazyReceipt,
  writeSealedLazyReceipt
} from "./authored-lazy-receipt-test-support.js";

import { reserveSemanticArtifact, semanticArtifactPath } from
  "../../../runs/extraction/cache/semantic-artifact/store.js";

const FOREIGN_OCCURRENCE = "ab".repeat(32);

describe("lazy semantic receipt ledger rebind", () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "lazy-receipt-bind-")); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it("loads an honest receipt+ledger and rejects rewritten member outcomes with public digests", () => {
    const original = writeAuthoredFailedLazyReceipt(root, semanticTask());
    expect(readPersistedLazySemanticRunReceipt(root, original.runIdentity).runIdentity)
      .toBe(original.runIdentity);
    expect(LazySemanticRunReceiptSchema.parse(original).runIdentity).toBe(original.runIdentity);

    const skipped = rewriteReceiptAttempts(original, (attempt) =>
      attempt.outcome === "failed" || attempt.outcome === "admitted"
        ? { semanticKey: attempt.semanticKey, capability: attempt.capability, outcome: "skipped" }
        : attempt
    , {
      failures: 0,
      unavailable: 0
    });
    expect(LazySemanticRunReceiptSchema.parse(skipped).runIdentity).toBe(skipped.runIdentity);
    writeSealedLazyReceipt(root, skipped);
    expect(() => readPersistedLazySemanticRunReceipt(root, skipped.runIdentity))
      .toThrow(/call totals differ from durable ledger authority|member outcome differs from durable ledger evidence|skipped outcomes are not bound to starting cache evidence/u);
  });

  it.each(["owner", "path"])("rejects corrupt reservation %s without repairing historical files", (corruption) => {
    const task = semanticTask();
    const receipt = writeAuthoredFailedLazyReceipt(root, task);
    expect(readPersistedLazySemanticRunReceipt(root, receipt.runIdentity)).toEqual(receipt);
    reserveSemanticArtifact(root, task.semanticKey, task.capability);
    let path = `${semanticArtifactPath(root, task.semanticKey, task.capability)}.reserve`;
    if (corruption === "owner") writeFileSync(path, "malformed\n");
    else {
      const foreignPath = join(dirname(path), "not-an-artifact.json.reserve");
      renameSync(path, foreignPath);
      path = foreignPath;
    }
    const retained = readFileSync(path);
    expect(() => readPersistedLazySemanticRunReceipt(root, receipt.runIdentity)).toThrow("corrupt reservation");
    expect(readFileSync(path)).toEqual(retained);
  });

  it("rejects admitted-to-skipped forgery after recomputing public digests", () => {
    const original = writeAuthoredAdmittedLazyReceipt(root, [semanticTask()]);
    expect(original.cold).toBeGreaterThan(0);
    const skipped = rewriteReceiptAttempts(original, (attempt) =>
      attempt.outcome === "admitted"
        ? { semanticKey: attempt.semanticKey, capability: attempt.capability, outcome: "skipped" }
        : attempt
    );
    expect(LazySemanticRunReceiptSchema.parse(skipped).warm).toBeGreaterThan(0);
    writeSealedLazyReceipt(root, skipped);
    expect(() => readPersistedLazySemanticRunReceipt(root, skipped.runIdentity))
      .toThrow(/member outcome differs from durable ledger evidence|skipped outcomes are not bound to starting cache evidence/u);
  });

  it("rejects rewriting only some ledger-admitted members to skipped", () => {
    const [first, second] = semanticTasks(["I moved to Berlin.", "I moved to Paris."]);
    const original = writeAuthoredAdmittedLazyReceipt(root, [first!, second!]);
    expect(original.cold).toBeGreaterThan(1);
    let rewritten = 0;
    const mixed = rewriteReceiptAttempts(original, (attempt) => {
      if (attempt.outcome !== "admitted" || rewritten > 0) return attempt;
      rewritten += 1;
      return { semanticKey: attempt.semanticKey, capability: attempt.capability, outcome: "skipped" };
    });
    expect(mixed.cold).toBeGreaterThan(0);
    expect(mixed.warm).toBeGreaterThan(0);
    writeSealedLazyReceipt(root, mixed);
    expect(() => readPersistedLazySemanticRunReceipt(root, mixed.runIdentity))
      .toThrow(/member outcome differs from durable ledger evidence/u);
  });

  it("rejects receipt attempts that disagree with ledger memberOutcomes", () => {
    const original = writeAuthoredFailedLazyReceipt(root, semanticTask());
    const forged = rewriteReceiptAttempts(original, (attempt) =>
      attempt.outcome === "failed" || attempt.outcome === "admitted"
        ? {
            semanticKey: attempt.semanticKey,
            capability: attempt.capability,
            outcome: "failed",
            reason: "forged failure"
          }
        : attempt
    );
    writeSealedLazyReceipt(root, forged);
    expect(() => readPersistedLazySemanticRunReceipt(root, forged.runIdentity))
      .toThrow(/member outcome differs from durable ledger evidence|durable outcome is not in ledger evidence/u);
  });

  it("fail-closes when durable ledger evidence is missing", () => {
    const original = writeAuthoredFailedLazyReceipt(root, semanticTask());
    rmSync(join(root, ".semantic-fill-private"), { recursive: true, force: true });
    expect(() => readPersistedLazySemanticRunReceipt(root, original.runIdentity))
      .toThrow(/lacks durable ledger/u);
  });

  it("rejects a demand unit whose occurrenceIdentity is not in captured execution tasks", () => {
    const original = writeAuthoredSkippedLazyReceipt(root, semanticTask());
    const demandUnits = original.demandUnits.map((unit, index) =>
      index === 0 ? { ...unit, occurrenceIdentity: FOREIGN_OCCURRENCE } : unit
    );
    const { runIdentity: _run, receiptDigest: _digest, ...unsigned } = original;
    const forged = sealLazySemanticRunReceipt({
      ...unsigned,
      demandUnits,
      demandTraceIdentity: createHash("sha256").update(demandUnits.map((unit) =>
        `${unit.semanticKey}\u0000${unit.capability}\u0000${unit.occurrenceIdentity}` +
          `\u0000${unit.sourceCorpusIdentity}`
      ).join("\n"), "utf8").digest("hex")
    });
    writeSealedLazyReceipt(root, forged);
    expect(() => readPersistedLazySemanticRunReceipt(root, forged.runIdentity))
      .toThrow(/lost a demanded source binding|occurrence/u);
  });
});

function rewriteReceiptAttempts(
  receipt: LazySemanticRunReceipt,
  rewrite: (attempt: LazySemanticRunReceipt["attempts"][number]) =>
    LazySemanticRunReceipt["attempts"][number],
  totals: Partial<Pick<LazySemanticRunReceipt, "failures" | "unavailable" | "calls">> = {}
): LazySemanticRunReceipt {
  const attempts = receipt.attempts.map(rewrite);
  const { runIdentity: _run, receiptDigest: _digest, ...unsigned } = receipt;
  return sealLazySemanticRunReceipt({
    ...unsigned,
    attempts,
    cold: attempts.filter((attempt) => attempt.outcome === "admitted").length,
    warm: attempts.filter((attempt) => attempt.outcome === "skipped").length,
    failedUnits: attempts.filter((attempt) => attempt.outcome === "failed").length,
    unavailable: attempts.filter((attempt) =>
      attempt.outcome === "unresolved" || attempt.outcome === "failed").length,
    attemptCount: attempts.length,
    ...totals
  });
}
