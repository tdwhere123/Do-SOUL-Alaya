import { constants as bufferConstants } from "node:buffer";
import { createWriteStream } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { describe, expect, it } from "vitest";

// @ts-expect-error The replay reader is a runtime JavaScript module.
import { DiagnosticsJsonStreamReader, readDiagnosticsJsonStream } from "../../../../scripts/longmemeval-replay/diagnostics-json-stream-reader.mjs";

describe("streaming diagnostics JSON reader", () => {
  it("parses gzip JSON whose logical size exceeds the V8 string limit", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "alaya-replay-stream-"));
    const artifactPath = path.join(root, "diagnostics.json.gz");
    const payload = "a".repeat(1024 * 1024);
    const rendered = JSON.stringify({ payload });
    const count = Math.ceil((bufferConstants.MAX_STRING_LENGTH + 1) / (rendered.length + 1));
    const logicalBytes = await writeLargeDiagnostics(artifactPath, rendered, count);
    let parsed = 0;

    const diagnostics = await readDiagnosticsJsonStream(artifactPath, {
      gzip: true,
      collectQuestions: false,
      onQuestion: () => { parsed += 1; }
    });

    expect(logicalBytes).toBeGreaterThan(bufferConstants.MAX_STRING_LENGTH);
    expect(parsed).toBe(count);
    expect(diagnostics).toMatchObject({ schema_version: 1, questions: [] });
  }, 120_000);

  it("preserves escaped unicode and nested question values across chunks", () => {
    const reader = new DiagnosticsJsonStreamReader();
    const document = JSON.stringify({
      schema_version: 1,
      label: "meta 🌱",
      questions: [{ text: "quote: \\\" slash: \\\\ 🚀", nested: { rows: [[1], { ok: true }] } }],
      summary: { status: "ok" }
    });
    for (let offset = 0; offset < document.length; offset += 3) {
      reader.consume(document.slice(offset, offset + 3));
    }
    expect(reader.finish()).toEqual(JSON.parse(document));
  });

  it("consumes legacy plain JSON questions without retaining them", () => {
    const seen: string[] = [];
    const reader = new DiagnosticsJsonStreamReader({
      collectQuestions: false,
      onQuestion: (question: { question_id: string }) => seen.push(question.question_id)
    });
    reader.consume(JSON.stringify({
      schema_version: 1,
      questions: Array.from({ length: 500 }, (_, index) => ({
        question_id: `q-${index}`,
        candidates: [{ payload: "x".repeat(1024) }]
      }))
    }));

    expect(reader.finish()).toMatchObject({ schema_version: 1, questions: [] });
    expect(seen).toHaveLength(500);
  });

  it.each([
    ["truncated", '{"schema_version":1,"questions":[{"id":"q1"}'],
    ["trailing", '{"schema_version":1,"questions":[]} false']
  ])("rejects %s JSON", (_label, document) => {
    const reader = new DiagnosticsJsonStreamReader();
    expect(() => {
      reader.consume(document);
      reader.finish();
    }).toThrow(/truncated|trailing/u);
  });

  it("rejects a diagnostics schema mismatch", () => {
    const reader = new DiagnosticsJsonStreamReader();
    reader.consume('{"schema_version":2,"questions":[]}');
    expect(() => reader.finish()).toThrow(/schema_version/u);
  });

  it("reports invalid UTF-8 instead of replacing bytes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "alaya-replay-utf8-"));
    const artifactPath = path.join(root, "diagnostics.json");
    await writeFile(artifactPath, Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xc3, 0x28]));
    await expect(readDiagnosticsJsonStream(artifactPath)).rejects.toThrow(/UTF-8/u);
  });
});

async function writeLargeDiagnostics(artifactPath: string, question: string, count: number) {
  let logicalBytes = 0;
  function* chunks() {
    const prefix = '{"schema_version":1,"questions":[';
    logicalBytes += Buffer.byteLength(prefix);
    yield prefix;
    for (let index = 0; index < count; index += 1) {
      const chunk = `${index === 0 ? "" : ","}${question}`;
      logicalBytes += Buffer.byteLength(chunk);
      yield chunk;
    }
    logicalBytes += 2;
    yield "]}";
  }
  await pipeline(Readable.from(chunks()), createGzip(), createWriteStream(artifactPath));
  return logicalBytes;
}
