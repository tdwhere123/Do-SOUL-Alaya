import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  inspectSemanticArtifact,
  reserveSemanticArtifact
} from "../../../runs/extraction/cache/semantic-artifact/store.js";
import {
  runSemanticFill,
  type SemanticFillTask
} from "../../../runs/extraction/fill/semantic-fill-executor.js";

const KEY = "ab".repeat(32);
const KEY_B = "cd".repeat(32);
const CAP = "official_api_signals:v1";

function task(semanticKey: string, assertionId = 1): SemanticFillTask {
  return {
    semanticKey,
    capability: CAP,
    semanticContract: "alaya.assertion_semantic_identity.v1",
    modelFamily: "mimo-v2.5",
    modelId: "mimo-v2.5",
    requestProfile: "mimo-v2.5-nonthinking-v1",
    providerUrlSha256: "44".repeat(32),
    assertionId,
    text: "I moved to Berlin.",
    binding: {
      semanticKey,
      sourceCorpusIdentity: "11".repeat(32),
      sourceTextDigest: "22".repeat(32),
      locator: {
        contract_version: 2,
        kind: "assertion_catalog",
        assertion_id: assertionId,
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

  it("does not admit empty provider JSON as available", () => {
    const report = runSemanticFill({
      root,
      tasks: [task(KEY)],
      envelope: { mode: "offline-only", maxCalls: 4, maxFailures: 2 },
      transport: { complete: () => ({ kind: "raw", rawJson: '{"signals":[]}' }) }
    });
    expect(report.admitted).toBe(0);
    expect(report.calls).toBe(1);
    expect(report.attempts[0]?.outcome).toBe("unresolved");
    expect(inspectSemanticArtifact(root, KEY, CAP).status).toBe("quarantined");
  });

  it("does not mark failed transport work complete and honors stop-loss", () => {
    const tasks = Array.from({ length: 9 }, (_, index) => task(
      `${(index + 1).toString(16).padStart(2, "0")}`.repeat(32),
      index + 1
    ));
    const report = runSemanticFill({
      root,
      tasks,
      envelope: { mode: "offline-only", maxCalls: 1, maxFailures: 8 },
      transport: { complete: () => ({ kind: "failure", reason: "rate limit" }) }
    });
    expect(report.failures).toBe(1);
    expect(report.calls).toBe(1);
    expect(report.stopLoss).toBe(true);
    expect(report.attempts.filter((attempt) => attempt.outcome === "failed")).toHaveLength(8);
    expect(report.attempts.filter((attempt) => attempt.outcome === "unresolved")).toHaveLength(1);
    expect(inspectSemanticArtifact(root, tasks[0]!.semanticKey, CAP).status).toBe("missing");
  });

  it("does not steal a live reservation or pay a second worker", () => {
    reserveSemanticArtifact(root, KEY, CAP);
    const report = runSemanticFill({
      root,
      tasks: [task(KEY)],
      envelope: { mode: "offline-only", maxCalls: 2, maxFailures: 2 },
      transport: { complete: () => ({ kind: "raw", rawJson: '{"signals":[]}' }) }
    });
    expect(report.calls).toBe(0);
    expect(report.attempts[0]?.reason).toMatch(/held/u);
    expect(inspectSemanticArtifact(root, KEY, CAP).status).toBe("reserved");
  });

  it("retries unresolved empty work instead of treating it as complete", () => {
    const transport = { complete: () => ({ kind: "raw" as const, rawJson: '{"signals":[]}' }) };
    const first = runSemanticFill({
      root,
      tasks: [task(KEY)],
      envelope: { mode: "offline-only", maxCalls: 2, maxFailures: 2 },
      transport
    });
    const second = runSemanticFill({
      root,
      tasks: [task(KEY)],
      envelope: { mode: "offline-only", maxCalls: 2, maxFailures: 2 },
      transport
    });
    expect(first.admitted).toBe(0);
    expect(second.calls).toBe(0);
    expect(inspectSemanticArtifact(root, KEY, CAP).status).toBe("quarantined");
  });
});
