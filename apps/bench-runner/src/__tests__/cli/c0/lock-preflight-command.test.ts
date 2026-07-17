import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runC0LockPreflightCommand } from "../../../cli/c0/lock-preflight-command.js";
import { buildC0DecisionReceipt } from
  "../../../longmemeval/extraction/c0/decision-receipt.js";
import { hashC0RawShardInventory } from
  "../../../longmemeval/extraction/c0/raw-inventory.js";
import { hashC0OccurrenceIndex } from
  "../../../longmemeval/extraction/c0/occurrence-index.js";
import { hashC0Replay } from "../../../longmemeval/extraction/c0/replay.js";

const roots: string[] = [];
const token = "must-not-leak-from-c0-lock-owner";

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("c0-lock-preflight command", () => {
  it("writes one redacted, receipt-bound preflight without moving the source lock", () => {
    const fixture = createFixture();
    const stdout: string[] = [];
    const stderr: string[] = [];

    const code = runC0LockPreflightCommand(["--c0-decision", fixture.decisionPath], {
      observePid: (pid) => ({ status: "absent_current_namespace", pid }),
      writeStdout: (text) => stdout.push(text),
      writeStderr: (text) => stderr.push(text)
    });

    const artifact = readFileSync(join(fixture.evidenceRoot, "lock-preflight.json"), "utf8");
    expect(code).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout.join("")).toContain("lock_migration=not_attempted");
    expect(artifact).toContain("absent_current_namespace");
    expect(artifact).not.toContain(token);
    expect(artifact).not.toContain("token_present");
    expect(readFileSync(join(fixture.sourceLock, "owner.json"), "utf8")).toContain(token);
    expect(existsSync(join(fixture.evidenceRoot, ".extraction-fill.lock"))).toBe(false);
    expect(existsSync(join(fixture.evidenceRoot, ".c0-lock-isolation-prepared.json"))).toBe(false);
    expect(existsSync(join(fixture.evidenceRoot, ".c0-lock-isolation-receipt.json"))).toBe(false);
  });

  it("fails closed if source manifest bytes changed after the C0 decision", () => {
    const fixture = createFixture();
    writeFileSync(join(fixture.sourceRoot, "manifest.json"), "changed\n", "utf8");
    const errors: string[] = [];

    const code = runC0LockPreflightCommand(["--c0-decision", fixture.decisionPath], {
      writeStderr: (text) => errors.push(text)
    });

    expect(code).toBe(2);
    expect(errors.join("")).toMatch(/source manifest changed/u);
    expect(existsSync(join(fixture.evidenceRoot, "lock-preflight.json"))).toBe(false);
    expect(existsSync(fixture.sourceLock)).toBe(true);
  });

  it("does not accept a caller-supplied source root override", () => {
    const fixture = createFixture();
    const errors: string[] = [];

    const code = runC0LockPreflightCommand([
      "--c0-decision", fixture.decisionPath, "--extraction-cache-root", "/wrong-root"
    ], { writeStderr: (text) => errors.push(text) });

    expect(code).toBe(2);
    expect(errors.join("")).toMatch(/usage/u);
    expect(existsSync(join(fixture.evidenceRoot, "lock-preflight.json"))).toBe(false);
  });

  it("does not overwrite a prior preflight artifact or touch the source lock", () => {
    const fixture = createFixture();
    const artifactPath = join(fixture.evidenceRoot, "lock-preflight.json");
    writeFileSync(artifactPath, "prior evidence\n", "utf8");
    const ownerBefore = readFileSync(join(fixture.sourceLock, "owner.json"), "utf8");
    const errors: string[] = [];

    const code = runC0LockPreflightCommand(["--c0-decision", fixture.decisionPath], {
      writeStderr: (text) => errors.push(text)
    });

    expect(code).toBe(2);
    expect(errors.join("")).toMatch(/already exists/u);
    expect(readFileSync(artifactPath, "utf8")).toBe("prior evidence\n");
    expect(readFileSync(join(fixture.sourceLock, "owner.json"), "utf8")).toBe(ownerBefore);
  });

  it("records existing relocation evidence as a non-movable preflight state", () => {
    const fixture = createFixture();
    writeFileSync(join(fixture.evidenceRoot, ".c0-lock-isolation-prepared.json"), "prior\n", "utf8");
    const stdout: string[] = [];

    const code = runC0LockPreflightCommand(["--c0-decision", fixture.decisionPath], {
      observePid: (pid) => ({ status: "unavailable", pid }),
      writeStdout: (text) => stdout.push(text)
    });

    const artifact = JSON.parse(readFileSync(join(fixture.evidenceRoot, "lock-preflight.json"), "utf8"));
    expect(code).toBe(0);
    expect(artifact.preflight.prepared_journal_clear).toBe(false);
    expect(artifact.preflight.relocation_receipt_clear).toBe(true);
    expect(stdout.join("")).toContain("lock_migration=not_attempted");
    expect(existsSync(fixture.sourceLock)).toBe(true);
  });
});

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "alaya-c0-lock-preflight-"));
  roots.push(root);
  const sourceRoot = join(root, "source-cache");
  const sourceLock = join(sourceRoot, ".extraction-fill.lock");
  const evidenceRoot = join(root, "evidence");
  mkdirSync(sourceLock, { recursive: true });
  mkdirSync(evidenceRoot);
  const manifest = "{\"schema_version\":3}\n";
  writeFileSync(join(sourceRoot, "manifest.json"), manifest, "utf8");
  writeFileSync(join(evidenceRoot, "source-manifest.json"), manifest, "utf8");
  writeFileSync(join(sourceLock, "owner.json"), JSON.stringify({
    pid: 23, started_at: "2026-07-17T00:00:00.000Z", token
  }), "utf8");
  const inventory = {
    shards: [], orphanKeys: [], unexpectedPaths: [],
    counts: { expected: 0, hit: 0, missing: 0, invalid: 0, orphan: 0 }
  };
  const rawInventorySha256 = hashC0RawShardInventory(inventory);
  const occurrenceIndexSha256 = hashC0OccurrenceIndex([]);
  const replay = {
    occurrences: [],
    closure: {
      occurrenceCount: 0, accountedOccurrences: 0, elementCount: 0, accountedElements: 0,
      admitted: 0, deferred: 0, rejected: 0, invalid: 0, ledgerSha256: ""
    }
  };
  replay.closure.ledgerSha256 = hashC0Replay(replay);
  writeFileSync(join(evidenceRoot, "raw-inventory.json"), JSON.stringify({
    sha256: rawInventorySha256, inventory
  }), "utf8");
  writeFileSync(join(evidenceRoot, "occurrence-index.json"), JSON.stringify({
    sha256: occurrenceIndexSha256, occurrences: []
  }), "utf8");
  writeFileSync(join(evidenceRoot, "replay-ledger.json"), JSON.stringify({
    sha256: replay.closure.ledgerSha256, closure: replay.closure, occurrences: []
  }), "utf8");
  const decision = buildC0DecisionReceipt({
    createdAt: "2026-07-17T00:00:00.000Z",
    sourceRoot,
    sourceManifestSha256: hash(manifest),
    rawInventorySha256,
    occurrenceIndexSha256,
    decision: {
      action: "rebuild",
      sourceRoot,
      reasons: ["provider_url_mismatch"],
      source: identity("https://source.example/v1"),
      final: identity("https://final.example/v1"),
      replay: {
        ...replay.closure
      }
    }
  });
  const decisionPath = join(evidenceRoot, "decision.json");
  writeFileSync(decisionPath, `${JSON.stringify(decision, null, 2)}\n`, "utf8");
  return { sourceRoot, sourceLock, evidenceRoot, decisionPath };
}

function identity(providerUrl: string) {
  return {
    datasetRevision: "a".repeat(64), model: "gpt-5.4-mini", modelFamily: "gpt-5.4-mini",
    requestProfile: "provider-default-v1", providerUrl,
    systemPromptSha256: "b".repeat(64),
    cacheKeyAlgorithm: "sha256(model\\0requestProfile\\0systemPrompt\\0turnContent)",
    rawClosureSha256: "c".repeat(64), parserSemanticsSha256: "d".repeat(64),
    formationSemanticsSha256: "e".repeat(64), temporalSchemaRevision: "relation-assertion-v1"
  };
}

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
