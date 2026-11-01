import { describe, expect, it, vi } from "vitest";
import { OfficialApiGardenProvider } from "../../../garden/ingestion/compute-provider.js";
import { SignalExtractorError, type SignalExtractor } from "../../../garden/extraction/pi-mono-extractor.js";
import { SOURCE_STATEMENTS_CONTRACT, type SourceStatementReceipt, type SourceStatementRequest } from "@do-soul/alaya-protocol";
import { extractSourceStatementRequest, planSourceStatementSession,
  type SourceStatementSessionEvent } from "../../../garden/ingestion/source-statements.js";
import { emitSourceStatementSessionSignals } from "../../../garden/ingestion/source-statement-signals.js";
import { createContext } from "./compute-provider-fixtures.js";

const context = () => ({ ...createContext(), source_root_id: "captured-root" });

describe("official statement session observation", () => {
  it("records malformed reception as failed, not a valid empty completion", async () => {
    const events: SourceStatementSessionEvent[] = [];
    const provider = new OfficialApiGardenProvider({ apiKey: "fixture",
      extractor: { extract: vi.fn(async () => ({ rawJson: '{"not_messages":[]}' })) },
      recordSession: event => { events.push(event); } });
    await expect(provider.compile("Call me Ash.", context())).rejects.toMatchObject({
      name: "OfficialApiGardenCompileIncompleteError", kind: "invalid_response", signals: [],
      receipt: { status: "failed", messages: [{ rejections: [{ reason: "malformed_response" }] }] }
    });
    expect(events).toMatchObject([{ kind: "started", planned_requests: 1, request_ceiling: 1 },
      { kind: "settled", receipt: { status: "failed" } }]);
  });

  it.each(["invalid_json", "transport_failure", "timeout"] as const)("retains the %s cause and failed receipt without retry", async kind => {
    const events: SourceStatementSessionEvent[] = [];
    const cause = new SignalExtractorError(kind, "recorded transport failure", { retryCount: 0 });
    const extract = vi.fn(async () => { throw cause; });
    const provider = new OfficialApiGardenProvider({ apiKey: "fixture", extractor: { extract },
      recordSession: event => { events.push(event); } });
    await expect(provider.compile("Call me Ash.", context())).rejects.toMatchObject({
      name: "OfficialApiGardenCompileIncompleteError", cause, signals: [], receipt: { status: "failed" }
    });
    expect(extract).toHaveBeenCalledOnce();
    expect(events).toMatchObject([{ kind: "started" }, { kind: "settled", receipt: { status: "failed" } }]);
  });

  it("aborts a hanging extractor through the wall-clock guard and settles its failed receipt", async () => {
    const extract = vi.fn<SignalExtractor["extract"]>(input => new Promise((_, reject) => {
      if (input.abortSignal?.aborted) { reject(new Error("aborted")); return; }
      input.abortSignal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }));
    const events: SourceStatementSessionEvent[] = [];
    const provider = new OfficialApiGardenProvider({ apiKey: "fixture", extractor: { extract },
      requestTimeoutMs: 10000, wallClockBudgetMs: 100, recordSession: event => { events.push(event); } });
    await expect(provider.compile("Call me Ash.", context())).rejects.toMatchObject({
      name: "OfficialApiGardenCompileIncompleteError", receipt: { status: "failed" }
    });
    expect(extract).toHaveBeenCalledOnce();
    expect(extract.mock.calls[0]![0].abortSignal?.aborted).toBe(true);
    expect(events.at(-1)).toMatchObject({ kind: "settled", receipt: { status: "failed" } });
  });

  it("captures nested source-date authority before an observation callback mutates caller messages", async () => {
    const sourceTime = { raw: "2026/09/14", normalized: "2026-09-14T00:00:00.000Z", level: "session" as const,
      provenance: "recorded-host", precision: "day" as const, timezone: "unspecified" as const,
      normalization: "utc_coordinate_not_event_time" as const };
    const input = { ...context(), turn_messages: [{ message_id: "dated-message", role: "user" as const,
      content: "I travelled yesterday.", source_time: sourceTime }] };
    const provider = new OfficialApiGardenProvider({ apiKey: "fixture", recordSession: event => {
      if (event.kind === "started") { sourceTime.raw = "2099/01/01"; sourceTime.normalized = "2099-01-01T00:00:00.000Z"; }
    }, extractor: { extract: async request => {
      expect(JSON.parse(request.userPrompt).messages[0]).toMatchObject({ recorded_at: "2026-09-14T00:00:00.000Z",
        recorded_time: { raw: "2026/09/14", precision: "day", timezone: "unspecified" } });
      return { rawJson: JSON.stringify({ messages: [{ message_id: "dated-message",
        statements: [{ text: "The user travelled yesterday.", relation: "travel" }] }] }) };
    } } });
    const [signal] = await provider.compile("I travelled yesterday.", input);
    expect(signal?.raw_payload).toMatchObject({ source_statement: { message: { recorded_at: "2026-09-14T00:00:00.000Z",
      recorded_time: { raw: "2026/09/14", level: "session" } } } });
  });
});

