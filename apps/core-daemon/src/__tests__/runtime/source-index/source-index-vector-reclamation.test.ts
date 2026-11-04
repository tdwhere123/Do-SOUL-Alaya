import { afterAll, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  const url = new URL("../../../../../../packages/core/src/__tests__/embedding-recall/authored-source-embedding-guard.mjs", import.meta.url);
  return (await import(/* @vite-ignore */ url.href)).isolation;
});
afterAll(() => { expect(isolation.violations).toEqual([]); isolation.restore(); });
import { buildReady, configuration, fixture, publishSource, WORKSPACE } from
  "../../../../../../packages/storage/src/__tests__/repos/source-index/source-index-fixture.js";
import { SourceIndexProducer } from "../../../runtime/source-index/source-index-producer.js";

it("reclaims retired vector payload in bounded scheduled pages even when model binding fails", async () => {
  const environment = fixture(), { database, index } = environment;
  publishSource(environment, "abcdefghijklmnop", "one");
  const first = buildReady(environment);
  const second = buildReady(environment, configuration({ model_revision: "v2" }));
  const current = buildReady(environment, configuration({ model_revision: "v3" }));
  const activeId = current.generation.generation_id;
  const producer = new SourceIndexProducer({ database, warn: vi.fn(), limits: { capturePage: 2 },
    bindSourceEmbedding: async () => { throw new Error("model unavailable"); } });
  let removed = 0;
  try {
    for (let pass = 0; pass < 30; pass++) {
      const receipt = await producer.runPass();
      expect(receipt).toMatchObject({ status: "failed", reason: "model unavailable" });
      const page = receipt.vector_reclamation;
      expect(page.vectors + page.windows + page.targets).toBeLessThanOrEqual(2);
      expect(receipt.resources.work).toBeLessThanOrEqual(receipt.limits.work);
      expect(receipt.resources.native_bytes).toBeLessThanOrEqual(receipt.limits.nativeBytes);
      removed += page.generations;
      if (removed === 2) break;
    }
    expect(removed).toBe(2);
    expect(index.generation(WORKSPACE, first.generation.generation_id)).toBeNull();
    expect(index.generation(WORKSPACE, second.generation.generation_id)).toBeNull();
    expect(index.state(WORKSPACE)).toMatchObject({ status: "ready", active_generation_id: activeId });
    expect(database.connection.prepare("SELECT count(*) AS n FROM source_index_vectors WHERE workspace_id=? AND generation_id=?")
      .get(WORKSPACE, activeId)).toEqual({ n: 2 });
  } finally { await producer.stop(); database.close({ optimize: false }); }
});
