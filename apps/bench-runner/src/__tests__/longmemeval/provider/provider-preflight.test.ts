import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeCachedExtraction } from "../../../bench/compile-seed/cache/cache-shard.js";
import {
  findProviderBinding,
  requireProviderBinding,
  resolveVendorModel
} from "../../../bench/provider/catalog.js";
import { probeProviderProtocol } from "../../../bench/provider/protocol-probe.js";
import { proveProviderZeroCallReplay } from "../../../bench/provider/replay-proof.js";
import { retireObsoleteCache } from "../../../bench/provider/retire-obsolete-cache.js";
import { assertRequiredRequestProfile } from "../../../bench/extraction/transport-route.js";
import { digest, loopRequest } from "../diagnostic-loop/fixture.js";

const MIMO = requireProviderBinding("mimo-v2.5");
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

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
      providerUrl: "https://proxy.example/v1",
      apiKey: "sk-test",
      model: MIMO.id,
      fetchImpl: fetchImpl as unknown as typeof fetch
    });

    expect(receipt.physical_calls).toBe(1);
    expect(receipt.physical_calls).toBeLessThanOrEqual(MIMO.probeCallCeiling);
    expect(receipt.profile).toBe(MIMO.requestProfile);
    expect(receipt.model).toBe(MIMO.id);
    expect(receipt.usage_present).toBe(true);
    expect(receipt.f3_seal_current).toBe(true);
    const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
    expect(body.model).toBe(MIMO.id);
    expect(body.enable_thinking).toBe(false);
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
      providerUrl: "https://proxy.example/v1",
      apiKey: "sk-test",
      model: MIMO.id,
      framing: "sse",
      fetchImpl: fetchImpl as unknown as typeof fetch
    });
    expect(receipt.framing).toBe("sse");
    expect(receipt.physical_calls).toBe(1);
    expect(receipt.json_object).toBe(true);
    const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
    expect(body.stream).toBe(true);
    expect(body.model).toBe(MIMO.id);
  });

  it("refuses an empty key", async () => {
    await expect(probeProviderProtocol({
      providerUrl: "https://proxy.example/v1",
      apiKey: "",
      model: MIMO.id,
      fetchImpl: fetch
    })).rejects.toThrow(/empty API key/u);
  });
});

describe("provider cache-only replay", () => {
  it("proves zero physical calls on a bound-profile cache", async () => {
    const cacheRoot = await tempRoot();
    const key = digest("provider-key");
    writeCachedExtraction(cacheRoot, key, {
      model: MIMO.id,
      request_profile: MIMO.requestProfile,
      cache_key: key,
      raw_json: "{\"signals\":[]}",
      extracted_at: "2026-08-17T00:00:00.000Z"
    });

    const proof = proveProviderZeroCallReplay({
      request: loopRequest({
        extractionCacheRoot: cacheRoot,
        requestedKeys: [key],
        model: MIMO.id,
        requestProfile: MIMO.requestProfile
      })
    });
    expect(proof.physical_calls).toBe(0);
  });

  it("rejects obsolete cache authority", () => {
    expect(() => proveProviderZeroCallReplay({
      request: loopRequest({
        model: MIMO.id,
        requestProfile: "deepseek-v4-nonthinking-v1"
      })
    })).toThrow(/obsolete request profile/u);
  });
});

describe("obsolete cache retirement preflight", () => {
  it("fails closed without confirm, path match, or an active lock", async () => {
    const root = await tempRoot();
    expect(() => retireObsoleteCache({
      cacheRoot: root,
      expectedPath: root,
      profile: "deepseek-v4-nonthinking-v1",
      confirm: false
    })).toThrow(/confirm/u);

    expect(() => retireObsoleteCache({
      cacheRoot: root,
      expectedPath: join(root, "other"),
      profile: "deepseek-v4-nonthinking-v1",
      confirm: true
    })).toThrow(/does not match/u);

    mkdirSync(join(root, ".extraction-fill.lock"));
    expect(() => retireObsoleteCache({
      cacheRoot: root,
      expectedPath: root,
      profile: "deepseek-v4-nonthinking-v1",
      confirm: true
    })).toThrow(/in-progress/u);
  });

  it("does not delete after a clean preflight", async () => {
    const root = await tempRoot();
    writeFileSync(join(root, "keep.txt"), "stay");
    const result = retireObsoleteCache({
      cacheRoot: root,
      expectedPath: root,
      profile: "deepseek-v4-nonthinking-v1",
      confirm: true
    });
    expect(result.retired).toBe(false);
  });
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "provider-preflight-"));
  roots.push(root);
  return root;
}
