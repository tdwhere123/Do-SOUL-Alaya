import { createHash } from "node:crypto";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { streamLongMemEvalDataset } from
  "../../../datasets/longmemeval/ingestion/streaming-dataset-reader.js";

const READ_CHUNK_BYTES = 64 * 1024;
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })
  ));
});

describe("streamLongMemEvalDataset", () => {
  it.each([
    ["multibyte code point", "雪"],
    ["escaped backslash and quote", "\\\""]
  ])("preserves a %s split at the read boundary", async (_label, suffix) => {
    const template = questionFixture("__BOUNDARY__");
    const templateRaw = JSON.stringify([template]);
    const markerOffset = Buffer.byteLength(
      templateRaw.slice(0, templateRaw.indexOf("__BOUNDARY__")),
      "utf8"
    );
    const content = `${"x".repeat(READ_CHUNK_BYTES - 1 - markerOffset)}${suffix}`;
    const raw = JSON.stringify([questionFixture(content)]);
    const boundaryBytes = Buffer.from(raw, "utf8");
    const suffixOffset = boundaryBytes.indexOf(Buffer.from(suffix[0]!, "utf8"));
    expect(suffixOffset).toBe(READ_CHUNK_BYTES - 1);
    const sourcePath = await writeFixture(boundaryBytes);
    const questions: unknown[] = [];

    const identity = await streamLongMemEvalDataset(
      sourcePath,
      {
        datasetLabel: "fixture",
        expectedBytes: boundaryBytes.byteLength,
        maxQuestionCount: 1
      },
      (question) => questions.push(question)
    );

    expect(identity.parseError).toBeUndefined();
    expect(identity.questionCount).toBe(1);
    expect(identity.sha256).toBe(createHash("sha256").update(boundaryBytes).digest("hex"));
    expect(questions).toEqual([questionFixture(content)]);
  });

  it("bounds one question before retaining an unbounded raw value", async () => {
    const raw = Buffer.from(JSON.stringify([
      questionFixture("x".repeat(4 * 1024 * 1024 + 1))
    ]), "utf8");
    const sourcePath = await writeFixture(raw);

    const identity = await streamLongMemEvalDataset(
      sourcePath,
      { datasetLabel: "fixture", expectedBytes: raw.length, maxQuestionCount: 1 },
      () => undefined
    );

    expect(identity.parseError?.message).toMatch(/question exceeds byte limit/u);
    expect(identity.sha256).toBe(createHash("sha256").update(raw).digest("hex"));
  });

  it("bounds parsed rows before invoking more callbacks", async () => {
    const raw = Buffer.from(JSON.stringify([
      questionFixture("first"),
      { ...questionFixture("second"), question_id: "fixture-stream-2" }
    ]), "utf8");
    const sourcePath = await writeFixture(raw);
    const questions: unknown[] = [];

    const identity = await streamLongMemEvalDataset(
      sourcePath,
      { datasetLabel: "fixture", expectedBytes: raw.length, maxQuestionCount: 1 },
      (question) => questions.push(question)
    );

    expect(identity.parseError?.message).toMatch(/pinned question count/u);
    expect(questions).toHaveLength(1);
  });

  it("rejects excessive delimiter nesting", async () => {
    const nesting = "[".repeat(65) + "0" + "]".repeat(65);
    const raw = Buffer.from(`[{"extra":${nesting}}]`, "utf8");
    const sourcePath = await writeFixture(raw);

    const identity = await streamLongMemEvalDataset(
      sourcePath,
      { datasetLabel: "fixture", expectedBytes: raw.length, maxQuestionCount: 1 },
      () => undefined
    );

    expect(identity.parseError?.message).toMatch(/JSON nesting limit/u);
  });

  it("does not follow a dataset symlink", async () => {
    const raw = Buffer.from(JSON.stringify([questionFixture("fixture")]), "utf8");
    const targetPath = await writeFixture(raw);
    const linkPath = `${targetPath}.link`;
    await symlink(targetPath, linkPath);

    await expect(streamLongMemEvalDataset(
      linkPath,
      { datasetLabel: "fixture", expectedBytes: raw.length, maxQuestionCount: 1 },
      () => undefined
    )).rejects.toThrow();
  });
});

async function writeFixture(raw: Uint8Array): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "alaya-stream-dataset-"));
  roots.push(root);
  const sourcePath = join(root, "dataset.json");
  await writeFile(sourcePath, raw);
  return sourcePath;
}

function questionFixture(content: string) {
  return {
    question_id: "fixture-stream",
    question_type: "single_session",
    question: "fixture probe",
    answer: "fixture answer",
    question_date: "2026-01-01",
    haystack_session_ids: ["session-a"],
    haystack_dates: ["2025-12-01"],
    haystack_sessions: [[{ role: "user", content, has_answer: true }]],
    answer_session_ids: ["session-a"]
  };
}
