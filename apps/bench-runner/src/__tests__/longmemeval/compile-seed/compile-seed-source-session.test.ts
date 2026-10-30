import { describe, expect, it } from "vitest";
import type { SourceStatementContextSource } from "@do-soul/alaya-protocol";
import { statementRequestSourceContexts } from "../../../runs/compile-seed/compile-seed-source-session.js";

const messages = Array.from({ length: 65 }, (_, index) => ({ message_id: `m${index}`,
  role: "user" as const, content: `Recorded event ${index}.` }));
const roots: SourceStatementContextSource[] = messages.map((_, index) => ({ workspace_id: "recorded-workspace",
  root_id: `sha256:${index.toString(16).padStart(64, "0")}`, source_id: `raw-message-${index}`,
  source_version: "1", content_digest: `sha256:${"a".repeat(64)}` }));
const captured = { partition: "recorded raw partition", observedAt: "2026-09-14T00:00:00.000Z",
  bySeed: new Map(roots.map((root, index) => [index, root])),
  byMessage: new Map(roots.map((root, index) => [messages[index]!.message_id, root])) };

describe("model-visible raw source dependencies", () => {
  it("includes later targets in the same request but not an unseen future chunk", () => {
    const contexts = statementRequestSourceContexts(messages, captured);
    expect(contexts.get("m0")!.map(source => source.root_id)).toEqual(roots.slice(1, 64).map(source => source.root_id));
    expect(contexts.get("m0")!.some(source => source.root_id === roots[64]!.root_id)).toBe(false);
    expect(contexts.get("m64")!.map(source => source.root_id)).toEqual(roots.slice(0, 64).map(source => source.root_id));
  });

  it("refuses a model-visible message that lacks its captured raw coordinate", () => {
    const byMessage = new Map(captured.byMessage); byMessage.delete("m63");
    expect(() => statementRequestSourceContexts(messages, { ...captured, byMessage })).toThrow("no captured raw root");
  });
});
