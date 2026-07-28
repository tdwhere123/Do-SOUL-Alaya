import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import type { FineAssessmentSelectionBoundaryCase } from "@do-soul/alaya-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { replayBoundary } = vi.hoisted(() => ({
  replayBoundary: vi.fn((boundary: FineAssessmentSelectionBoundaryCase) => boundary)
}));

vi.mock("@do-soul/alaya-core", () => ({
  replayFineAssessmentSelectionBoundary: replayBoundary
}));

import {
  createLongMemEvalSelectionBoundarySpool,
  LONGMEMEVAL_SELECTION_BOUNDARY_GZIP_MAX_BYTES,
  verifyLongMemEvalSelectionBoundaryArtifact,
  type LongMemEvalSelectionBoundarySpool
} from "../../../longmemeval/selection-replay/selection-boundary-spool.js";

const roots: string[] = [];
const spools: LongMemEvalSelectionBoundarySpool[] = [];

beforeEach(() => {
  replayBoundary.mockClear();
});

afterEach(async () => {
  await Promise.all(spools.splice(0).map((spool) => spool.dispose()));
  await Promise.all(roots.splice(0).map(
    (root) => rm(root, { recursive: true, force: true })
  ));
});

describe("LongMemEval selection-boundary spool", () => {
  it("is absent by default and refuses concurrent experimental capture", async () => {
    expect(LONGMEMEVAL_SELECTION_BOUNDARY_GZIP_MAX_BYTES).toBe(64 * 1024 * 1024);
    await expect(createLongMemEvalSelectionBoundarySpool({
      env: {},
      concurrency: 1
    })).resolves.toBeNull();

    await expect(createLongMemEvalSelectionBoundarySpool({
      env: { ALAYA_BENCH_SELECTION_REPLAY: "1" },
      concurrency: 2
    })).rejects.toThrow(/selection replay.*concurrency=1/u);
  });

  it("streams question-local invocations and replays every gzip record", async () => {
    const spool = await enabledSpool();
    const outputRoot = await temporaryRoot();
    const artifactPath = join(outputRoot, "selection-boundaries.ndjson.gz");
    const first = spool.beginQuestion("question-1");
    first.observer(boundary("first"));
    first.observer(boundary("second"));
    await first.commit();
    const second = spool.beginQuestion("question-2");
    second.observer(boundary("third"));
    await second.commit();

    await spool.writeGzipArtifact(artifactPath);

    const records = gunzipSync(await readFile(artifactPath))
      .toString("utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(records).toEqual([
      record("question-1", 0, false, boundary("first")),
      record("question-1", 1, true, boundary("second")),
      record("question-2", 0, true, boundary("third"))
    ]);
    expect(records.every((row) => Object.keys(row).sort().join(",") ===
      "authoritative,boundary,invocation_index,question_id")).toBe(true);
    expect(JSON.stringify(records)).not.toMatch(/gold|answer|evaluator/u);

    await expect(
      verifyLongMemEvalSelectionBoundaryArtifact(artifactPath)
    ).resolves.toEqual({ recordCount: 3 });
    expect(replayBoundary.mock.calls.map(([captured]) => captured)).toEqual([
      boundary("first"),
      boundary("second"),
      boundary("third")
    ]);
  });

  it("fails loud and leaves no artifact when the gzip limit is exceeded", async () => {
    const spool = await enabledSpool(1);
    const outputRoot = await temporaryRoot();
    const artifactPath = join(outputRoot, "too-large.ndjson.gz");
    const capture = spool.beginQuestion("question-large");
    capture.observer(boundary("x".repeat(4_096)));
    await capture.commit();

    await expect(spool.writeGzipArtifact(artifactPath))
      .rejects.toThrow(/selection replay.*64 MiB|selection replay.*size limit/u);
    await expect(access(artifactPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails loud when a scored recall never reaches selection", async () => {
    const spool = await enabledSpool();
    const capture = spool.beginQuestion("question-without-selection");

    await expect(capture.commit())
      .rejects.toThrow(/captured no selection invocation/u);
  });
});

async function enabledSpool(
  maxArtifactBytes?: number
): Promise<LongMemEvalSelectionBoundarySpool> {
  const spool = await createLongMemEvalSelectionBoundarySpool({
    env: { ALAYA_BENCH_SELECTION_REPLAY: "1" },
    concurrency: 1,
    ...(maxArtifactBytes === undefined ? {} : { maxArtifactBytes })
  });
  if (spool === null) throw new Error("selection replay spool was not enabled");
  spools.push(spool);
  return spool;
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "selection-replay-test-"));
  roots.push(root);
  return root;
}

function boundary(seed: string): FineAssessmentSelectionBoundaryCase {
  return {
    schema_version: 1,
    input: { fixture_seed: seed },
    expected: { fixture_seed: seed }
  } as unknown as FineAssessmentSelectionBoundaryCase;
}

function record(
  questionId: string,
  invocationIndex: number,
  authoritative: boolean,
  selectionBoundary: FineAssessmentSelectionBoundaryCase
) {
  return {
    question_id: questionId,
    invocation_index: invocationIndex,
    authoritative,
    boundary: selectionBoundary
  };
}
