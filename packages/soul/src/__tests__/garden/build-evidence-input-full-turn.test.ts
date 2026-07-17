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

  it("fullTurnExcerpt: ignores bench_full_turn_content and falls back to summary", () => {
    const benchOnly = createSignal({
      raw_payload: { excerpt: "narrow", bench_full_turn_content: FULL_TURN }
    });
    expect(buildEvidenceInput(benchOnly, undefined, { fullTurnExcerpt: true }).excerpt).toBe("narrow");

    const noTurn = createSignal({ raw_payload: { excerpt: "narrow only" } });
    expect(buildEvidenceInput(noTurn, undefined, { fullTurnExcerpt: true }).excerpt).toBe("narrow only");
  });

  it("never substitutes signal creation time for a source observation", () => {
    const evidence = buildEvidenceInput(createSignal({
      created_at: "2020-01-01T00:00:00.000Z"
    }));

    expect(evidence.event_anchor).toBeNull();
  });

  it("uses only the verified EventLog context for a temporal evidence anchor", () => {
    const evidence = buildEvidenceInput(createSignal(), undefined, {
      context: {
        source_event_anchor: {
          event_type: "soul.signal.emitted",
          event_id: "event-1",
          occurred_at: "2019-12-31T23:59:59.000Z"
        }
      }
    });

    expect(evidence.event_anchor).toEqual({
      event_type: "soul.signal.emitted",
      event_id: "event-1",
      occurred_at: "2019-12-31T23:59:59.000Z"
    });
  });
});
