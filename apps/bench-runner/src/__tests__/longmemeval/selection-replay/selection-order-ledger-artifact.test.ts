import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { captureFineAssessmentSelectionBoundary } from
  "../../../../../../packages/core/src/__tests__/recall/selection-boundary-live-capture-fixture.js";

const { measureGitState } = vi.hoisted(() => ({
  measureGitState: vi.fn(async () => ({
    commitSha: "a".repeat(40),
    commitSha7: "a".repeat(7),
    worktreeStateSha256: "b".repeat(64),
    worktreeClean: true
  }))
}));

vi.mock(
  "../../../longmemeval/provenance/contract/frozen-code-contract.js",
  () => ({ measureGitState })
);

import { materializeSelectionOrderLedgerArtifact } from
  "../../../longmemeval/selection-replay/selection-order-ledger-artifact.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(
    (root) => rm(root, { recursive: true, force: true })
  ));
});

describe("selection order ledger artifact", () => {
  it("binds the source and publishes one immutable canonical ledger", async () => {
    const root = await temporaryRoot();
    const sourcePath = join(root, "selection-boundaries.ndjson.gz");
    const outputPath = join(root, "selection-order-ledger.ndjson.gz");
    const boundary = captureFineAssessmentSelectionBoundary("ledger-artifact");
    const source = gzipSync(`${JSON.stringify({
      question_id: "question-1",
      invocation_index: 0,
      authoritative: true,
      boundary
    })}\n`);
    await writeFile(sourcePath, source, { flag: "wx" });
    const sourceSha256 = createHash("sha256").update(source).digest("hex");

    const identity = await materializeSelectionOrderLedgerArtifact({
      sourcePath,
      expectedSourceSha256: sourceSha256,
      outputPath,
      checkoutRoot: root
    });
    const rows = gunzipSync(await readFile(outputPath)).toString("utf8")
      .trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);

    expect(identity).toMatchObject({
      source_sha256: sourceSha256,
      source_commit: "a".repeat(40),
      question_count: 1,
      coarse_unavailable_questions: 0
    });
    expect(rows.map((row) => row.record_type)).toEqual([
      "manifest", "question", "summary"
    ]);
    expect(rows[0]).toMatchObject({
      source_artifact_sha256: sourceSha256,
      source_commit: "a".repeat(40)
    });
    expect(rows[2]).toMatchObject({
      question_count: 1,
      coarse_unavailable_questions: 0
    });
    await expect(materializeSelectionOrderLedgerArtifact({
      sourcePath,
      expectedSourceSha256: sourceSha256,
      outputPath,
      checkoutRoot: root
    })).rejects.toBeDefined();
  });

  it("rejects a source digest mismatch before publication", async () => {
    const root = await temporaryRoot();
    const sourcePath = join(root, "selection-boundaries.ndjson.gz");
    await writeFile(sourcePath, gzipSync("{}\n"), { flag: "wx" });

    await expect(materializeSelectionOrderLedgerArtifact({
      sourcePath,
      expectedSourceSha256: "0".repeat(64),
      outputPath: join(root, "ledger.ndjson.gz"),
      checkoutRoot: root
    })).rejects.toThrow(/source SHA-256 mismatch/u);
  });

  it("rejects a legacy source without coarse identity before publication", async () => {
    const root = await temporaryRoot();
    const sourcePath = join(root, "legacy-selection-boundaries.ndjson.gz");
    const outputPath = join(root, "legacy-ledger.ndjson.gz");
    const captured = captureFineAssessmentSelectionBoundary("legacy-ledger");
    const boundary = {
      ...captured,
      input: { ...captured.input, packet_candidate_keys: undefined }
    };
    const source = gzipSync(`${JSON.stringify({
      question_id: "legacy-question",
      invocation_index: 0,
      authoritative: true,
      boundary
    })}\n`);
    await writeFile(sourcePath, source, { flag: "wx" });
    const sourceSha256 = createHash("sha256").update(source).digest("hex");

    await expect(materializeSelectionOrderLedgerArtifact({
      sourcePath,
      expectedSourceSha256: sourceSha256,
      outputPath,
      checkoutRoot: root
    })).rejects.toThrow(/coarse identity is unavailable/u);
    await expect(readFile(outputPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "selection-order-ledger-test-"));
  roots.push(root);
  return root;
}
