import { describe, expect, it } from "vitest";
import {
  parseOfficialApiSignals,
  salvageRawSignalElements
} from "../garden/compute-provider.js";

// Realistic {"signals":[...]} envelope shapes mirroring the production
// gpt-5.4-mini extraction output, so the salvage path is exercised against
// the same content corruptions observed in the LongMemEval extraction cache
// (bad escape, stray empty key, unescaped inner quote, malformed key, and a
// max_tokens-truncated final element).
// see also: packages/soul/src/garden/compute-provider.ts salvageOfficialApiSignals

function validEntry(matchedText: string, objectKind = "user_preference"): string {
  return JSON.stringify({
    signal_kind: "potential_preference",
    object_kind: objectKind,
    confidence: 0.9,
    matched_text: matchedText,
    distilled_fact: `The operator stated: ${matchedText}`,
    reason: "stated_preference"
  });
}

describe("parseOfficialApiSignals element-wise salvage", () => {
  it("recovers valid siblings when one entry has a bad JSON escape", () => {
    // `\'` is not a legal JSON escape, so a strict JSON.parse of the whole
    // envelope throws even though the two siblings are clean.
    const envelope =
      `{"signals":[` +
      validEntry("Call me Ash") +
      `,{"signal_kind":"potential_preference","object_kind":"user_preference",` +
      `"confidence":0.8,"matched_text":"I\\'ll bring my dog","distilled_fact":"x","reason":"r"},` +
      validEntry("I take oat milk") +
      `]}`;
    expect(() => JSON.parse(envelope)).toThrow();
    const signals = parseOfficialApiSignals(envelope);
    expect(signals).toHaveLength(2);
    expect(signals.map((s) => s.matched_text)).toEqual([
      "Call me Ash",
      "I take oat milk"
    ]);
  });

  it("recovers siblings when an entry has a stray empty key (,\"\"})", () => {
    const envelope =
      `{"signals":[` +
      validEntry("I am 85 years old") +
      `,{"signal_kind":"potential_claim","object_kind":"fact","confidence":0.7,` +
      `"matched_text":"I live in Berlin","" },` +
      validEntry("My cat is named Mochi") +
      `]}`;
    expect(() => JSON.parse(envelope)).toThrow();
    const signals = parseOfficialApiSignals(envelope);
    // The stray-empty-key middle entry is dropped (its `,""}` makes that
    // element fail its own JSON.parse); the two clean siblings survive.
    expect(signals.map((s) => s.matched_text)).toEqual([
      "I am 85 years old",
      "My cat is named Mochi"
    ]);
  });

  it("recovers siblings when an entry has an unescaped inner quote", () => {
    const envelope =
      `{"signals":[` +
      validEntry("Book a table for two") +
      `,{"signal_kind":"potential_preference","object_kind":"user_preference",` +
      `"confidence":0.6,"matched_text":"will be "give me a picture" please","reason":"r"},` +
      validEntry("Window seat preferred") +
      `]}`;
    expect(() => JSON.parse(envelope)).toThrow();
    const signals = parseOfficialApiSignals(envelope);
    expect(signals.map((s) => s.matched_text)).toEqual([
      "Book a table for two",
      "Window seat preferred"
    ]);
  });

  it("recovers siblings when an entry has a malformed key missing the colon", () => {
    const envelope =
      `{"signals":[` +
      validEntry("Allergic to peanuts") +
      `,{"signal_kind":"potential_claim","object_kind","event",` +
      `"confidence":0.5,"matched_text":"Attended the gala"},` +
      validEntry("Prefers tea over coffee") +
      `]}`;
    expect(() => JSON.parse(envelope)).toThrow();
    const signals = parseOfficialApiSignals(envelope);
    expect(signals.map((s) => s.matched_text)).toEqual([
      "Allergic to peanuts",
      "Prefers tea over coffee"
    ]);
  });

  it("recovers the leading entries when the FINAL element is truncated (max_tokens)", () => {
    // The buffer ends mid-string inside the last element: no closing `}` for
    // it, so the element walk never balances it and drops it. The two
    // complete prior elements survive.
    const envelope =
      `{"signals":[` +
      validEntry("First complete fact") +
      `,` +
      validEntry("Second complete fact") +
      `,{"signal_kind":"potential_preference","object_kind":"user_preference",` +
      `"confidence":0.9,"matched_text":"this got cut off mid str`;
    expect(() => JSON.parse(envelope)).toThrow();
    const signals = parseOfficialApiSignals(envelope);
    expect(signals.map((s) => s.matched_text)).toEqual([
      "First complete fact",
      "Second complete fact"
    ]);
  });

  it("throws on a degenerate envelope where the ONLY element is truncated", () => {
    // First/only entry cut immediately after `"matched_text":"` — no complete
    // element exists. Salvage recovers nothing, so it THROWS (rather than
    // returning []) to keep the caller's failure attribution: a corrupt
    // degenerate body must not masquerade as an empty `{"signals":[]}`
    // extraction; the seed path counts it as a failure + full-turn fallback.
    const envelope =
      `{"signals":[{"signal_kind":"potential_preference","object_kind":"user_preference",` +
      `"confidence":0.9,"matched_text":"`;
    expect(() => JSON.parse(envelope)).toThrow();
    expect(() => parseOfficialApiSignals(envelope)).toThrow();
  });

  it("throws when there is no signals array region at all", () => {
    const envelope = `{"oops":"not the envelope we expected`;
    expect(() => JSON.parse(envelope)).toThrow();
    expect(() => parseOfficialApiSignals(envelope)).toThrow();
  });

  it("leaves a fully-valid envelope unchanged (no salvage triggered)", () => {
    const envelope =
      `{"signals":[` +
      validEntry("Call me Ash") +
      `,` +
      validEntry("I take oat milk", "fact") +
      `]}`;
    // Strict parse must succeed, so the salvage branch is never entered.
    expect(() => JSON.parse(envelope)).not.toThrow();
    const signals = parseOfficialApiSignals(envelope);
    expect(signals).toHaveLength(2);
    expect(signals[0]).toEqual({
      signal_kind: "potential_preference",
      object_kind: "user_preference",
      confidence: 0.9,
      matched_text: "Call me Ash",
      distilled_fact: "The operator stated: Call me Ash",
      reason: "stated_preference"
    });
    expect(signals[1]?.matched_text).toBe("I take oat milk");
  });

  it("does not let a brace inside a string literal miscount the element walk", () => {
    // A `}` inside matched_text must not be read as an element close, or the
    // walk would split a single element into two and corrupt the sibling.
    const envelope =
      `{"signals":[` +
      validEntry("use the {placeholder} token") +
      `,{"signal_kind":"potential_claim","object_kind":"fact","confidence":0.5,` +
      `"matched_text":"bad \\'escape with } brace"},` +
      validEntry("plain fact") +
      `]}`;
    expect(() => JSON.parse(envelope)).toThrow();
    const signals = parseOfficialApiSignals(envelope);
    expect(signals.map((s) => s.matched_text)).toEqual([
      "use the {placeholder} token",
      "plain fact"
    ]);
  });
});

