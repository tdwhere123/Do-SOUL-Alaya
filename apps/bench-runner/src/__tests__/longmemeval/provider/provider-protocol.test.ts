// @ts-nocheck
import { fetchLoopbackProvider } from "../../support/loopback-provider-fetch.js";
import { createServer } from "node:http";
import { MAX_RETAINED_PROVIDER_HTTP_RESPONSE_BYTES } from "@do-soul/alaya-engine-gateway";
import { describe, expect, it, vi } from "vitest";
import {
  findProviderBinding,
  requireProviderBinding,
  resolveVendorModel
} from "../../../runs/provider/catalog.js";
import { probeProviderProtocol } from "../../../runs/provider/protocol-probe.js";
import { assertRequiredRequestProfile } from
  "../../../runs/extraction/transport-route.js";

const MIMO = requireProviderBinding("mimo-v2.5");

describe("provider catalog", () => {
  it("keeps Step low as the default and binds high to the same exact model", () => {
    expect(requireProviderBinding("step-3.5-flash-2603")).toMatchObject({
      requestProfile: "step-3.5-2603-low-json-schema-v1",
      supportedRequestProfiles: ["step-3.5-2603-low-json-schema-v1", "step-3.5-2603-high-json-schema-v1"]
    });
    expect(() => assertRequiredRequestProfile({ model: "step-3.5-flash-2603",
      requestProfile: "step-3.5-2603-high-json-schema-v1" })).not.toThrow();
    expect(() => assertRequiredRequestProfile({ model: "gemini-3.1-flash-lite",
      requestProfile: "step-3.5-2603-high-json-schema-v1" })).toThrow();
  });
  it("binds the preview model to its own explicit profile", () => {
    expect(requireProviderBinding("step-5-preview")).toMatchObject({
      requestProfile: "step-5-preview-low-json-schema-v1",
      supportedRequestProfiles: ["step-5-preview-low-json-schema-v1", "step-5-preview-low-json-mode-v1"]
    });
    expect(() => assertRequiredRequestProfile({ model: "step-5-preview",
      requestProfile: "step-5-preview-low-json-schema-v1" })).not.toThrow();
    expect(() => assertRequiredRequestProfile({ model: "step-5-preview",
      requestProfile: "step-5-preview-low-json-mode-v1" })).not.toThrow();
    expect(() => assertRequiredRequestProfile({ model: "step-5-preview",
      requestProfile: "step-3.5-2603-low-json-schema-v1" })).toThrow();
    expect(() => assertRequiredRequestProfile({ model: "step-3.5-flash-2603",
      requestProfile: "step-5-preview-low-json-schema-v1" })).toThrow();
  });
  it("keeps minimal default while accepting low only for the same Flash-Lite 3.1 model", () => {
    expect(requireProviderBinding("gemini-3.1-flash-lite").requestProfile).toBe("gemini-3.1-minimal-v1");
    for (const requestProfile of ["gemini-3.1-minimal-v1", "gemini-3.1-low-v1"] as const) {
      expect(() => assertRequiredRequestProfile({ model: "gemini-3.1-flash-lite", requestProfile })).not.toThrow();
      expect(() => assertRequiredRequestProfile({ model: "gemini-2.5-flash-lite", requestProfile })).toThrow();
    }
  });
  it("binds Pro-preview 3.1 to low only and rejects minimal without changing Flash-Lite", () => {
    expect(requireProviderBinding("gemini-3.1-pro-preview")).toMatchObject({
      id: "gemini-3.1-pro-preview",
      aliases: [],
      requestProfile: "gemini-3.1-low-v1",
      supportedRequestProfiles: ["gemini-3.1-low-v1"],
      probeCallCeiling: 2
    });
    expect(() => assertRequiredRequestProfile({
      model: "gemini-3.1-pro-preview", requestProfile: "gemini-3.1-low-v1"
    })).not.toThrow();
    expect(() => assertRequiredRequestProfile({
      model: "gemini-3.1-pro-preview", requestProfile: "gemini-3.1-minimal-v1"
    })).toThrow(/requires request profile gemini-3.1-low-v1/u);
    expect(requireProviderBinding("gemini-3.1-flash-lite")).toMatchObject({
      requestProfile: "gemini-3.1-minimal-v1",
      supportedRequestProfiles: ["gemini-3.1-minimal-v1", "gemini-3.1-low-v1"]
    });
  });
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
  it.each(["step-3.5-flash-2603", "step-5-preview"])(
    "sends the required named schema for %s through actual HTTP", async model => {
    let body;
    const server = createServer((request, response) => {
      const chunks = [];
      request.on("data", chunk => chunks.push(chunk));
      request.on("end", () => {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ padding: " ".repeat(MAX_RETAINED_PROVIDER_HTTP_RESPONSE_BYTES),
          choices: [{ message: { content: '{"probe":true}' }, finish_reason: "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }));
      });
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    try {
      const receipt = await probeProviderProtocol({ providerUrl: "https://api.stepfun.com/v1",
        apiKey: "local-test-key", model,
        fetchImpl: (url, init) => fetchLoopbackProvider(fetch, new URL(new URL(url).pathname, origin), init) });
      expect(receipt).toMatchObject({ model, physical_calls: 1, json_object: true,
        usage_present: true, finish_reason: "stop", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        http_response: { bodyComplete: true, bodyTruncated: false } });
      const retained = JSON.parse(Buffer.from(receipt.http_response.bodyBase64, "base64").toString("utf8"));
      expect(receipt.http_response.bodyByteLength).toBeGreaterThan(MAX_RETAINED_PROVIDER_HTTP_RESPONSE_BYTES);
      expect(retained.choices[0].message.content).toBe('{"probe":true}');
      expect(body).toMatchObject({ model, reasoning_effort: "low", max_tokens: 256,
        response_format: { type: "json_schema", json_schema: { name: "provider_protocol_probe", strict: true,
          schema: { type: "object", properties: { probe: { type: "boolean" } },
            required: ["probe"], additionalProperties: false } } } });
    } finally {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  });

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
