import { createHash } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sealSemanticArtifact } from
  "../../../runs/extraction/cache/semantic-artifact/contract.js";
import {
  persistRawArtifact,
  recordSourceBinding,
  semanticArtifactPath
} from "../../../runs/extraction/cache/semantic-artifact/store.js";
import { runSemanticFill } from
  "../../../runs/extraction/fill/semantic-fill-executor.js";
import {
  LazySemanticRunReceiptSchema,
  readPersistedLazySemanticRunReceipt,
  sealLazySemanticRunReceipt,
  serializeLazySemanticRunReceipt,
  type LazySemanticRunReceipt
} from "../../../runs/extraction/fill/semantic-fill-receipt.js";
import {
  createOfflineSemanticEnvelope,
  createOfflineSemanticReplay,
  createOfflineSemanticReplayForTasks
} from "../../../runs/extraction/fill/semantic-fill-envelope.js";
import {
  SEMANTIC_RAW,
  TOKEN_AWARE_POLICY,
  semanticArtifactUnsigned,
  semanticTask,
  semanticTasks
} from "./semantic-artifact-fixture.js";

const FOREIGN_OCCURRENCE = "ab".repeat(32);

describe("lazy semantic receipt ledger rebind", () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "lazy-receipt-bind-")); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it("loads an honest receipt+ledger and rejects rewritten member outcomes with public digests", async () => {
    const original = await persistFailedReceipt(root);
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
    writeSealedReceipt(root, skipped);
    expect(() => readPersistedLazySemanticRunReceipt(root, skipped.runIdentity))
      .toThrow(/call totals differ from durable ledger authority|member outcome differs from durable ledger evidence|skipped outcomes are not bound to starting cache evidence/u);
  });

  it("rejects admitted-to-skipped forgery after recomputing public digests", async () => {
    const original = await persistAdmittedReceipt(root);
    expect(original.cold).toBeGreaterThan(0);
    const skipped = rewriteReceiptAttempts(original, (attempt) =>
      attempt.outcome === "admitted"
        ? { semanticKey: attempt.semanticKey, capability: attempt.capability, outcome: "skipped" }
        : attempt
    );
    expect(LazySemanticRunReceiptSchema.parse(skipped).warm).toBeGreaterThan(0);
    writeSealedReceipt(root, skipped);
    expect(() => readPersistedLazySemanticRunReceipt(root, skipped.runIdentity))
      .toThrow(/member outcome differs from durable ledger evidence|skipped outcomes are not bound to starting cache evidence/u);
  });

  it("rejects rewriting only some ledger-admitted members to skipped", async () => {
    const original = await persistTwoAdmittedReceipt(root);
    expect(original.cold).toBeGreaterThan(1);
    let rewritten = 0;
    const mixed = rewriteReceiptAttempts(original, (attempt) => {
      if (attempt.outcome !== "admitted" || rewritten > 0) return attempt;
      rewritten += 1;
      return { semanticKey: attempt.semanticKey, capability: attempt.capability, outcome: "skipped" };
    });
    expect(mixed.cold).toBeGreaterThan(0);
    expect(mixed.warm).toBeGreaterThan(0);
    writeSealedReceipt(root, mixed);
    expect(() => readPersistedLazySemanticRunReceipt(root, mixed.runIdentity))
      .toThrow(/member outcome differs from durable ledger evidence/u);
  });

  it("rejects receipt attempts that disagree with ledger memberOutcomes", async () => {
    const original = await persistFailedReceipt(root);
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
    writeSealedReceipt(root, forged);
    expect(() => readPersistedLazySemanticRunReceipt(root, forged.runIdentity))
      .toThrow(/member outcome differs from durable ledger evidence|durable outcome is not in ledger evidence/u);
  });

  it("fail-closes when durable ledger evidence is missing", async () => {
    const original = await persistFailedReceipt(root);
    rmSync(join(root, ".semantic-fill-private"), { recursive: true, force: true });
    expect(() => readPersistedLazySemanticRunReceipt(root, original.runIdentity))
      .toThrow(/lacks durable ledger/u);
  });

  it("rejects a demand unit whose occurrenceIdentity is not in captured execution tasks", async () => {
    const original = await persistWarmReceipt(root);
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
    writeSealedReceipt(root, forged);
    expect(() => readPersistedLazySemanticRunReceipt(root, forged.runIdentity))
      .toThrow(/lost a demanded source binding|occurrence/u);
  });
});

