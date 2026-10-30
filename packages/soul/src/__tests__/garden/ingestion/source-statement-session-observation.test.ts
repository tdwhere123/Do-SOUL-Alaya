import { describe, expect, it, vi } from "vitest";
import { OfficialApiGardenProvider } from "../../../garden/ingestion/compute-provider.js";
import { SignalExtractorError, type SignalExtractor } from "../../../garden/extraction/pi-mono-extractor.js";
import type { SourceStatementSessionEvent } from "../../../garden/ingestion/source-statements.js";
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
