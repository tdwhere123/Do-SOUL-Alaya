import { describe, expect, it } from "vitest";
import {
  D2Q_EMBED_TEXT_MAX_CHARS,
  resolveEmbedText
} from "../../embedding-recall/embed-text-resolver.js";

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
