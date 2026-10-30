import { BoundedJsonObjectSchema } from "@do-soul/alaya-protocol";
import { describe, expect, it } from "vitest";
import { OfficialApiGardenProvider } from "../../../garden/ingestion/compute-provider.js";
import { sourceStatementSessionInput } from "../../../garden/ingestion/source-statement-signals.js";
import { createContext, createExtractor } from "./compute-provider-fixtures.js";

describe("bounded statement source binding", () => {
  it("binds a small statement to a large rendered source without copying the full source into its signal", async () => {
    const assertion = "I use the cobalt release channel for production deployments.";
    const messages = [
      { message_id: "user-long-source", role: "user" as const, content: assertion, created_at: "2026-08-09T00:00:00.000Z" },
      { message_id: "assistant-long-source", role: "assistant" as const, content: "Background diagnostics. ".repeat(900),
        created_at: "2026-08-09T00:00:01.000Z" }
    ];
    const source = sourceStatementSessionInput(messages);
    expect(source.rendered.content.length).toBeGreaterThan(16_384);
    const provider = new OfficialApiGardenProvider({ apiKey: "fixture", extractor: createExtractor(JSON.stringify({ messages: [
      { message_id: "user-long-source", statements: [{ text: assertion, relation: "deployment channel" }] },
      { message_id: "assistant-long-source", statements: [] }
    ] })), generateSignalId: () => "signal-long-source" });
    const [signal] = await provider.compile(assertion, { ...createContext(), turn_messages: messages, source_root_id: "root-long-source" });
    expect(signal?.interpretation_contract).toBe("source-statements-v1");
    expect(signal?.object_kind).toBeNull();
    expect(signal?.confidence).toBeNull();
    expect(signal?.raw_payload).toMatchObject({ source_statement: { source_root_id: "root-long-source",
      message: { message_id: "user-long-source", text: assertion }, statement: { text: assertion, relation: "deployment channel" } } });
    expect(BoundedJsonObjectSchema.safeParse(signal?.raw_payload).success).toBe(true);
    expect(JSON.stringify(signal?.raw_payload)).not.toContain("Background diagnostics.");
  });
});
