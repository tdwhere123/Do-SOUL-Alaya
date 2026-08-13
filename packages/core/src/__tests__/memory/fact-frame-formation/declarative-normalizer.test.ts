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

  it("forms a first-person frame after a leading prepositional adjunct", () => {
    const assertion =
      "By the way, I took my niece to the Natural History Museum on 2/8";
    const proposal = normalizer.propose(assertion);

    expect(proposal?.fact_frame.slots).toEqual([
      { role: "subject", text: "I" },
      { role: "relation", text: "took" },
      { role: "value", text: "my niece to the Natural History Museum on 2/8" }
    ]);
    expect(groundAssociativeFactFrame(proposal?.fact_frame, assertion))
      .toEqual(proposal?.fact_frame);
  });

  it("forms a first-person frame after a leading participial adjunct", () => {
    const assertion = "Speaking of my Italian roots, I still cook pasta on Sundays";

    expect(normalizer.propose(assertion)?.fact_frame.slots).toEqual([
      { role: "subject", text: "I" },
      { role: "qualifier", text: "still" },
      { role: "relation", text: "cook" },
      { role: "value", text: "pasta on Sundays" }
    ]);
  });

  it("forms after a fused-WH complement of a participial adjunct", () => {
    expect(normalizer.propose(
      "Speaking of which, I still cook pasta on Sundays"
    )?.fact_frame.slots).toEqual([
      { role: "subject", text: "I" },
      { role: "qualifier", text: "still" },
      { role: "relation", text: "cook" },
      { role: "value", text: "pasta on Sundays" }
    ]);
  });

  it("forms after an infinitival to-be adjunct", () => {
    expect(normalizer.propose(
      "To be honest, I prefer quiet rooms at night."
    )?.fact_frame.slots).toEqual([
      { role: "subject", text: "I" },
      { role: "relation", text: "prefer" },
      { role: "value", text: "quiet rooms at night" }
    ]);
  });

  it("treats determiner that as NP material rather than a complementizer", () => {
    expect(normalizer.propose("On that day I visited the museum.")?.fact_frame.slots)
      .toEqual([
        { role: "subject", text: "I" },
        { role: "relation", text: "visited" },
        { role: "value", text: "the museum" }
      ]);
  });

  it("keeps a contracted subject after a leading prepositional adjunct", () => {
    const assertion = "By the way, I've been listening to audiobooks during my commute.";

    expect(normalizer.propose(assertion)?.fact_frame.slots).toEqual([
      { role: "subject", text: "I" },
      { role: "relation", text: "listening" },
      { role: "value", text: "to audiobooks during my commute" }
    ]);
  });

  it("fails closed when subject, relation, and value are not all source-proven", () => {
    expect(normalizer.propose("speaking of my Italian roots")).toBeUndefined();
    expect(normalizer.propose("By the way")).toBeUndefined();
    expect(normalizer.propose("On Tuesday")).toBeUndefined();
    expect(normalizer.propose("After I visited the museum.")).toBeUndefined();
    expect(normalizer.propose("Something I bought at Target.")).toBeUndefined();
    expect(normalizer.propose("Thing I bought at Target was useful.")).toBeUndefined();
    expect(normalizer.propose("I am the sole member.")).toBeUndefined();
    expect(normalizer.propose("I listened.")).toBeUndefined();
    expect(normalizer.propose(
      "I have really always still preferred quiet rooms."
    )).toBeUndefined();
  });

  it("fails closed when a leading adjunct span opens another finite or interrogative clause", () => {
    expect(normalizer.propose(
      "By the way, after I visited the museum, I ate lunch."
    )).toBeUndefined();
    expect(normalizer.propose(
      "By the way, The Book of Mormon is another musical theater soundtrack I've been listening to on my daily commute"
    )).toBeUndefined();
    expect(normalizer.propose(
      "By the way, do you know of any good resources for learning Spanish?"
    )).toBeUndefined();
    expect(normalizer.propose(
      "By the way, last Sunday was a lot of fun - we played Scattergories at my place."
    )).toBeUndefined();
    expect(normalizer.propose(
      "Considering I've had success with spinner baits, I'm thinking of trying them again."
    )).toBeUndefined();
  });

  it("fails closed on a reduced relative after a second NP", () => {
    expect(normalizer.propose(
      "By the way, that book I bought was great."
    )).toBeUndefined();
    expect(normalizer.propose(
      "By the way, the book I bought was great."
    )).toBeUndefined();
    expect(normalizer.propose(
      "By the way, the first house I saw was listed for $425,000"
    )).toBeUndefined();
    expect(normalizer.propose(
      "By the way, the lecture series I attended downtown was held at a location downtown, and the speaker, Dr. Khan, was really engaging."
    )).toBeUndefined();
  });

  it("does not treat a title-internal WH word as a fused PP complement", () => {
    expect(normalizer.propose(
      "Under \"How We Met\", I'll include the location where I met them."
    )).toBeUndefined();
  });

  it("fails closed when a preposition is followed by a bare verb rather than a simple NP", () => {
    expect(normalizer.propose(
      "To ensure I arrived on time, I woke up 1 hour before I needed to be at the office."
    )).toBeUndefined();
  });

  it("fails closed on a later pronoun after a lexical finite in a second clause", () => {
    expect(normalizer.propose(
      "By the way, my Instagram post about trying sushi for the first time got 57 likes and 12 comments, so I'm guessing I'm not the only one who loves sushi!"
    )).toBeUndefined();
    expect(normalizer.propose(
      "By the way, speaking of family, my sister just got engaged last weekend, and we had a big celebration at a restaurant."
    )).toBeUndefined();
  });

  it("does not treat an unspaced CJK assertion as an English adjunct prefix", () => {
    expect(normalizer.propose("我带侄女去了自然历史博物馆")).toBeUndefined();
  });

  it("still forms when a first-person English clause has a CJK value", () => {
    expect(normalizer.propose("I visited 自然历史博物馆.")?.fact_frame.slots).toEqual([
      { role: "subject", text: "I" },
      { role: "relation", text: "visited" },
      { role: "value", text: "自然历史博物馆" }
    ]);
  });

  it("leaves a CJK topic before an English subject unavailable", () => {
    expect(normalizer.propose("对了 I took my niece to the museum.")).toBeUndefined();
    expect(normalizer.propose("博物馆 I visited the Louvre yesterday.")).toBeUndefined();
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
