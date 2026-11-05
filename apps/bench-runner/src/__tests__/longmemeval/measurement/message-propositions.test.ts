import { describe, expect, it } from "vitest";
import { GOLD } from "./source-semantic-library-measurement-fixture.js";
import { scoreConsumerMessagePropositions, scoreConsumerMessageVisibility,
  type ConsumerVisibilityPage } from "../../../runs/longmemeval-semantic/message-visibility.js";
import type { AnswerTurnGold } from "../../../runs/longmemeval-semantic/answer-spans.js";

const gold: AnswerTurnGold = { unit: "published_body_utf8_bytes", annotated_turns: 1, complete: true,
  spans: [{ session_index: 0, message_index: 0, source_id: GOLD.root_id, target: GOLD, start: 4, end: 8 }] };
function page(first: number, count: number, ranks: readonly number[], terminal = false, number = 1): ConsumerVisibilityPage {
  return { page: number, status: "observed", reason: null, occupied_slots: count, complete: true,
    continuation: terminal ? "none" : "present",
    terminal_tail: { status: terminal ? "exhausted" : "open", reason: terminal ? "complete" : "continuation" },
    // Skipped slots stand for memory, proof or a source with no visible gold bytes.
    intervals: ranks.filter(rank => rank >= first && rank < first + count)
      .map(rank => ({ rank, target: GOLD, start: 4, end: 8 })) };
}

describe("versioned message propositions", () => {
  it("retains a frozen positive while reporting incomplete collection and the historical difference", () => {
    const input = { gold, pages: [page(1, 5, [1])] };
    const current = scoreConsumerMessagePropositions(input), historical = scoreConsumerMessageVisibility(input);
    expect(current.contract).toBe("consumer-message-visibility-v2");
    expect(current.any_at_10.status).toBe("hit");
    expect(current.all_at_10.status).toBe("hit");
    expect(current.messages[0]!.at_10.status).toBe("hit");
    expect(current.collection.at_10.status).toBe("incomplete");
    expect(current.observation.observed_through).toBe(5);
    expect(historical.contract).toBe("consumer-message-visibility-v1");
    expect(historical.any_at_10.status).toBe("unknown");
  });

  it("matches an independent prefix-set reference across page splits and non-source slots", () => {
    for (const terminal of [false, true]) for (const occupied of [0, 3, 5, 7, 10]) {
      for (const hits of [[], [1], [6], [2, 8]]) {
        const ranks = new Set(hits.filter(rank => rank <= occupied));
        const pages = occupied > 5
          ? [page(1, 5, [...ranks]), page(6, occupied - 5, [...ranks], terminal, 2)]
          : [page(1, occupied, [...ranks], terminal)];
        const result = scoreConsumerMessagePropositions({ gold, pages });
        for (const k of [5, 10] as const) {
          const prefix = new Set(Array.from({ length: Math.min(k, occupied) }, (_, i) => i + 1));
          const expected = [...prefix].some(rank => ranks.has(rank)) ? "hit" : terminal || prefix.size === k ? "miss" : "unknown";
          expect(k === 5 ? result.any_at_5.status : result.any_at_10.status).toBe(expected);
          expect(k === 5 ? result.all_at_5.status : result.all_at_10.status).toBe(expected);
        }
      }
    }
  });

  it("requires every nonempty mapped gold member for All while preserving a known Any witness", () => {
    const partial = scoreConsumerMessagePropositions({ gold: { ...gold, complete: false, annotated_turns: 2 }, pages: [page(1, 5, [1])] });
    expect(partial.any_at_10.status).toBe("hit");
    expect(partial.all_at_10).toEqual({ status: "unknown", reason: "answer_turn_mapping_incomplete" });
    const unknown = scoreConsumerMessagePropositions({ gold: undefined, pages: [page(1, 0, [], true)] });
    expect(unknown.any_at_10.status).toBe("unknown");
    expect(unknown.collection.at_10.status).toBe("complete");
    const empty = scoreConsumerMessagePropositions({ gold: { ...gold, annotated_turns: 0, spans: [] }, pages: [page(1, 0, [], true)] });
    expect(empty.all_at_10).toEqual({ status: "unknown", reason: "no_annotated_answer_turn" });
  });

  it("refuses invalid rank/body mappings even when they appear to contain a gold witness", () => {
    const invalid = { ...page(1, 5, [1]), intervals: [{ rank: 6, target: GOLD, start: 4, end: 8 }] };
    const result = scoreConsumerMessagePropositions({ gold, pages: [invalid] });
    expect(result.any_at_10.status).toBe("unknown");
    expect(result.collection.at_10.status).toBe("invalid");
    expect(result.messages[0]!.visible_intervals).toEqual([]);
    const unbound = { ...page(1, 5, [1], true), intervals: [{ rank: 1, target: { ...GOLD, source_version: "different" }, start: 4, end: 8 }] };
    expect(scoreConsumerMessagePropositions({ gold, pages: [unbound] }).any_at_10.status).toBe("miss");
  });
});
