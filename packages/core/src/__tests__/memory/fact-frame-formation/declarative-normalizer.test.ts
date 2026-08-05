import { describe, expect, it } from "vitest";
import { groundAssociativeFactFrame } from "@do-soul/alaya-protocol";
import {
  RULE_BASED_EVIDENCE_FACT_FRAME_NORMALIZER_OPERATOR_ID,
  RuleBasedEvidenceFactFrameNormalizer
} from "../../../memory/fact-frame-formation/declarative-normalizer.js";

const normalizer = new RuleBasedEvidenceFactFrameNormalizer();

describe("RuleBasedEvidenceFactFrameNormalizer", () => {
  it("forms a source-exact first-person declarative frame", () => {
    const assertion = "I bought a bookshelf from Target.";
    const proposal = normalizer.propose(assertion);

    expect(proposal).toEqual({
      schema_version: 1,
      producer_operator_id: RULE_BASED_EVIDENCE_FACT_FRAME_NORMALIZER_OPERATOR_ID,
      source_assertion: assertion,
      fact_frame: {
        schema_version: 1,
        slots: [
          { role: "subject", text: "I" },
          { role: "relation", text: "bought" },
          { role: "value", text: "a bookshelf from Target" }
        ]
      }
    });
    expect(groundAssociativeFactFrame(proposal?.fact_frame, assertion))
      .toEqual(proposal?.fact_frame);
  });

  it("skips contracted auxiliaries without losing a grounded relation", () => {
    const assertion = "I've been listening to audiobooks during my daily commute.";

    expect(normalizer.propose(assertion)?.fact_frame.slots).toEqual([
      { role: "subject", text: "I" },
      { role: "relation", text: "listening" },
      { role: "value", text: "to audiobooks during my daily commute" }
    ]);
  });

  it("preserves a source-exact negative auxiliary as a qualifier", () => {
    const assertion = "I haven't personally attended the Night Market.";

    expect(normalizer.propose(assertion)?.fact_frame.slots).toEqual([
      { role: "subject", text: "I" },
      { role: "qualifier", text: "haven't" },
      { role: "qualifier", text: "personally" },
      { role: "relation", text: "attended" },
      { role: "value", text: "the Night Market" }
    ]);
  });

  it.each([
    ["I have a dog.", "have", "a dog"],
    ["I have Atlas.", "have", "Atlas"],
    ["I do yoga.", "do", "yoga"],
    ["I had a red car.", "had", "a red car"]
  ])("keeps a lexical auxiliary-shaped relation in %s", (assertion, relation, value) => {
    expect(normalizer.propose(assertion)?.fact_frame.slots).toEqual([
      { role: "subject", text: "I" },
      { role: "relation", text: relation },
      { role: "value", text: value }
    ]);
  });

  it("fails closed when subject, relation, and value are not all source-proven", () => {
    expect(normalizer.propose("speaking of my Italian roots")).toBeUndefined();
    expect(normalizer.propose("I am the sole member.")).toBeUndefined();
    expect(normalizer.propose("I listened.")).toBeUndefined();
    expect(normalizer.propose(
      "I have really always still preferred quiet rooms."
    )).toBeUndefined();
  });

  it("returns deterministic deeply frozen proposals", () => {
    const first = normalizer.propose("We prefer quiet rooms.");
    const second = normalizer.propose("We prefer quiet rooms.");

    expect(first).toEqual(second);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first?.fact_frame)).toBe(true);
    expect(Object.isFrozen(first?.fact_frame.slots)).toBe(true);
    expect(Object.isFrozen(first?.fact_frame.slots[0])).toBe(true);
  });
});
