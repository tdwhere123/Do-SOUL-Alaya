import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildC0DecisionReceipt,
  readC0DecisionReceipt,
  writeC0DecisionReceipt
} from "../../longmemeval/extraction/c0/decision-receipt.js";

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("C0 decision receipt", () => {
  it("binds the decision to source bytes, inventory, occurrences, and replay", () => {
    const receipt = buildC0DecisionReceipt(fixture());

    expect(receipt.kind).toBe("longmemeval_c0_reuse_decision");
    expect(receipt.decision_digest).toMatch(/^[a-f0-9]{64}$/u);
    expect(readC0DecisionReceiptBytes(JSON.stringify(receipt))).toEqual(receipt);
  });

  it("writes once atomically and refuses to overwrite evidence", () => {
    const root = mkdtempSync(join(tmpdir(), "alaya-c0-receipt-"));
    roots.push(root);
    const path = join(root, "receipt.json");
    const receipt = buildC0DecisionReceipt(fixture());

    writeC0DecisionReceipt(path, receipt);
    expect(readC0DecisionReceipt(path)).toEqual(receipt);
    const original = readFileSync(path, "utf8");
    expect(() => writeC0DecisionReceipt(path, receipt)).toThrow(/already exists/u);
    expect(readFileSync(path, "utf8")).toBe(original);
  });

  it("rejects a receipt whose decision digest no longer binds its payload", () => {
    const root = mkdtempSync(join(tmpdir(), "alaya-c0-receipt-"));
    roots.push(root);
    const path = join(root, "receipt.json");
    const receipt = buildC0DecisionReceipt(fixture());
    writeFileSync(path, JSON.stringify({ ...receipt, source_manifest_sha256: "0".repeat(64) }), "utf8");

    expect(() => readC0DecisionReceipt(path)).toThrow(/digest/u);
  });

  it("rejects a deeply malformed decision even when its outer digest fields look valid", () => {
    const root = mkdtempSync(join(tmpdir(), "alaya-c0-receipt-"));
    roots.push(root);
    const path = join(root, "receipt.json");
    const receipt = buildC0DecisionReceipt(fixture());
    writeFileSync(path, JSON.stringify({
      ...receipt,
      decision: { ...receipt.decision, replay: { ledgerSha256: "3".repeat(64) } }
    }), "utf8");

    expect(() => readC0DecisionReceipt(path)).toThrow(/shape/u);
  });
});

function readC0DecisionReceiptBytes(bytes: string) {
  const root = mkdtempSync(join(tmpdir(), "alaya-c0-receipt-"));
  roots.push(root);
  const path = join(root, "receipt.json");
  writeFileSync(path, bytes, "utf8");
  return readC0DecisionReceipt(path);
}

function fixture() {
  const identity = {
    datasetRevision: "a".repeat(64), model: "gpt-5.4-mini", modelFamily: "gpt-5.4",
    requestProfile: "provider-default-v1", providerUrl: "https://provider.example/v1",
    systemPromptSha256: "b".repeat(64),
    cacheKeyAlgorithm: "sha256(model\\0requestProfile\\0systemPrompt\\0turnContent)",
    rawClosureSha256: "c".repeat(64), parserSemanticsSha256: "d".repeat(64),
    formationSemanticsSha256: "e".repeat(64), temporalSchemaRevision: "relation-assertion-v1"
  };
  return {
    createdAt: "2026-07-17T00:00:00.000Z",
    sourceRoot: "/cache/canonical",
    sourceManifestSha256: "f".repeat(64),
    rawInventorySha256: "1".repeat(64),
    occurrenceIndexSha256: "2".repeat(64),
    decision: {
      action: "reuse" as const,
      sourceRoot: "/cache/canonical",
      reasons: [], source: identity, final: identity,
      replay: {
        occurrenceCount: 2, accountedOccurrences: 2, elementCount: 2, accountedElements: 2,
        admitted: 1, deferred: 1, rejected: 0, invalid: 0, ledgerSha256: "3".repeat(64)
      }
    }
  };
}