describe("statement session emission across admitted roots", () => {
  const messages = Array.from({ length: 65 }, (_, index) => ({ message_id: `m${index}`,
    role: "user", recorded_at: null, text: `Recorded event ${index}.` }));
  const roots = messages.map((_, index) => ({ root_id: `sha256:${index.toString(16).padStart(64, "0")}`,
    source_id: `raw-message-${index}`, source_version: "1", content_digest: `sha256:${"a".repeat(64)}` }));
  const located = messages.map((message, index) => ({ message, root: roots[index]!,
    utf8_span: [6, 6 + Buffer.byteLength(message.text)] as const }));
  const requests = planSourceStatementSession("session", messages).flatMap(chunk => "request" in chunk ? [chunk.request] : []);
  const receipt = (ids: readonly string[]): SourceStatementReceipt => ({ contract: SOURCE_STATEMENTS_CONTRACT,
    session_id: "session", status: "complete", rejections: [], chunks: [],
    messages: messages.filter(message => ids.includes(message.message_id)).map(message => ({ message, status: "complete",
      rejections: [], statements: [{ text: `The user recorded ${message.message_id}.`, relation: "event" }] })) });
  const emit = (ids: readonly string[], input: Pick<Parameters<typeof emitSourceStatementSessionSignals>[0], "requests" | "located">
    = { requests, located }) => emitSourceStatementSessionSignals({
    receipt: receipt(ids), ...input, workspaceId: "workspace-1", runId: "run-1", surfaceId: null,
    createdAt: "2026-09-14T00:00:00.000Z", sourceObservation: null, generateSignalId: () => "signal" });

  it("binds each statement to its own root with only that request's other roots as context", () => {
    const [first, last] = emit(["m0", "m64"]).map(signal => signal.raw_payload.source_statement);
    expect(first).toMatchObject({ source_root_id: roots[0]!.root_id, artifact_key: "raw-message-0",
      source_corpus_digest: "a".repeat(64), source_span: [6, 6 + Buffer.byteLength("Recorded event 0.")] });
    expect(first!.source_context.map(source => source.root_id)).toEqual(roots.slice(1, 64).map(root => root.root_id));
    expect(first!.source_context[0]).toEqual({ workspace_id: "workspace-1", root_id: roots[1]!.root_id,
      source_id: "raw-message-1", source_version: "1", content_digest: `sha256:${"a".repeat(64)}` });
    expect(last!.source_context.map(source => source.root_id)).toEqual(roots.slice(0, 64).map(root => root.root_id));
  });

  it("refuses statements outside the planned requests or without their host location", () => {
    expect(() => emit(["m64"], { requests: requests.slice(0, 1), located })).toThrow("outside its planned request");
    expect(() => emit(["m3"], { requests, located: located.filter(row => row.message.message_id !== "m63") }))
      .toThrow("host binding changed");
    const unversioned = located.map(({ root: { source_version: _version, ...root }, ...row }) => ({ ...row, root }));
    expect(() => emit(["m0"], { requests, located: unversioned })).toThrow();
  });

  it("settles one planned request without dispatching any other chunk", async () => {
    const transport = vi.fn(async ({ userPrompt }: { userPrompt: string }) => ({ rawJson: JSON.stringify({
      messages: (JSON.parse(userPrompt) as SourceStatementRequest).messages.map(row => ({ message_id: row.message_id,
        statements: [{ text: `The user recorded ${row.message_id}.`, relation: "event" }] })) }) }));
    const settled = await extractSourceStatementRequest({ request: requests[1]!, transport });
    expect(transport).toHaveBeenCalledOnce();
    expect(JSON.parse(transport.mock.calls[0]![0].userPrompt)).toEqual(requests[1]);
    expect(settled).toMatchObject({ transportFailed: false, receipt: { session_id: "session", status: "complete",
      chunks: [{ chunk_index: 1, status: "complete" }], messages: [{ message: { message_id: "m64" } }] } });
    const failed = await extractSourceStatementRequest({ request: requests[0]!,
      transport: async () => { throw new Error("recorded transport failure"); } });
    expect(failed).toMatchObject({ transportFailed: true, receipt: { status: "failed" } });
  });
});