describe("salvageRawSignalElements", () => {
  it("counts every complete element including the corrupt one (raw population)", () => {
    // The raw count must include the corrupt middle element so the bench
    // attributes its drop to parseDropped (raw - parsed), not silently.
    const envelope =
      `{"signals":[` +
      validEntry("clean one") +
      `,{"signal_kind":"potential_claim","object_kind":"fact","confidence":0.5,` +
      `"matched_text":"bad \\'escape"},` +
      validEntry("clean two") +
      `]}`;
    const elements = salvageRawSignalElements(envelope);
    expect(elements).toHaveLength(3);
    // Two of the three parse cleanly; the corrupt one is countable but not
    // recoverable — exactly the raw-minus-parsed parseDropped attribution.
    const parsable = elements.filter((e) => {
      try {
        JSON.parse(e);
        return true;
      } catch {
        return false;
      }
    });
    expect(parsable).toHaveLength(2);
  });

  it("drops the truncated final element from the raw element list", () => {
    const envelope =
      `{"signals":[` +
      validEntry("complete") +
      `,{"signal_kind":"potential_preference","matched_text":"cut off`;
    const elements = salvageRawSignalElements(envelope);
    expect(elements).toHaveLength(1);
  });

  it("returns an empty list when no signals array region is present", () => {
    expect(salvageRawSignalElements(`{"oops":1`)).toEqual([]);
  });
});
