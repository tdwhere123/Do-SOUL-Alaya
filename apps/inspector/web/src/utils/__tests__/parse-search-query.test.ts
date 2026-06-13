import { describe, expect, it } from "vitest";
import { parseSearchQuery } from "../parse-search-query";

const REF = new Date(2026, 4, 15, 10, 0, 0); // 2026-05-15 10:00 local

describe("parseSearchQuery", () => {
  it("returns the identity shape for an empty string", async () => {
    const result = await parseSearchQuery("", REF);
    expect(result).toEqual({ text: "", since: null, until: null, windowLabel: null });
  });

  it("falls through to keyword-only when no time expression is present", async () => {
    const result = await parseSearchQuery("recall pipeline", REF);
    expect(result).toEqual({
      text: "recall pipeline",
      since: null,
      until: null,
      windowLabel: null
    });
  });

  it("parses a Chinese single-day reference like '5月20号' into a full-day window", async () => {
    const result = await parseSearchQuery("我说了什么 5月20号", REF);
    expect(result.text).toBe("我说了什么");
    expect(result.windowLabel).toBe("5月20日");
    expect(result.since).toBeTruthy();
    expect(result.until).toBeTruthy();
    const since = new Date(result.since!);
    const until = new Date(result.until!);
    expect(since.getMonth()).toBe(4); // May (0-indexed)
    expect(since.getDate()).toBe(20);
    expect(since.getHours()).toBe(0);
    expect(until.getDate()).toBe(20);
    expect(until.getHours()).toBe(23);
  });

  it("parses '昨天' as the previous calendar day relative to the reference date", async () => {
    const result = await parseSearchQuery("昨天 修了什么", REF);
    expect(result.windowLabel).toBe("昨天");
    expect(result.text).toBe("修了什么");
    const since = new Date(result.since!);
    expect(since.getMonth()).toBe(4);
    expect(since.getDate()).toBe(14);
  });

  it("parses '上周' as the previous Mon-Sun window", async () => {
    const result = await parseSearchQuery("上周 architecture", REF);
    expect(result.windowLabel).toBe("上周");
    expect(result.text).toBe("architecture");
    const since = new Date(result.since!);
    const until = new Date(result.until!);
    expect(since.getDate()).toBe(4);
    expect(until.getDate()).toBe(10); // Sunday end
  });

  it("parses an English chrono expression ('yesterday')", async () => {
    const result = await parseSearchQuery("yesterday auth bug", REF);
    expect(result.windowLabel?.toLowerCase()).toContain("yesterday");
    expect(result.since).toBeTruthy();
    expect(result.until).toBeTruthy();
    expect(result.text.toLowerCase()).toContain("auth bug");
  });

  // invariant: when both a single-day and a multi-day zh-CN expression
  // match, the longer window wins so the operator's broader intent is
  // not silently collapsed to a one-day slice.
  it("prefers a multi-day window over a single-day window when both match", async () => {
    const result = await parseSearchQuery("5月20号 上周", REF);
    expect(result.windowLabel).toBe("上周");
    const since = new Date(result.since!);
    const until = new Date(result.until!);
    // 2026-05-15 is a Friday → 上周 = 2026-05-04 .. 2026-05-10.
    expect(since.getDate()).toBe(4);
    expect(until.getDate()).toBe(10);
  });

  it("returns identity fallback when chrono-node throws on garbage input", async () => {
    const garbage = "  not-a-date";
    const result = await parseSearchQuery(garbage, REF);
    expect(result.since).toBeNull();
    expect(result.until).toBeNull();
    expect(result.windowLabel).toBeNull();
  });
});
