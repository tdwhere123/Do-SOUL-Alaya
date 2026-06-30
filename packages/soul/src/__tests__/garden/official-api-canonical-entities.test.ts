import { describe, expect, it } from "vitest";
import { parseOfficialApiSignals } from "../../garden/compute-provider.js";

// canonical_entities is the answer-selective recall key: the parser must lift it
// from the extraction JSON, default safely when absent, and normalize to a
// lowercase / deduped / cap-3 array so the SAME entity yields the SAME string.

function envelope(entry: Record<string, unknown>): string {
  return JSON.stringify({
    signals: [
      {
        signal_kind: "potential_preference",
        object_kind: "user_preference",
        confidence: 0.9,
        matched_text: "I use PostgreSQL at Acme",
        distilled_fact: "The operator uses PostgreSQL at Acme.",
        ...entry
      }
    ]
  });
}

describe("parseOfficialApiSignals canonical_entities", () => {
  it("parses canonical_entities into the draft", () => {
    const [draft] = parseOfficialApiSignals(envelope({ canonical_entities: ["alice", "postgresql"] }));
    expect(draft?.canonical_entities).toEqual(["alice", "postgresql"]);
  });

  it("omits canonical_entities when the field is missing", () => {
    const [draft] = parseOfficialApiSignals(envelope({}));
    expect(draft?.canonical_entities).toBeUndefined();
  });

  it("omits canonical_entities when the field is not an array", () => {
    const [draft] = parseOfficialApiSignals(envelope({ canonical_entities: "alice" }));
    expect(draft?.canonical_entities).toBeUndefined();
  });

  it("lowercases, dedupes (case-insensitively), and caps to three entities", () => {
    const [draft] = parseOfficialApiSignals(
      envelope({ canonical_entities: ["Alice", "alice", "PostgreSQL", "Acme", "Redis"] })
    );
    expect(draft?.canonical_entities).toEqual(["alice", "postgresql", "acme"]);
  });

  it("drops blank / non-string entries", () => {
    const [draft] = parseOfficialApiSignals(
      envelope({ canonical_entities: ["  ", "Alice", 7, null, "  Bob  "] })
    );
    expect(draft?.canonical_entities).toEqual(["alice", "bob"]);
  });
});
