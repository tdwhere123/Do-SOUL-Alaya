import { describe, expect, it, vi } from "vitest";
import {
  findProviderBinding,
  requireProviderBinding,
  resolveVendorModel
} from "../../../bench/provider/catalog.js";
import { probeProviderProtocol } from "../../../bench/provider/protocol-probe.js";
import { assertRequiredRequestProfile } from
  "../../../bench/extraction/transport-route.js";

const MIMO = requireProviderBinding("mimo-v2.5");

describe("provider catalog", () => {
  it("remaps vendor aliases through the binding table", () => {
    expect(resolveVendorModel("Mimo-V2.5")).toBe(MIMO.id);
    expect(resolveVendorModel("mimo-v2-flash")).toBe(MIMO.id);
    expect(findProviderBinding("unknown-model")).toBeUndefined();
  });

  it("refuses a bound vendor with the wrong request profile", () => {
    expect(() => assertRequiredRequestProfile({
      model: "Mimo-V2.5",
      requestProfile: "provider-default-v1"
    })).toThrow(/requires request profile mimo-v2.5-nonthinking-v1/u);
    expect(() => assertRequiredRequestProfile({
      model: MIMO.id,
      requestProfile: MIMO.requestProfile
    })).not.toThrow();
  });
});

describe("provider protocol probe", () => {
  it("caps physical calls and confirms the sealed F3 identity", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: '{"ok":true}' }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
    }), { status: 200 }));
    const receipt = await probeProviderProtocol({
      providerUrl: "https://proxy.example/v1", apiKey: "sk-test",
      model: MIMO.id, fetchImpl: fetchImpl as unknown as typeof fetch
    });
    expect(receipt).toMatchObject({
      physical_calls: 1, profile: MIMO.requestProfile,
      model: MIMO.id, usage_present: true, f3_seal_current: true
    });
    expect(receipt.physical_calls).toBeLessThanOrEqual(MIMO.probeCallCeiling);
    const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));
    expect(body).toMatchObject({ model: MIMO.id, enable_thinking: false });
    expect(body.stream).toBeUndefined();
  });

  it("requests SSE framing for the stream probe", async () => {
    const fetchImpl = vi.fn(async () => new Response(
      "data: {\"choices\":[{\"delta\":{\"content\":\"{\\\"ok\\\":true}\" }}]}\n\n" +
      "data: {\"usage\":{\"prompt_tokens\":1,\"completion_tokens\":1,\"total_tokens\":2}}\n\n" +
      "data: [DONE]\n",
      { status: 200, headers: { "content-type": "text/event-stream" } }
    ));
    const receipt = await probeProviderProtocol({
      providerUrl: "https://proxy.example/v1", apiKey: "sk-test",
      model: MIMO.id, framing: "sse",
      fetchImpl: fetchImpl as unknown as typeof fetch
    });
    expect(receipt).toMatchObject({ framing: "sse", physical_calls: 1, json_object: true });
    const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));
    expect(body).toMatchObject({ stream: true, model: MIMO.id });
  });

  it("refuses an empty key", async () => {
    await expect(probeProviderProtocol({
      providerUrl: "https://proxy.example/v1", apiKey: "",
      model: MIMO.id, fetchImpl: fetch
    })).rejects.toThrow(/empty API key/u);
  });
});
