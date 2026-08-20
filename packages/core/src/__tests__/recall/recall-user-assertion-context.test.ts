import { describe, expect, it } from "vitest";
import {
  projectVerifiedUserAssertionContext
} from "../../recall/query/recall-user-assertion-context.js";

describe("verified User assertion context", () => {
  it("projects only the previous and anchored User sentences", () => {
    const assertion = "Over a year of uncertainty was really tough.";
    const result = projectVerifiedUserAssertionContext({
      evidenceRef: "evidence-asylum",
      entryContent: assertion,
      gist: [
        "User: Speaking of waiting, my asylum application was finally approved. Over a year of uncertainty was really tough. I am relieved now.",
        "Assistant: That sounds like a difficult wait."
      ].join("\n")
    });

    expect(result).toEqual({
      schema_version: 1,
      source_role: "user",
      evidence_ref: "evidence-asylum",
      assertion_text: assertion,
      user_context: "Speaking of waiting, my asylum application was finally approved. Over a year of uncertainty was really tough."
    });
    expect(result?.user_context).not.toContain("Assistant");
  });

  it.each([
    "Assistant: The new bookshelf is from IKEA.",
    "The new bookshelf is from IKEA.",
    "User: The new bookshelf is from Target.",
    [
      "User: The new bookshelf is from IKEA.",
      "User: The new bookshelf is from IKEA."
    ].join("\n"),
    [
      "User: The new bookshelf is from IKEA.",
      "Assistant: The new bookshelf is from IKEA."
    ].join("\n")
  ])("fails closed for Assistant-only, unlabeled, mismatched, or ambiguous evidence", (gist) => {
    expect(projectVerifiedUserAssertionContext({
      evidenceRef: "evidence-bookshelf",
      entryContent: "The new bookshelf is from IKEA.",
      gist
    })).toBeNull();
  });
});
