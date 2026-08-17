import { FIELD_PINS } from "../../../../../../packages/core/src/__tests__/recall/fine-assessment-selection-fixtures.js";
import { createHash } from "node:crypto";
import {
  access,
  mkdtemp,
  readFile,
  rm,
  stat,
  truncate,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import type { FineAssessmentSelectionBoundaryCase } from "@do-soul/alaya-core";
import { materializeFineAssessmentSelectionBoundary } from
  "../../../../../../packages/core/src/recall/delivery/selection-boundary/selection-boundary-capture.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { selectFineAssessmentCandidates } from
  "../../../../../../packages/core/src/recall/delivery/fine-assessment-selection.js";
import {
  createConfig,
  createRankedCandidate,
  createSupplementaryData,
  rankMap
} from
  "../../../../../../packages/core/src/__tests__/recall/fine-assessment-selection-fixtures.js";
import { forEachSelectionBoundaryGzipRecord } from
  "../../../bench/selection-replay/selection-boundary-artifact-reader.js";

const { replayBoundary } = vi.hoisted(() => ({
  replayBoundary: vi.fn<
    (boundary: FineAssessmentSelectionBoundaryCase) => unknown
  >((boundary) => boundary)
}));

vi.mock("@do-soul/alaya-core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@do-soul/alaya-core")>();
  const captureModule = await import(
    "../../../../../../packages/core/src/recall/delivery/selection-boundary/selection-boundary-capture.js"
  );
  return {
    ...actual,
    materializeFineAssessmentSelectionBoundary:
      captureModule.materializeFineAssessmentSelectionBoundary,
    replayFineAssessmentSelectionBoundary: replayBoundary
  };
});

import {
  createLongMemEvalSelectionBoundarySpool,
  LONGMEMEVAL_SELECTION_BOUNDARY_GZIP_MAX_BYTES,
  verifyLongMemEvalSelectionBoundaryArtifact,
  type LongMemEvalSelectionBoundarySpool
} from "../../../bench/selection-replay/selection-boundary-spool.js";

const roots: string[] = [];
const spools: LongMemEvalSelectionBoundarySpool[] = [];

beforeEach(() => {
  replayBoundary.mockReset();
  replayBoundary.mockImplementation((boundary) => boundary);
});

afterEach(async () => {
  await Promise.all(spools.splice(0).map((spool) => spool.dispose()));
  await Promise.all(roots.splice(0).map(
    (root) => rm(root, { recursive: true, force: true })
  ));
});