async function persistFailedReceipt(root: string): Promise<LazySemanticRunReceipt> {
  const task = semanticTask();
  const report = await runSemanticFill({
    root,
    tasks: [task],
    envelope: createOfflineSemanticEnvelope({
      maxCalls: 1, maxFailures: 1, transportPolicy: TOKEN_AWARE_POLICY
    }),
    transport: createOfflineSemanticReplay({
      defaultResult: { kind: "failure", reason: "sealed offline failure" }
    })
  });
  return report.lazyRunReceipt;
}

function admittedSignal(task: ReturnType<typeof semanticTask>) {
  return {
    object_kind: "fact",
    confidence: 0.9,
    matched_text: task.text.replace(/^(?:User|Assistant): /u, ""),
    source_locator: {
      contract_version: 2,
      kind: "assertion_catalog",
      assertion_id: task.assertionId
    }
  };
}

async function persistAdmittedReceipt(root: string): Promise<LazySemanticRunReceipt> {
  const task = semanticTask();
  const report = await runSemanticFill({
    root,
    tasks: [task],
    envelope: createOfflineSemanticEnvelope({
      maxCalls: 1, maxFailures: 1, transportPolicy: TOKEN_AWARE_POLICY
    }),
    transport: createOfflineSemanticReplayForTasks({
      tasks: [task],
      transportPolicy: TOKEN_AWARE_POLICY,
      result: { kind: "raw", rawJson: JSON.stringify({ signals: [admittedSignal(task)] }) }
    })
  });
  return report.lazyRunReceipt;
}

async function persistTwoAdmittedReceipt(root: string): Promise<LazySemanticRunReceipt> {
  const [first, second] = semanticTasks(["I moved to Berlin.", "I moved to Paris."]);
  if (first === undefined || second === undefined) {
    throw new Error("fixture did not produce two semantic tasks");
  }
  const tasks = [first, second];
  const report = await runSemanticFill({
    root,
    tasks,
    envelope: createOfflineSemanticEnvelope({
      maxCalls: 2, maxFailures: 1, transportPolicy: TOKEN_AWARE_POLICY
    }),
    transport: createOfflineSemanticReplayForTasks({
      tasks,
      transportPolicy: TOKEN_AWARE_POLICY,
      result: {
        kind: "raw",
        rawJson: JSON.stringify({ signals: tasks.map(admittedSignal) })
      }
    })
  });
  return report.lazyRunReceipt;
}

async function persistWarmReceipt(root: string): Promise<LazySemanticRunReceipt> {
  const task = semanticTask();
  persistRawArtifact(root, SEMANTIC_RAW);
  const sealed = sealSemanticArtifact(semanticArtifactUnsigned(task));
  const path = semanticArtifactPath(root, task.semanticKey, task.capability);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(sealed, null, 2)}\n`);
  recordSourceBinding(root, task.semanticKey, task.capability, task.binding);
  const report = await runSemanticFill({
    root,
    tasks: [task],
    envelope: createOfflineSemanticEnvelope({
      maxCalls: 1, maxFailures: 1, transportPolicy: TOKEN_AWARE_POLICY
    }),
    transport: createOfflineSemanticReplayForTasks({
      tasks: [task],
      transportPolicy: TOKEN_AWARE_POLICY,
      result: { kind: "raw", rawJson: SEMANTIC_RAW }
    })
  });
  return report.lazyRunReceipt;
}

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

function writeSealedReceipt(root: string, receipt: LazySemanticRunReceipt): void {
  const directory = join(root, "receipts");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, `${receipt.runIdentity}.json`),
    serializeLazySemanticRunReceipt(receipt));
}
