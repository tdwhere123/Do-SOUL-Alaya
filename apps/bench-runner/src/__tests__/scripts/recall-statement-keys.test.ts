import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";

const saved = process.env.STATEMENT_MAP;
afterEach(() => {
  if (saved === undefined) delete process.env.STATEMENT_MAP; else process.env.STATEMENT_MAP = saved;
});

it("changes the statement map digest when a named cache file changes behind an unchanged map", async () => {
  const root = mkdtempSync(join(tmpdir(), "recall-statement-digest-"));
  try {
    const cache = join(root, "q-s0.json"), map = join(root, "session-map.jsonl");
    writeFileSync(cache, "{\"raw_json\":\"first\"}");
    writeFileSync(map, JSON.stringify({ question_id: "q", session_index: 0, cache_file: cache }) + "\n");
    process.env.STATEMENT_MAP = map;
    const script = fileURLToPath(new URL("../../../scripts/recall-statement-keys.mjs", import.meta.url));
    const { statementMapDigest } = await import(pathToFileURL(script).href);
    const before = statementMapDigest();
    expect(statementMapDigest()).toBe(before);
    writeFileSync(cache, "{\"raw_json\":\"second\"}");
    expect(statementMapDigest()).not.toBe(before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("keeps failing after a statement map file is unreadable instead of serving the partial map", async () => {
  const root = mkdtempSync(join(tmpdir(), "recall-statement-keys-"));
  try {
    const present = join(root, "q-s0.json");
    writeFileSync(present, JSON.stringify({
      raw_json: JSON.stringify({ messages: [{ message_id: "q:s0:m0", statements: [{ text: "t", relation: "r" }] }] }),
      source_statement: { request: { messages: [{ message_id: "q:s0:m0", role: "user", text: "hello" }] } }
    }));
    const map = join(root, "session-map.jsonl");
    writeFileSync(map, [
      { question_id: "q", session_index: 0, cache_file: present },
      { question_id: "q", session_index: 1, cache_file: join(root, "missing.json") }
    ].map(row => JSON.stringify(row)).join("\n") + "\n");
    process.env.STATEMENT_MAP = map;
    const script = fileURLToPath(new URL("../../../scripts/recall-statement-keys.mjs", import.meta.url));
    const { publishStatementKeys } = await import(pathToFileURL(script).href);
    const input = { snapshot: join(root, "absent.sqlite"), workspace: "w", question: { question_id: "q" },
      publication: { sources: [] } };
    await expect(publishStatementKeys(input)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(publishStatementKeys(input)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
