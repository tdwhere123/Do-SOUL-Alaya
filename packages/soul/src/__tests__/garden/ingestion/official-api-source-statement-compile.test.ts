import { afterAll, describe, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../../../../../apps/bench-runner/src/__tests__/support/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
afterAll(() => { isolation.restore(); expect(isolation.violations).toEqual([]); });
import { SOURCE_STATEMENTS_CONTRACT } from "@do-soul/alaya-protocol";
import { createPiMonoExtractor } from "../../../garden/extraction/pi-mono-extractor.js";
import { OfficialApiGardenProvider } from "../../../garden/ingestion/compute-provider.js";
import { createContext, createExtractor } from "./compute-provider-fixtures.js";

const turn = "Alice uses tools.";
const context = () => ({ ...createContext(), source_root_id: "root-1",
  turn_messages: [{ role: "user" as const, content: turn, message_id: "user-1" }] });
const envelope = (statements: readonly unknown[] = [{ text: turn, relation: "tool usage" }]) =>
  JSON.stringify({ messages: [{ message_id: "user-1", statements }] });

describe("request-bound source statement compilation", () => {
  it("extracts a receipt without publication authority but refuses durable signals without a captured root", async () => {
    const input = context(), extractor = createExtractor(envelope());
    const provider = new OfficialApiGardenProvider({ apiKey: "test", extractor });
    const { artifact_key: _artifact, source_root_id: _root, ...unbound } = input;
    await expect(provider.extractSourceStatements(turn, unbound)).resolves.toMatchObject({ status: "complete" });
    expect(extractor.extract).toHaveBeenCalledOnce();
    await expect(provider.compile(turn, unbound)).rejects.toMatchObject({ kind: "invalid_response" });
    expect(extractor.extract).toHaveBeenCalledOnce();
  });

  it.each([
    { rawJson: '{"interpretations":[]}', reason: "malformed_response" },
    { rawJson: '{"messages":[]}', reason: "missing_message" },
    { rawJson: envelope([{ text: "", relation: "invalid" }]), reason: "invalid_statement" }
  ])("keeps $reason as incomplete reception without repair, retry, or a fabricated empty", async ({ rawJson, reason }) => {
    const complete = vi.fn(async () => ({ content: [{ type: "text", text: rawJson }] }));
    const provider = new OfficialApiGardenProvider({ apiKey: "test", diagnosticDir: null,
      extractor: createPiMonoExtractor({ apiKey: "test", model: "model", complete }) });
    await expect(provider.compile(turn, context())).rejects.toMatchObject({
      name: "OfficialApiGardenCompileIncompleteError", signals: [],
      receipt: { messages: [{ rejections: [expect.objectContaining({ reason })] }] }
    });
    expect(complete).toHaveBeenCalledOnce();
  });

  it("retains the transport cause and failed receipt without retrying a completion-port failure", async () => {
    const failure = new Error("connection failed"), complete = vi.fn(async () => { throw failure; });
    const provider = new OfficialApiGardenProvider({ apiKey: "test", diagnosticDir: null,
      extractor: createPiMonoExtractor({ apiKey: "test", model: "model", complete }) });
    await expect(provider.compile(turn, context())).rejects.toMatchObject({
      name: "OfficialApiGardenCompileIncompleteError", signals: [], receipt: { status: "failed" },
      cause: { name: "SignalExtractorError", kind: "transport_failure", cause: failure }
    });
    expect(complete).toHaveBeenCalledOnce();
  });

  it("emits the minimal observation without kind/confidence routing or temporal invention", async () => {
    const provider = new OfficialApiGardenProvider({ apiKey: "test", extractor: createExtractor(envelope()),
      generateSignalId: () => "statement-signal" });
    const [signal] = await provider.compile(turn, context());
    expect(signal).toMatchObject({ signal_id: "statement-signal", source: "garden_compile",
      interpretation_contract: SOURCE_STATEMENTS_CONTRACT, object_kind: null, confidence: null,
      raw_payload: { source_statement: { source_root_id: "root-1", artifact_key: "artifact-1",
        message: { message_id: "user-1", recorded_at: null }, statement: { text: turn, relation: "tool usage" } } } });
    expect(signal!.raw_payload).not.toHaveProperty("temporal_projection");
    expect(signal!.raw_payload).not.toHaveProperty("matched_text");
  });

  it("keeps accepted siblings on the incomplete error and distinguishes a completed empty message", async () => {
    const provider = new OfficialApiGardenProvider({ apiKey: "test", extractor: createExtractor(envelope([
      { text: turn, relation: "tool usage" }, { text: "", relation: "invalid" }
    ])) });
    await expect(provider.compile(turn, context())).rejects.toMatchObject({
      signals: [expect.objectContaining({ interpretation_contract: SOURCE_STATEMENTS_CONTRACT })], receipt: { status: "partial" }
    });
    await expect(new OfficialApiGardenProvider({ apiKey: "test", extractor: createExtractor(envelope([])) })
      .compile(turn, context())).resolves.toEqual([]);
  });

  it("captures publication scope, host content, and the transport method before recording starts", async () => {
    const input = context(), extractor = createExtractor(envelope());
    const original = extractor.extract, replacement = vi.fn(async () => { throw new Error("mutated transport"); });
    const provider = new OfficialApiGardenProvider({ apiKey: "test", extractor, recordSession: event => {
      if (event.kind !== "started") return;
      input.source_root_id = "replacement-root"; input.artifact_key = "replacement-artifact";
      input.workspace_id = "replacement-workspace"; input.turn_messages[0]!.content = "changed";
      extractor.extract = replacement;
    } });
    const [signal] = await provider.compile(turn, input);
    expect(original).toHaveBeenCalledOnce(); expect(replacement).not.toHaveBeenCalled();
    expect(signal).toMatchObject({ workspace_id: "workspace-1", raw_payload: { source_statement: {
      source_root_id: "root-1", artifact_key: "artifact-1", message: { text: "Alice uses tools." }
    } } });
  });
});
