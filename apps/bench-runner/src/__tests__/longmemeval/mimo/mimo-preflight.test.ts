import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeCachedExtraction } from "../../../longmemeval/compile-seed/cache/cache-shard.js";
import { MIMO_MODEL_ID, MIMO_REQUEST_PROFILE } from "../../../longmemeval/mimo/profile.js";
import { probeMimoProtocol } from "../../../longmemeval/mimo/protocol-probe.js";
import { proveMimoZeroCallReplay } from "../../../longmemeval/mimo/replay-proof.js";
import { retireObsoleteDeepseekCache } from "../../../longmemeval/mimo/retire-deepseek-cache.js";
import { digest, loopRequest } from "../diagnostic-loop/fixture.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("MiMo protocol probe", () => {
  it("caps physical calls and confirms the sealed F3 identity", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: '{"ok":true}' }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
    }), { status: 200 }));

    const receipt = await probeMimoProtocol({
      providerUrl: "https://proxy.example/v1",
      apiKey: "sk-test",
      fetchImpl: fetchImpl as unknown as typeof fetch
    });

    expect(receipt.physical_calls).toBe(1);
    expect(receipt.physical_calls).toBeLessThanOrEqual(3);
    expect(receipt.profile).toBe(MIMO_REQUEST_PROFILE);
    expect(receipt.model).toBe(MIMO_MODEL_ID);
    expect(receipt.usage_present).toBe(true);
    expect(receipt.f3_seal_current).toBe(true);
    const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
    expect(body.model).toBe(MIMO_MODEL_ID);
    expect(body.enable_thinking).toBe(false);
  });

  it("refuses an empty key", async () => {
    await expect(probeMimoProtocol({
      providerUrl: "https://proxy.example/v1",
      apiKey: "",
      fetchImpl: fetch
    })).rejects.toThrow(/empty API key/u);
  });
});

describe("MiMo cache-only replay", () => {
  it("proves zero physical calls on a MiMo-profile cache", async () => {
    const cacheRoot = await tempRoot();
    const key = digest("mimo-key");
    writeCachedExtraction(cacheRoot, key, {
      model: MIMO_MODEL_ID,
      request_profile: MIMO_REQUEST_PROFILE,
      cache_key: key,
      raw_json: "{\"signals\":[]}",
      extracted_at: "2026-08-17T00:00:00.000Z"
    });

    const proof = proveMimoZeroCallReplay({
      request: loopRequest({
        extractionCacheRoot: cacheRoot,
        requestedKeys: [key],
        model: MIMO_MODEL_ID,
        requestProfile: MIMO_REQUEST_PROFILE
      })
    });
    expect(proof.physical_calls).toBe(0);
  });

  it("rejects obsolete DeepSeek cache authority", () => {
    expect(() => proveMimoZeroCallReplay({
      request: loopRequest({
        model: MIMO_MODEL_ID,
        requestProfile: "deepseek-v4-nonthinking-v1"
      })
    })).toThrow(/obsolete DeepSeek/u);
  });
});

describe("DeepSeek cache retirement preflight", () => {
  it("fails closed without confirm, path match, or an active lock", async () => {
    const root = await tempRoot();
    expect(() => retireObsoleteDeepseekCache({
      cacheRoot: root, expectedPath: root, confirm: false
    })).toThrow(/confirm/u);

    expect(() => retireObsoleteDeepseekCache({
      cacheRoot: root, expectedPath: join(root, "other"), confirm: true
    })).toThrow(/does not match/u);

    mkdirSync(join(root, ".extraction-fill.lock"));
    expect(() => retireObsoleteDeepseekCache({
      cacheRoot: root, expectedPath: root, confirm: true
    })).toThrow(/in-progress/u);
  });

  it("does not delete after a clean preflight", async () => {
    const root = await tempRoot();
    writeFileSync(join(root, "keep.txt"), "stay");
    const result = retireObsoleteDeepseekCache({
      cacheRoot: root, expectedPath: root, confirm: true
    });
    expect(result.retired).toBe(false);
  });
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "mimo-preflight-"));
  roots.push(root);
  return root;
}
