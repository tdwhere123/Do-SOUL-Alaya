import { describe, expect, it } from "vitest";

import { buildEvidenceInput } from "../../garden/materialization-router/inputs.js";
import { createSignal } from "./materialization-router-fixture.js";

describe("buildEvidenceInput fullTurnExcerpt", () => {
  const FULL_TURN =
    "User: Can you recommend video editing resources? I use Adobe Premiere Pro and want advanced color grading tutorials.";

  it("default: excerpt/gist = the narrow signal summary (unchanged)", () => {
    const signal = createSignal({
      raw_payload: { excerpt: "prefers Adobe Premiere Pro", full_turn_content: FULL_TURN }
    });
    const ev = buildEvidenceInput(signal);
    expect(ev.excerpt).toBe("prefers Adobe Premiere Pro");
    expect(ev.gist).toBe("prefers Adobe Premiere Pro");
  });

  it("fullTurnExcerpt: widens excerpt/gist to full_turn_content", () => {
    const signal = createSignal({
      raw_payload: { excerpt: "prefers Adobe Premiere Pro", full_turn_content: FULL_TURN }
    });
    const ev = buildEvidenceInput(signal, undefined, { fullTurnExcerpt: true });
    expect(ev.excerpt).toBe(FULL_TURN);
    expect(ev.gist).toBe(FULL_TURN);
  });

  it("fullTurnExcerpt: falls back to bench_full_turn_content then summary", () => {
    const benchSignal = createSignal({
      raw_payload: { excerpt: "narrow", bench_full_turn_content: FULL_TURN }
    });
    expect(buildEvidenceInput(benchSignal, undefined, { fullTurnExcerpt: true }).excerpt).toBe(FULL_TURN);

    const noTurn = createSignal({ raw_payload: { excerpt: "narrow only" } });
    expect(buildEvidenceInput(noTurn, undefined, { fullTurnExcerpt: true }).excerpt).toBe("narrow only");
  });
});