describe("LongMemEval selection-boundary spool", () => {
  it("is absent by default and refuses concurrent experimental capture", async () => {
    expect(LONGMEMEVAL_SELECTION_BOUNDARY_GZIP_MAX_BYTES).toBe(256 * 1024 * 1024);
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

    const identity = await spool.writeGzipArtifact(artifactPath);
    expect(replayBoundary).toHaveBeenCalledTimes(3);
    replayBoundary.mockClear();

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
    const artifact = await readFile(artifactPath);
    expect(identity).toEqual({
      sha256: createHash("sha256").update(artifact).digest("hex"),
      bytes: artifact.byteLength,
      recordCount: 3
    });

    await expect(
      verifyLongMemEvalSelectionBoundaryArtifact(artifactPath)
    ).resolves.toMatchObject({ recordCount: 3, questionCount: 2 });
    expect(replayBoundary.mock.calls.map(([captured]) => captured)).toEqual([
      boundary("first"),
      boundary("second"),
      boundary("third")
    ]);
  });

  it("round-trips a real schema-v2 capture with a 2 MiB record", async () => {
    vi.doUnmock("@do-soul/alaya-core");
    vi.resetModules();
    const realSpoolModule = await import(
      "../../../bench/selection-replay/selection-boundary-spool.js"
    );
    const spool = await realSpoolModule.createLongMemEvalSelectionBoundarySpool({
      env: { ALAYA_BENCH_SELECTION_REPLAY: "1" },
      concurrency: 1
    });
    if (spool === null) throw new Error("selection replay spool was not enabled");
    spools.push(spool);
    const outputRoot = await temporaryRoot();
    const artifactPath = join(outputRoot, "selection-boundaries-v2.ndjson.gz");
    const boundaryV2 = largeCapturedBoundaryV2();
    const capture = spool.beginQuestion("question-v2");
    capture.observer(boundaryV2);
    await capture.commit();
    expect((await stat(rawSpoolPath(spool))).size).toBeGreaterThan(2 * 1024 * 1024);
    await spool.writeGzipArtifact(artifactPath);

    expect(boundaryV2.schema_version).toBe(2);
    await expect(
      realSpoolModule.verifyLongMemEvalSelectionBoundaryArtifact(artifactPath)
    ).resolves.toMatchObject({ recordCount: 1, questionCount: 1 });
    expect(replayBoundary).not.toHaveBeenCalled();
  });

  it("treats literal U+2028 and U+2029 as JSON content, not record delimiters", async () => {
    vi.doUnmock("@do-soul/alaya-core");
    vi.resetModules();
    const realSpoolModule = await import(
      "../../../bench/selection-replay/selection-boundary-spool.js"
    );
    const outputRoot = await temporaryRoot();
    const artifactPath = join(outputRoot, "selection-boundaries-unicode.ndjson.gz");
    const candidate = createRankedCandidate("candidate-unicode", 1, 0.9);
    const boundaryV2 = capturedBoundaryV2([{
      ...candidate,
      entry: {
        ...candidate.entry,
        content: "before\u2028middle\u2029after"
      }
    }]);
    const encoded = `${JSON.stringify(
      record("question-unicode", 0, true, boundaryV2)
    )}\n`;

    expect(encoded).toContain("\u2028");
    expect(encoded).toContain("\u2029");
    expect([...encoded].filter((character) => character === "\n")).toHaveLength(1);
    expect(() => JSON.parse(encoded.slice(0, -1))).not.toThrow();
    await writeFile(artifactPath, gzipSync(Buffer.from(encoded, "utf8")));

    await expect(
      realSpoolModule.verifyLongMemEvalSelectionBoundaryArtifact(artifactPath)
    ).resolves.toMatchObject({ recordCount: 1, questionCount: 1 });
  });

  it("rejects truncated committed source identity before publishing", async () => {
    vi.doUnmock("@do-soul/alaya-core");
    vi.resetModules();
    const realSpoolModule = await import(
      "../../../bench/selection-replay/selection-boundary-spool.js"
    );
    const spool = await realSpoolModule.createLongMemEvalSelectionBoundarySpool({
      env: { ALAYA_BENCH_SELECTION_REPLAY: "1" },
      concurrency: 1
    });
    if (spool === null) throw new Error("selection replay spool was not enabled");
    spools.push(spool);
    const outputRoot = await temporaryRoot();
    const artifactPath = join(outputRoot, "selection-boundaries-truncated.ndjson.gz");
    const capture = spool.beginQuestion("question-truncated");
    capture.observer(largeCapturedBoundaryV2());
    await capture.commit();
    expect((await stat(rawSpoolPath(spool))).size).toBeGreaterThan(1024 * 1024);
    await truncate(rawSpoolPath(spool), 1024 * 1024);

    await expect(spool.writeGzipArtifact(artifactPath))
      .rejects.toThrow(/selection replay source identity mismatch/u);
    await expect(access(artifactPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reports bounded non-content context for a truncated record", async () => {
    const outputRoot = await temporaryRoot();
    const artifactPath = join(outputRoot, "selection-boundaries-invalid.ndjson.gz");
    const secret = "PRIVATE_SELECTION_BOUNDARY_CONTENT";
    const truncatedRecord = `{"boundary":"${secret}界`;
    await writeFile(artifactPath, gzipSync(Buffer.from(truncatedRecord, "utf8")));
    const sha256 = createHash("sha256")
      .update(truncatedRecord, "utf8")
      .digest("hex");

    const error = await verifyLongMemEvalSelectionBoundaryArtifact(artifactPath)
      .then(() => null, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain("record_index=0");
    expect(message).toContain(`chars=${truncatedRecord.length}`);
    expect(message).toContain(
      `utf8_bytes=${Buffer.byteLength(truncatedRecord, "utf8")}`
    );
    expect(message).toContain(`sha256=${sha256}`);
    expect(message).not.toContain(secret);
  });

  it("rejects an externally verified gzip above its injected compressed cap", async () => {
    const outputRoot = await temporaryRoot();
    const artifactPath = join(outputRoot, "selection-boundaries-capped.ndjson.gz");
    const encoded = `${JSON.stringify(
      record("question-capped", 0, true, boundary("capped"))
    )}\n`;
    await writeFile(artifactPath, gzipSync(Buffer.from(encoded, "utf8")));

    await expect(
      verifyLongMemEvalSelectionBoundaryArtifact(artifactPath, 1)
    ).rejects.toThrow(
      "selection replay gzip exceeds the 1 byte size limit"
    );
  });

  it("rejects an empty artifact and a globally repeated question", async () => {
    const outputRoot = await temporaryRoot();
    const emptyPath = join(outputRoot, "selection-boundaries-empty.ndjson.gz");
    await writeFile(emptyPath, gzipSync(""));
    await expect(verifyLongMemEvalSelectionBoundaryArtifact(emptyPath))
      .rejects.toThrow(/contains no records/u);

    const repeatedPath = join(outputRoot, "selection-boundaries-repeated.ndjson.gz");
    const repeated = [
      record("question-1", 0, true, boundary("first")),
      record("question-2", 0, true, boundary("second")),
      record("question-1", 0, true, boundary("repeated"))
    ];
    await writeFile(
      repeatedPath,
      gzipSync(`${repeated.map((row) => JSON.stringify(row)).join("\n")}\n`)
    );
    await expect(verifyLongMemEvalSelectionBoundaryArtifact(repeatedPath))
      .rejects.toThrow(/repeats question_id question-1/u);
  });

  it("caps decompressed artifact bytes before buffering a record", async () => {
    const outputRoot = await temporaryRoot();
    const artifactPath = join(outputRoot, "selection-boundaries-expanded.ndjson.gz");
    await writeFile(artifactPath, gzipSync("x".repeat(2_048)));

    await expect(forEachSelectionBoundaryGzipRecord(
      artifactPath,
      1_024,
      {
        utf8Invalid: () => "invalid UTF-8",
        jsonInvalid: () => "invalid JSON",
        gzipExceeded: () => "gzip exceeded"
      },
      () => undefined
    )).rejects.toThrow(/decompressed bytes/u);
  });

  it("preserves a consumer failure when the pipeline aborts upstream", async () => {
    const outputRoot = await temporaryRoot();
    const artifactPath = join(outputRoot, "selection-boundaries-consumer.ndjson.gz");
    const rows = Array.from({ length: 100 }, (_, index) => JSON.stringify(
      record(`question-${index}`, 0, true, boundary(`consumer-${index}`))
    ));
    await writeFile(artifactPath, gzipSync(`${rows.join("\n")}\n`));
    const expected = new Error("consumer authority rejection");

    await expect(forEachSelectionBoundaryGzipRecord(
      artifactPath,
      256 * 1024 * 1024,
      {
        utf8Invalid: () => "invalid UTF-8",
        jsonInvalid: () => "invalid JSON",
        gzipExceeded: () => "gzip exceeded"
      },
      () => { throw expected; }
    )).rejects.toBe(expected);
  });

  it("fails loud and leaves no artifact when the gzip limit is exceeded", async () => {
    const spool = await enabledSpool(1);
    const outputRoot = await temporaryRoot();
    const artifactPath = join(outputRoot, "too-large.ndjson.gz");
    const capture = spool.beginQuestion("question-large");
    capture.observer(boundary("x".repeat(4_096)));
    await capture.commit();

    await expect(spool.writeGzipArtifact(artifactPath))
      .rejects.toThrow(
        "selection replay gzip exceeds the 1 byte size limit"
      );
    await expect(access(artifactPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not overwrite an existing artifact destination", async () => {
    const spool = await enabledSpool();
    const capture = spool.beginQuestion("question-existing-output");
    capture.observer(boundary("existing-output"));
    await capture.commit();
    const outputRoot = await temporaryRoot();
    const artifactPath = join(outputRoot, "existing.ndjson.gz");
    await writeFile(artifactPath, "operator-owned\n", { flag: "wx" });

    await expect(spool.writeGzipArtifact(artifactPath)).rejects.toMatchObject({
      code: "EEXIST"
    });
    await expect(readFile(artifactPath, "utf8")).resolves.toBe("operator-owned\n");
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

function capturedBoundaryV2(
  candidates = [
    createRankedCandidate("candidate-1", 1, 0.9),
    createRankedCandidate("candidate-2", 2, 0.8)
  ]
): FineAssessmentSelectionBoundaryCase {
  let captured: FineAssessmentSelectionBoundaryCase | undefined;
  selectFineAssessmentCandidates({
    ...FIELD_PINS,
    orderedCandidates: candidates,
    config: createConfig(),
    supplementaryData: createSupplementaryData(),
    tokenEstimator: { estimate: () => 5 },
    rankByCandidateKey: rankMap(candidates),
    finalRelevanceByCandidateKey: new Map(candidates.map((candidate) => [
      candidate.fusion.candidate_key,
      candidate.fusion.fused_score
    ])),
    captureAnswerFeatures: true,
    capturePacketPlanTrace: true,
    selectionBoundaryObserver: (pending) => {
      captured = materializeFineAssessmentSelectionBoundary(pending);
      return undefined;
    }
  });
  if (captured === undefined) {
    throw new Error("selection boundary was not observed");
  }
  return captured;
}

function largeCapturedBoundaryV2(): FineAssessmentSelectionBoundaryCase {
  const content = "x".repeat(60 * 1024);
  return capturedBoundaryV2(Array.from({ length: 36 }, (_, index) => {
    const candidate = createRankedCandidate(
      `candidate-${index + 1}`,
      index + 1,
      1 - index / 100
    );
    return { ...candidate, entry: { ...candidate.entry, content } };
  }));
}

function rawSpoolPath(spool: LongMemEvalSelectionBoundarySpool): string {
  return join(spool.rootPath, "selection-boundaries.ndjson");
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
