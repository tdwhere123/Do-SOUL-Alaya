import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { inspectSemanticArtifact } from "../../../runs/extraction/cache/semantic-artifact/store.js";
import {
  runSemanticFill,
  type SemanticFillTask
} from "../../../runs/extraction/fill/semantic-fill-executor.js";

const KEY = "ab".repeat(32);
const KEY_B = "cd".repeat(32);
const CAP = "official_api_signals:v1";

function task(semanticKey: string): SemanticFillTask {
  return {
    semanticKey,
    capability: CAP,
    semanticContract: "alaya.assertion_semantic_identity.v1",
    modelFamily: "mimo-v2.5",
    modelId: "mimo-v2.5",
    binding: {
      semanticKey,
      sourceCorpusIdentity: "11".repeat(32),
      sourceTextDigest: "22".repeat(32),
      locator: {
        contract_version: 2,
        kind: "assertion_catalog",
        assertion_id: 1,
        start: 0,
        end: 8
      }
    }
  };
}

describe("semantic fill executor", () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "semantic-fill-")); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it("admits missing work once and skips on resume", () => {
    const transport = { complete: () => ({ kind: "raw" as const, rawJson: '{"signals":[]}' }) };
    const first = runSemanticFill({
      root,
      tasks: [task(KEY)],
      envelope: { mode: "offline-only", maxCalls: 4, maxFailures: 2 },
      transport
    });
    const second = runSemanticFill({
      root,
      tasks: [task(KEY)],
      envelope: { mode: "offline-only", maxCalls: 4, maxFailures: 2 },
      transport
    });
    expect(first).toMatchObject({ admitted: 1, calls: 1, unresolved: 0 });
    expect(second).toMatchObject({ admitted: 0, calls: 0 });
    expect(second.attempts[0]?.outcome).toBe("skipped");
    expect(inspectSemanticArtifact(root, KEY, CAP).status).toBe("provider_backed");
  });

  it("does not mark failed transport work complete and honors stop-loss", () => {
    const transport = {
      complete: () => ({ kind: "failure" as const, reason: "rate limit" })
    };
    const report = runSemanticFill({
      root,
      tasks: [task(KEY), task(KEY_B)],
      envelope: { mode: "offline-only", maxCalls: 8, maxFailures: 1 },
      transport
    });
    expect(report.failures).toBe(1);
    expect(report.stopLoss).toBe(true);
    expect(report.attempts.map((attempt) => attempt.outcome)).toEqual(["failed", "unresolved"]);
    expect(inspectSemanticArtifact(root, KEY, CAP).status).toBe("missing");
  });

  it("converges duplicate workers on one admission", () => {
    const transport = { complete: () => ({ kind: "raw" as const, rawJson: '{"signals":[]}' }) };
    runSemanticFill({
      root,
      tasks: [task(KEY)],
      envelope: { mode: "offline-only", maxCalls: 2, maxFailures: 2 },
      transport
    });
    const duplicate = runSemanticFill({
      root,
      tasks: [task(KEY), task(KEY)],
      envelope: { mode: "offline-only", maxCalls: 2, maxFailures: 2 },
      transport
    });
    expect(duplicate.calls).toBe(0);
    expect(duplicate.attempts.every((attempt) => attempt.outcome === "skipped")).toBe(true);
  });
});
