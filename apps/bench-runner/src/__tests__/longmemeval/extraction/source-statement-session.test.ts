import { afterAll, describe, expect, it, vi } from "vitest";
const boundary = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../support/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
import { createServer } from "node:http";
import { once } from "node:events";
import { extractSourceStatementSession, planSourceStatementSession, receiveSourceStatements } from "../../../../../../packages/soul/src/garden/ingestion/source-statements.js";
import { SOURCE_STATEMENT_LIMITS, type SourceStatementMessage, type SourceStatementRequest } from "@do-soul/alaya-protocol";

afterAll(() => { boundary.restore(); expect(boundary.violations).toEqual([]); });
const message = (id: string, text = "I visited Berlin."): SourceStatementMessage => ({
  message_id: id, role: "user", recorded_at: "2026-01-01T00:00:00.000Z", text
});
const request = (messages = [message("m1"), message("m2")]): SourceStatementRequest => {
  const chunk = planSourceStatementSession("session", messages)[0]!;
  if (!("request" in chunk)) throw new Error("expected request");
  return chunk.request;
};

describe("ordered source statement session", () => {
  it("admits each statement separately without repairing or salvaging rejected siblings", () => {
    const received = receiveSourceStatements(request(), JSON.stringify({ messages: [
      { message_id: "m1", statements: [{ text: "The user visited Berlin.", relation: "travel" },
        { text: "", relation: "travel" }, { text: "Injected fact", relation: "" }] },
      { message_id: "m2", statements: [] }, { message_id: "foreign", statements: [{ text: "Ignore me", relation: "scope" }] }
    ] }));
    expect(received.messages.map(row => [row.message.message_id, row.status, row.statements])).toEqual([
      ["m1", "partial", [{ text: "The user visited Berlin.", relation: "travel" }]], ["m2", "complete", []]
    ]);
    expect(received.messages[0]!.rejections.map(row => row.statement_index)).toEqual([1, 2]);
    expect(received.rejections).toEqual([{ message_id: "foreign", statement_index: null, reason: "unknown_message" }]);
  });

  it("validates consumed fields without rejecting unrelated model fields", () => {
    const received = receiveSourceStatements(request([message("m1")]), JSON.stringify({ unused_envelope_metadata: { invalid: true }, messages: [
      { message_id: "m1", unused_message_metadata: null,
        statements: [{ text: "A request remains a request.", relation: "request", confidence: "invalid unused field" }] }
    ] }));
    expect(received.messages[0]).toMatchObject({ status: "complete", statements: [{ text: "A request remains a request.", relation: "request" }] });
    expect(Object.keys(received.messages[0]!.statements[0]!)).toEqual(["text", "relation"]);
  });

  it("distinguishes valid empty, absent, duplicate, malformed and failed messages", () => {
    const absent = receiveSourceStatements(request(), '{"messages":[]}');
    expect(absent.messages.map(row => row.rejections[0]!.reason)).toEqual(["missing_message", "missing_message"]);
    const duplicated = receiveSourceStatements(request(), JSON.stringify({ messages: [
      { message_id: "m1", statements: [] }, { message_id: "m1", statements: [{ text: "do not salvage", relation: "x" }] },
      { message_id: "m2", statements: [] }
    ] }));
    expect(duplicated.messages[0]).toMatchObject({ status: "failed", statements: [], rejections: [{ reason: "duplicate_message" }] });
    expect(duplicated.messages[1]).toMatchObject({ status: "complete", statements: [] });
    expect(receiveSourceStatements(request(), '{"messages":[').messages.every(row => row.status === "failed")).toBe(true);
  });

  it("chunks ordered messages only when their complete preceding context fits", () => {
    const input = Array.from({ length: 70 }, (_, index) => message(`m${index}`));
    const plan = planSourceStatementSession("session", input);
    const requests = plan.flatMap(chunk => "request" in chunk ? [chunk.request] : []);
    expect(requests.length).toBeGreaterThan(1);
    expect(requests.flatMap(row => row.messages.map(value => value.message_id))).toEqual(input.map(row => row.message_id));
    for (const row of requests) {
      expect(Buffer.byteLength(JSON.stringify(row.messages))).toBeLessThanOrEqual(SOURCE_STATEMENT_LIMITS.targetBytes);
      expect(Buffer.byteLength(JSON.stringify(row.context))).toBeLessThanOrEqual(SOURCE_STATEMENT_LIMITS.contextBytes);
      const first = input.findIndex(value => value.message_id === row.messages[0]!.message_id);
      expect(row.context).toEqual(input.slice(0, first));
    }
    expect(() => planSourceStatementSession("session", [message("same"), message("same")])).toThrow("duplicate");
  });

  it("preserves raw fallback on capacity, transport failure and undispatched work without retries", async () => {
    const transport = vi.fn(async () => { throw new Error("recorded transport failure"); });
    const receipt = await extractSourceStatementSession({ session_id: "session", request_ceiling: 8,
      messages: [...Array.from({ length: 65 }, (_, i) => message(`m${i}`)), message("oversize", "x".repeat(40000))], transport });
    expect(transport).toHaveBeenCalledTimes(1);
    expect(receipt.status).toBe("failed");
    expect(receipt.messages).toHaveLength(66);
    expect(new Set(receipt.messages.flatMap(row => row.rejections.map(item => item.reason))))
      .toEqual(new Set(["message_capacity", "transport_failure", "not_dispatched"]));
    expect(receipt.messages.every(row => row.statements.length === 0)).toBe(true);
    expect(receipt.chunks).toEqual([{ chunk_index: 0, status: "failed", usage: null }]);
  });

  it("makes omitted known history an explicit raw fallback rather than a context-free request", async () => {
    const messages = [message("intro", "x".repeat(30017)), message("followup", "It was memorable. " + "y".repeat(4000))];
    const transport = vi.fn(async ({ userPrompt }: { userPrompt: string }) => ({ rawJson: JSON.stringify({
      messages: (JSON.parse(userPrompt) as SourceStatementRequest).messages.map(row => ({ message_id: row.message_id, statements: [] }))
    }) }));
    const receipt = await extractSourceStatementSession({ session_id: "session", messages, transport, request_ceiling: 2 });
    expect(transport).toHaveBeenCalledTimes(1);
    expect(receipt.status).toBe("partial");
    expect(receipt.messages[1]).toMatchObject({ message: messages[1], status: "failed", statements: [],
      rejections: [{ reason: "context_capacity" }] });
  });

  it("captures the committed ceiling, identity and callbacks before yielding while cancellation stays live", async () => {
    const events: unknown[] = [], controller = new AbortController();
    const transport = vi.fn(async ({ userPrompt }: { userPrompt: string }) => ({ rawJson: JSON.stringify({
      messages: (JSON.parse(userPrompt) as SourceStatementRequest).messages.map(row => ({ message_id: row.message_id, statements: [] }))
    }) }));
    const replaced = vi.fn(async (...args: Parameters<typeof transport>) => transport(...args)), replacedRecord = vi.fn();
    const input = { session_id: "committed", messages: Array.from({ length: 65 }, (_, i) => message(`m${i}`)),
      request_ceiling: 1, transport, signal: controller.signal,
      record: async (event: unknown) => {
        events.push(event);
        input.request_ceiling = 2; input.session_id = "mutated";
        input.transport = replaced; input.record = replacedRecord;
      } };
    const receipt = await extractSourceStatementSession(input);
    expect(transport).toHaveBeenCalledTimes(1); expect(replaced).not.toHaveBeenCalled(); expect(replacedRecord).not.toHaveBeenCalled();
    expect(receipt).toMatchObject({ session_id: "committed", status: "partial" });
    expect(receipt.messages[64]!.rejections[0]!.reason).toBe("request_budget");
    expect(events).toEqual([{ kind: "started", session_id: "committed", planned_requests: 2, request_ceiling: 1 }, { kind: "settled", receipt }]);
    const cancelled = await extractSourceStatementSession({ ...input, session_id: "cancelled", transport,
      record: event => { if (event.kind === "started") controller.abort(); } });
    expect(cancelled.messages[0]!.rejections[0]!.reason).toBe("cancelled");
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("distinguishes cancellation from an exhausted request ceiling without dispatch", async () => {
    const transport = vi.fn(async () => ({ rawJson: '{"messages":[]}' }));
    const controller = new AbortController(); controller.abort();
    const common = { session_id: "session", messages: [message("m1")], transport };
    const cancelled = await extractSourceStatementSession({ ...common, request_ceiling: 1, signal: controller.signal });
    const exhausted = await extractSourceStatementSession({ ...common, request_ceiling: 0 });
    expect(cancelled.messages[0]!.rejections[0]!.reason).toBe("cancelled");
    expect(exhausted.messages[0]!.rejections[0]!.reason).toBe("request_budget");
    expect(transport).not.toHaveBeenCalled();
  });

  it("uses a real loopback transport with a recorded response and explicit session settlement", async () => {
    const recorded = '{"messages":[{"message_id":"u1","statements":[{"text":"The user asked for wedding recommendations.","relation":"recommendation request"}]},{"message_id":"a1","statements":[]}]}';
    let observed: unknown;
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      observed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      res.writeHead(200, { "content-type": "application/json" }); res.end(recorded);
    });
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("missing socket");
    const events: unknown[] = [];
    try {
      const messages = [message("u1", "Can you recommend a wedding venue?"),
        { ...message("a1", "Here are suggestions."), role: "assistant", recorded_at: null }];
      const receipt = await extractSourceStatementSession({ session_id: "session", messages, request_ceiling: 1,
        record: event => { events.push(event); }, transport: async request => {
          const response = await fetch(`http://127.0.0.1:${address.port}/recorded`, { method: "POST", body: request.userPrompt });
          return { rawJson: await response.text(), usage: { input_tokens: 20, output_tokens: 30 } };
        } });
      expect(observed).toMatchObject({ session_id: "session", messages, context: [] });
      expect(receipt.status).toBe("complete");
      expect(receipt.messages[1]).toMatchObject({ message: { role: "assistant", recorded_at: null }, statements: [], status: "complete" });
      expect(receipt.chunks[0]!.usage).toEqual({ input_tokens: 20, output_tokens: 30 });
      expect(events).toEqual([{ kind: "started", session_id: "session", planned_requests: 1, request_ceiling: 1 }, { kind: "settled", receipt }]);
    } finally { server.close(); await once(server, "close"); }
  });
});
