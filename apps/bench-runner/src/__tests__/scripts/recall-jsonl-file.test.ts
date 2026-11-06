import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

const { readRecallJsonlFile } = await import(new URL("../../../scripts/recall-jsonl-file.mjs", import.meta.url).href);

it("decodes split UTF-8 and multi-chunk records while hashing exact bytes, including CRLF and an unterminated final record", () => {
  const dir = mkdtempSync(join(tmpdir(), "recall-jsonl-bytes-"));
  try {
    const path = join(dir, "rows.jsonl");
    // The first byte of the three-byte character is the last byte of the first read.
    const first = { text: "x".repeat(65526) + "界🙂", observation: "y".repeat(140000) };
    const last = { text: "终", retained: { unknown: null, empty: [] } };
    const bytes = Buffer.from(JSON.stringify(first) + "\r\n\n \t\r\n" + JSON.stringify(last));
    expect(bytes.indexOf(Buffer.from("界"))).toBe(65535);
    writeFileSync(path, bytes);
    const parsed = readRecallJsonlFile(path, { skipWhitespace: true });
    expect(parsed.rows).toEqual([first, last]);
    expect(parsed.bytes).toBe(bytes.length);
    expect(parsed.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    // Scorer historically skips empty lines only; do not broaden its accepted grammar.
    expect(() => readRecallJsonlFile(path)).toThrow(SyntaxError);
    writeFileSync(path, JSON.stringify(first) + "\n\n" + JSON.stringify(last));
    expect(readRecallJsonlFile(path).rows).toEqual([first, last]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it("rejects late malformed and truncated records, missing files, and returns valid empty only for empty input", () => {
  const dir = mkdtempSync(join(tmpdir(), "recall-jsonl-errors-"));
  try {
    const path = join(dir, "rows.jsonl");
    const prefix = JSON.stringify({ retained: "x".repeat(140000) }) + "\n";
    for (const suffix of ["not json\n", '{"truncated":', '{"truncated":"界']) {
      writeFileSync(path, prefix + suffix);
      expect(() => readRecallJsonlFile(path)).toThrow(SyntaxError);
    }
    rmSync(path);
    expect(() => readRecallJsonlFile(path)).toThrow(/ENOENT/u);
    writeFileSync(path, "");
    expect(readRecallJsonlFile(path)).toEqual({ rows: [], bytes: 0,
      sha256: createHash("sha256").update("").digest("hex") });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
