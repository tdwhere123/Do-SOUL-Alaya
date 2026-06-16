import { describe, expect, it } from "vitest";

import type { GardenCompileContext } from "../../garden/compute-provider.js";
import { LocalHeuristics } from "../../garden/local-heuristics.js";
import { buildEvidenceInput } from "../../garden/materialization-router/inputs.js";

const MAX_FULL_TURN_CONTENT_CHARS = 2_048;

// The production heuristic proposer (no API creds, no bench harness) must
// write raw_payload.full_turn_content so the bench-validated widening path
// in buildEvidenceInput is reachable in real deployment — not only when the
// bench harness stamps bench_full_turn_content.
describe("production extractor full_turn_content", () => {
  it("LocalHeuristics writes a clamped full_turn_content the widening path picks up", async () => {
    const preferenceSentence = "I always use TypeScript strict mode for application code.";
    const padding = "We discussed the migration plan at length over several paragraphs. ".repeat(60);
    const turnContent = `${preferenceSentence} ${padding}`;
    expect(turnContent.length).toBeGreaterThan(MAX_FULL_TURN_CONTENT_CHARS);

    const provider = new LocalHeuristics();
    const signals = await provider.compile(turnContent, createContext());

    const signal = signals.find((s) => s.signal_kind === "potential_preference");
    expect(signal).toBeDefined();

    const fullTurn = signal!.raw_payload.full_turn_content;
    expect(typeof fullTurn).toBe("string");
    expect((fullTurn as string).length).toBeLessThanOrEqual(MAX_FULL_TURN_CONTENT_CHARS);
    expect(fullTurn).toBe(turnContent.trim().slice(0, MAX_FULL_TURN_CONTENT_CHARS));

    // matched span stays the narrow excerpt; full_turn_content is strictly wider.
    expect((signal!.raw_payload.turn_content_excerpt as string).length).toBeLessThan(
      (fullTurn as string).length
    );
    expect(signal!.raw_payload.bench_full_turn_content).toBeUndefined();

    // widening reads full_turn_content (production key), not any bench key.
    // The reader trims, so compare against the trimmed stored value.
    const expectedWide = (fullTurn as string).trim();
    const widened = buildEvidenceInput(signal!, undefined, { fullTurnExcerpt: true });
    expect(widened.excerpt).toBe(expectedWide);
    expect(widened.gist).toBe(expectedWide);
    expect((widened.excerpt as string).length).toBeGreaterThan(MAX_FULL_TURN_CONTENT_CHARS / 2);

    const narrow = buildEvidenceInput(signal!);
    expect(narrow.excerpt).not.toBe(fullTurn);
  });
});

function createContext(): GardenCompileContext {
  return {
    workspace_id: "ws_1",
    run_id: "run_1",
    surface_id: null,
    turn_messages: [
      { message_id: "msg_user_1", role: "user", content: "Please remember this." },
      { message_id: "msg_assistant_1", role: "assistant", content: "Understood." }
    ]
  };
}
