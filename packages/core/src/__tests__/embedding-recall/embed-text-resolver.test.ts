import { describe, expect, it } from "vitest";
import {
  D2Q_EMBED_TEXT_MAX_CHARS,
  normHqContentKey,
  resolveEmbedText
} from "../../embedding-recall/embed-text-resolver.js";

// Oracle copied verbatim from the d2q gen/reembed probe so a drift in the
// production key is caught against the cache it must hit.
function probeKey(content: string): string {
  return content
    .replace(/\s+/gu, " ")
    .slice(0, 500)
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/gu, " ")
    .trim();
}

describe("resolveEmbedText", () => {
  it("returns raw content when there are no HQs (d2q off path)", () => {
    const memory = { content: "Pinned repository workflow." };
    expect(resolveEmbedText(memory, [])).toBe("Pinned repository workflow.");
  });

  it("joins content with HQs on a single space when HQs are present", () => {
    const memory = { content: "Pinned repository workflow." };
    expect(resolveEmbedText(memory, ["What workflow is pinned?", "Which repo?"])).toBe(
      "Pinned repository workflow. What workflow is pinned? Which repo?"
    );
  });

  it("caps the augmented text at the d2q character budget", () => {
    const memory = { content: "a".repeat(D2Q_EMBED_TEXT_MAX_CHARS) };
    const text = resolveEmbedText(memory, ["b".repeat(500)]);
    expect(text.length).toBe(D2Q_EMBED_TEXT_MAX_CHARS);
    expect(text.startsWith("a".repeat(10))).toBe(true);
  });
});

describe("normHqContentKey", () => {
  const samples = [
    "Pinned repository workflow.",
    "  Leading and trailing   spaces ",
    "Tabs\tand\nnewlines\r\nmixed",
    "UPPER and Mixed Case Content",
    "ＦＵＬＬＷＩＤＴＨ unicode normalises", // NFKC folds fullwidth to ascii
    "x".repeat(900)
  ];

  it("matches the probe cache key byte-for-byte across samples", () => {
    for (const sample of samples) {
      expect(normHqContentKey(sample)).toBe(probeKey(sample));
    }
  });

  it("hits a cache keyed by the probe normalizer", () => {
    const content = "User prefers Vite over Webpack for new projects.";
    const cache: Record<string, readonly string[]> = {
      [probeKey(content)]: ["Which bundler does the user prefer?"]
    };
    expect(cache[normHqContentKey(content)]).toEqual(["Which bundler does the user prefer?"]);
  });
});
