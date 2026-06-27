import { afterEach, describe, expect, it, vi } from "vitest";

describe("resolveHydeQueryText", () => {
  afterEach(() => {
    delete process.env.ALAYA_RECALL_QUERY_HYDE_JSON;
    vi.resetModules();
  });

  it("returns the query unchanged when no HyDE JSON is set (byte-identical off)", async () => {
    const { resolveHydeQueryText } = await import("../../recall/query-hyde.js");
    expect(resolveHydeQueryText("recommend video editing resources")).toBe(
      "recommend video editing resources"
    );
    expect(resolveHydeQueryText(null)).toBeNull();
  });

  it("replaces the query with the hypothesis on a normalized (case/whitespace) match", async () => {
    process.env.ALAYA_RECALL_QUERY_HYDE_JSON = JSON.stringify({
      "recommend video editing resources": "The user uses Adobe Premiere Pro."
    });
    const { resolveHydeQueryText } = await import("../../recall/query-hyde.js");
    expect(resolveHydeQueryText("Recommend  Video Editing Resources")).toBe(
      "The user uses Adobe Premiere Pro."
    );
    expect(resolveHydeQueryText("a query with no hypothesis")).toBe("a query with no hypothesis");
  });
});
