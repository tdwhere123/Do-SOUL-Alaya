import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../support/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
afterAll(() => { isolation.restore(); expect(isolation.violations).toEqual([]); });
import { readSemanticFillAttemptEvidence } from
  "../../../runs/extraction/fill/semantic-fill-attempt-ledger.js";
import {
  MAX_LAZY_SEMANTIC_RUN_RECEIPT_BYTES,
  assertCensusLazySemanticReceiptFitsBoundedSerialization,
  estimateLazySemanticReceiptCensusBytes
} from "../../../runs/extraction/fill/semantic-fill-receipt.js";
import { inspectSemanticArtifact, recordedSourceBindings, recordSourceBinding } from
  "../../../runs/extraction/cache/semantic-artifact/store.js";
import { SEMANTIC_CAPABILITY as CAP, semanticTask } from "./semantic-artifact-fixture.js";
import {
  writeAuthoredAdmittedLazyReceipt,
  writeAuthoredFailedLazyReceipt
} from "./authored-lazy-receipt-test-support.js";

describe("semantic fill durable attempt evidence reader", () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "lazy-attempt-reader-")); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it("treats a missing private attempt tree as valid-empty", () => {
    expect(readSemanticFillAttemptEvidence(root)).toEqual([]);
  });

  it("reads authored historical attempt files and rejects a foreign scope entry", () => {
    const task = semanticTask();
    writeAuthoredFailedLazyReceipt(root, task);
    const evidence = readSemanticFillAttemptEvidence(root);
    expect(evidence).toHaveLength(1);
    expect(evidence[0]?.response?.kind).toBe("failure");
    expect(evidence[0]?.memberOutcomes).toEqual([expect.objectContaining({
      semanticKey: task.semanticKey,
      outcome: "failed"
    })]);
    writeFileSync(join(root, ".semantic-fill-private", "attempts", "not-a-digest"), "x");
    expect(() => readSemanticFillAttemptEvidence(root))
      .toThrow(/foreign entry/u);
  });

  it("rejects a tampered attempt payload that no longer matches its ordinal path", () => {
    const task = semanticTask();
    writeAuthoredFailedLazyReceipt(root, task);
    const [record] = readSemanticFillAttemptEvidence(root);
    const directory = join(root, ".semantic-fill-private", "attempts", record!.scopeIdentity);
    writeFileSync(join(directory, "attempt-000000000001.json"), `${JSON.stringify({
      ...record,
      ordinal: 2
    }, null, 2)}\n`);
    expect(() => readSemanticFillAttemptEvidence(root))
      .toThrow(/ordinal path mismatch|durable attempt evidence is invalid/u);
  });

  it("keeps the first authored source binding when a second occurrence shares the semantic key", () => {
    const first = semanticTask();
    const second = {
      ...first,
      binding: { ...first.binding, occurrenceIdentity: "99".repeat(32) }
    };
    writeAuthoredAdmittedLazyReceipt(root, [first]);
    recordSourceBinding(root, first.semanticKey, CAP, second.binding);
    const artifact = inspectSemanticArtifact(root, first.semanticKey, CAP).artifact;
    expect(artifact?.source_bindings[0]?.occurrenceIdentity).toBe(first.binding.occurrenceIdentity);
    const recorded = recordedSourceBindings(root, first.semanticKey, CAP);
    expect(recorded.some((binding) =>
      binding.occurrenceIdentity === second.binding.occurrenceIdentity)).toBe(true);
  });

  it("rejects a non-attempt file inside an otherwise valid scope", () => {
    const task = semanticTask();
    const receipt = writeAuthoredFailedLazyReceipt(root, task);
    const directory = join(root, ".semantic-fill-private", "attempts", receipt.ledgerScopeIdentity);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "notes.txt"), "tamper\n");
    expect(() => readSemanticFillAttemptEvidence(root))
      .toThrow(/foreign entry/u);
  });
});

describe("lazy semantic receipt census bound", () => {
  it("keeps the declared lazy-semantic census inside the shared bounded reader limit", () => {
    expect(() => assertCensusLazySemanticReceiptFitsBoundedSerialization({
      sourceCorpusCount: 35_946,
      substrateCacheKeyCount: 35_946
    })).not.toThrow();
    expect(estimateLazySemanticReceiptCensusBytes({
      occurrenceCount: 37_623,
      uniqueUnits: 35_946,
      sourceCorpusCount: 35_946,
      substrateCacheKeyCount: 35_946
    })).toBeLessThanOrEqual(MAX_LAZY_SEMANTIC_RUN_RECEIPT_BYTES);
  });
});
