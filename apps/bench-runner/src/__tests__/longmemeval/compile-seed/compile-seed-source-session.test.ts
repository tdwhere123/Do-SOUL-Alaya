import { describe, expect, it } from "vitest";
import type { SourceStatementContextSource } from "@do-soul/alaya-protocol";
import { locateStatementSourceSession } from "../../../runs/compile-seed/compile-seed-source-session.js";

const messages = Array.from({ length: 65 }, (_, index) => ({ message_id: `m${index}`,
  role: "user" as const, content: `Recorded event ${index}.` }));
const roots: SourceStatementContextSource[] = messages.map((_, index) => ({ workspace_id: "recorded-workspace",
  root_id: `sha256:${index.toString(16).padStart(64, "0")}`, source_id: `raw-message-${index}`,
  source_version: "1", content_digest: `sha256:${"a".repeat(64)}` }));
const captured = { partition: "recorded raw partition", observedAt: "2026-09-14T00:00:00.000Z",
  bySeed: new Map(roots.map((root, index) => [index, root])),
  byMessage: new Map(roots.map((root, index) => [messages[index]!.message_id,
    { source: root, utf8_span: [6, 6 + Buffer.byteLength(messages[index]!.content)] as const }])) };

describe("model-visible raw source locations", () => {
  it("locates each rendered session message at its captured raw round occurrence", () => {
    const located = locateStatementSourceSession(messages, captured);
    expect(located).toHaveLength(65);
    expect(located[64]).toEqual({ root: roots[64], utf8_span: [6, 6 + Buffer.byteLength("Recorded event 64.")],
      message: { message_id: "m64", role: "user", recorded_at: null, text: "Recorded event 64." } });
  });

  it("refuses a model-visible message that lacks its captured raw coordinate", () => {
    const byMessage = new Map(captured.byMessage); byMessage.delete("m63");
    expect(() => locateStatementSourceSession(messages, { ...captured, byMessage })).toThrow("no captured raw root");
  });
});
