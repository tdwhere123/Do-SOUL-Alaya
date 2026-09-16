import { describe, expect, it, vi } from "vitest";
import {
  GLOBAL_MEMORY_ENTRY_OBJECT_KIND,
  MemoryDimension,
  ScopeClass
} from "@do-soul/alaya-protocol";
import { warmCjkSegmentation } from "@do-soul/alaya-cjk-segmentation";
import { createGlobalMemoryRecallPort } from "../../recall/runtime/global-memory-recall-service.js";
import { normalizeGlobalMemoryQuery } from "../../recall/runtime/global-memory/selection.js";

describe("createGlobalMemoryRecallPort", () => {
  it("selects the same bounded ranking across pages without using the full-load source", async () => {
    const firstPage = Array.from({ length: 500 }, (_, index) =>
      createSourceEntry({
        global_object_id: `global-low-${index.toString().padStart(3, "0")}`,
        activation_score: 0.1,
        domain_tags: ["alpha"]
      })
    );
    const secondPage = [
      createSourceEntry({ global_object_id: "global-tie-b", activation_score: 0.9, domain_tags: ["alpha"] }),
      createSourceEntry({ global_object_id: "global-best", activation_score: 1, domain_tags: ["alpha"] }),
      createSourceEntry({ global_object_id: "global-tie-a", activation_score: 0.9, domain_tags: ["alpha"] })
    ];
    const corpus = [...firstPage, ...secondPage];
    const list = vi.fn(async () => corpus);
    const listAll = vi.fn(async () => corpus);
    const listPage = vi.fn(async ({ offset }: { readonly offset: number }) =>
      offset === 0 ? firstPage : secondPage
    );
    const port = createGlobalMemoryRecallPort({
      globalMemorySource: { list, listAll, listPage }
    });

    const result = await port.recall({
      workspaceId: "workspace-1",
      queryText: "alpha",
      limit: 3
    });

    expect(result.map((entry) => entry.global_object_id)).toEqual([
      "global-best",
      "global-tie-a",
      "global-tie-b"
    ]);
    expect(listPage.mock.calls.map(([page]) => page.offset)).toEqual([0, 500]);
    expect(listAll).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
  });

  it("does not dump the full corpus when the paged source fails", async () => {
    const list = vi.fn(async () => []);
    const listAll = vi.fn(async () => [
      createSourceEntry({ global_object_id: "global-list-all", activation_score: 0.7 })
    ]);
    const listPage = vi.fn(async () => {
      throw new Error("paged source unavailable");
    });
    const port = createGlobalMemoryRecallPort({
      globalMemorySource: { list, listAll, listPage }
    });

    await expect(port.recall({ workspaceId: "workspace-1", queryText: null, limit: 1 }))
      .rejects.toThrow("paged source unavailable");
    expect(listPage).toHaveBeenCalledOnce();
    expect(listAll).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
  });

  it("owns global recall query matching and ranking outside daemon bootstrap", async () => {
    const list = vi.fn(async () => [
      createSourceEntry({
        global_object_id: "global-low",
        canonical_identity: "Alpha policy",
        content: "Global alpha recall",
        provenance: "repo docs",
        domain_tags: ["alpha"],
        activation_score: 0.3,
        updated_at: "2026-04-23T00:00:00.000Z",
        created_at: "2026-04-22T00:00:00.000Z"
      }),
      createSourceEntry({
        global_object_id: "global-high",
        canonical_identity: "Alpha policy",
        content: "Global alpha recall",
        provenance: "repo docs",
        domain_tags: ["alpha"],
        activation_score: 0.9,
        updated_at: "2026-04-22T00:00:00.000Z",
        created_at: "2026-04-21T00:00:00.000Z"
      }),
      createSourceEntry({
        global_object_id: "global-same-score-newer",
        canonical_identity: "Alpha policy",
        content: "Global alpha recall",
        provenance: "repo docs",
        domain_tags: ["alpha"],
        activation_score: 0.9,
        updated_at: "2026-04-23T12:00:00.000Z",
        created_at: "2026-04-20T00:00:00.000Z"
      }),
      createSourceEntry({
        global_object_id: "global-miss",
        canonical_identity: "Beta policy",
        content: "Unrelated memory",
        provenance: "other source",
        domain_tags: ["beta"],
        activation_score: 1
      })
    ]);
    const port = createGlobalMemoryRecallPort({
      globalMemorySource: { list }
    });

    const result = await port.recall({
      workspaceId: "workspace-1",
      queryText: "alpha repo",
      limit: 2
    });

    expect(list).toHaveBeenCalledTimes(1);
    expect(result).toEqual([
      expect.objectContaining({
        global_object_id: "global-same-score-newer",
        content: "Global alpha recall"
      }),
      expect.objectContaining({
        global_object_id: "global-high",
        content: "Global alpha recall"
      })
    ]);
  });

  it("matches CJK global memory by the shared lexical family rather than whitespace", async () => {
    await warmCjkSegmentation();
    const list = vi.fn(async () => [
      createSourceEntry({
        global_object_id: "global-cn-hit",
        canonical_identity: "饮品偏好",
        content: "我喜欢咖啡",
        domain_tags: ["偏好"]
      }),
      createSourceEntry({
        global_object_id: "global-cn-miss",
        canonical_identity: "无关记忆",
        content: "仓库使用 pnpm 而不是 npm",
        domain_tags: ["workflow"]
      })
    ]);
    const port = createGlobalMemoryRecallPort({ globalMemorySource: { list } });

    const result = await port.recall({
      workspaceId: "workspace-1",
      queryText: "喜欢咖啡",
      limit: 5
    });

    expect(result.map((entry) => entry.global_object_id)).toEqual(["global-cn-hit"]);
  });

  it("drops a CJK query surface only when jieba emitted that surface's pieces", async () => {
    await warmCjkSegmentation();
    const coffeeTerms = normalizeGlobalMemoryQuery("喜欢咖啡");
    const beijingTerms = normalizeGlobalMemoryQuery("北京 京");

    expect(coffeeTerms).not.toBeNull();
    expect(coffeeTerms).not.toContain("喜欢咖啡");
    expect(beijingTerms).toEqual(expect.arrayContaining(["北京", "京"]));
  });

  it("does not match a short English token as a substring of a longer word", async () => {
    const list = vi.fn(async () => [
      createSourceEntry({
        global_object_id: "global-foobar",
        canonical_identity: "Foobar policy",
        content: "Never enable foobar mode",
        domain_tags: ["foobar"]
      })
    ]);
    const port = createGlobalMemoryRecallPort({ globalMemorySource: { list } });

    const shortToken = await port.recall({
      workspaceId: "workspace-1",
      queryText: "fo",
      limit: 5
    });
    const substring = await port.recall({
      workspaceId: "workspace-1",
      queryText: "foo",
      limit: 5
    });
    const exact = await port.recall({
      workspaceId: "workspace-1",
      queryText: "foobar",
      limit: 5
    });

    expect(shortToken).toEqual([]);
    expect(substring).toEqual([]);
    expect(exact.map((entry) => entry.global_object_id)).toEqual(["global-foobar"]);
  });

  it("bounds the query cache with an LRU cap and recomputes evicted keys", async () => {
    const list = vi.fn(async () => [createSourceEntry({ global_object_id: "g" })]);
    const port = createGlobalMemoryRecallPort({ globalMemorySource: { list } });

    // Cap is 512. One recall per distinct workspace key (each unique because
    // each bench question is a new workspace), enough to overflow the cap.
    const cap = 512;
    for (let i = 0; i < cap + 1; i++) {
      await port.recall({ workspaceId: `ws-${i}`, queryText: "q", limit: 1 });
    }
    expect(list).toHaveBeenCalledTimes(cap + 1);

    // The newest key is still cached (no recompute).
    await port.recall({ workspaceId: `ws-${cap}`, queryText: "q", limit: 1 });
    expect(list).toHaveBeenCalledTimes(cap + 1);

    // The oldest key (ws-0) was evicted, so it recomputes (one more list call).
    await port.recall({ workspaceId: "ws-0", queryText: "q", limit: 1 });
    expect(list).toHaveBeenCalledTimes(cap + 2);
  });
});

function createSourceEntry(
  overrides: Partial<{
    readonly global_object_id: string;
    readonly canonical_identity: string;
    readonly dimension: MemoryDimension;
    readonly scope_class: ScopeClass;
    readonly content: string;
    readonly domain_tags: readonly string[];
    readonly provenance: string;
    readonly activation_score: number | null;
    readonly created_at: string;
    readonly updated_at: string;
  }> = {}
) {
  return {
    global_object_id: "global-source-1",
    object_kind: GLOBAL_MEMORY_ENTRY_OBJECT_KIND,
    canonical_identity: "Global identity",
    dimension: MemoryDimension.PROCEDURE,
    scope_class: ScopeClass.GLOBAL_DOMAIN,
    content: "Global recall content",
    domain_tags: ["repo"],
    provenance: "docs",
    activation_score: 0.5,
    version: 1,
    created_at: "2026-04-23T00:00:00.000Z",
    updated_at: "2026-04-23T00:00:00.000Z",
    ...overrides
  };
}
