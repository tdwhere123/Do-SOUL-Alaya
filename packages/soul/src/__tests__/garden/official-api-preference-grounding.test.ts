import { describe, expect, it } from "vitest";
import {
  OfficialApiGardenProvider,
  type GardenCompileContext
} from "../../garden/compute-provider.js";

const SOURCE = "I prefer dark mode for the theme.";
const CONTEXT: GardenCompileContext = {
  workspace_id: "workspace-preference",
  run_id: "run-preference",
  surface_id: null,
  turn_messages: [{ message_id: "u1", role: "user", content: SOURCE }]
};

describe("official API preference profile grounding", () => {
  it("retains only source-grounded profile fields on a verified User assertion", async () => {
    const [signal] = await providerFor({
      matched_text: SOURCE,
      preference_profile: {
        projection_schema_version: 1,
        preference_subject: "I",
        preference_predicate: "enjoy",
        preference_object: "dark mode",
        preference_category: "theme",
        preference_polarity: "positive"
      }
    }).compile(SOURCE, CONTEXT);

    expect(signal?.raw_payload.preference_profile).toEqual({
      projection_schema_version: 1,
      preference_subject: "operator",
      preference_object: "dark mode",
      preference_category: "theme",
      preference_polarity: "positive"
    });
  });

  it("does not turn neutral first-person usage into a preference profile", async () => {
    const source = "I use dark mode for the theme.";
    const [signal] = await providerFor({
      matched_text: source,
      preference_profile: {
        projection_schema_version: 1,
        preference_subject: "I",
        preference_object: "dark mode",
        preference_category: "theme",
        preference_polarity: "positive"
      }
    }).compile(source, {
      ...CONTEXT,
      turn_messages: [{ message_id: "u1", role: "user", content: source }]
    });

    expect(signal?.raw_payload.source_grounding).toMatchObject({
      status: "grounded"
    });
    expect(signal?.raw_payload).not.toHaveProperty("preference_profile");
  });

  it("does not assign a direct third-party preference to the operator", async () => {
    const source = "I told Alice that she prefers dark mode.";
    const [signal] = await providerFor({
      matched_text: source,
      preference_profile: {
        projection_schema_version: 1,
        preference_subject: "she",
        preference_predicate: "prefers",
        preference_object: "dark mode",
        preference_polarity: "positive"
      }
    }).compile(source, {
      ...CONTEXT,
      turn_messages: [{ message_id: "u1", role: "user", content: source }]
    });

    expect(signal?.raw_payload).not.toHaveProperty("preference_profile");
  });

  it.each([
    "I never said I prefer dark mode.",
    "I don't think I prefer dark mode."
  ])("does not project a preference from negated speech or thought: %s", async (source) => {
    const [signal] = await providerFor({
      matched_text: source,
      preference_profile: {
        projection_schema_version: 1,
        preference_subject: "I",
        preference_predicate: "prefer",
        preference_object: "dark mode",
        preference_polarity: "positive"
      }
    }).compile(source, {
      ...CONTEXT,
      turn_messages: [{ message_id: "u1", role: "user", content: source }]
    });

    expect(signal?.raw_payload).not.toHaveProperty("preference_profile");
  });

  it("grounds a preference relation after a bounded scope adjunct", async () => {
    const source = "For theme settings, I prefer dark mode.";
    const [signal] = await providerFor({
      matched_text: source,
      preference_profile: {
        projection_schema_version: 1,
        preference_subject: "I",
        preference_predicate: "prefer",
        preference_object: "dark mode",
        preference_category: "theme settings",
        preference_polarity: "positive"
      }
    }).compile(source, {
      ...CONTEXT,
      turn_messages: [{ message_id: "u1", role: "user", content: source }]
    });

    expect(signal?.raw_payload.preference_profile).toEqual({
      projection_schema_version: 1,
      preference_subject: "operator",
      preference_predicate: "prefer",
      preference_object: "dark mode",
      preference_category: "theme settings",
      preference_polarity: "positive"
    });
  });

  it("strips a bounded temporal adjunct from the grounded object", async () => {
    const source = "I prefer dark mode now.";
    const [signal] = await providerFor({
      matched_text: source,
      preference_profile: {
        projection_schema_version: 1,
        preference_subject: "I",
        preference_predicate: "prefer",
        preference_object: "dark mode",
        preference_polarity: "positive"
      }
    }).compile(source, {
      ...CONTEXT,
      turn_messages: [{ message_id: "u1", role: "user", content: source }]
    });

    expect(signal?.raw_payload.preference_profile).toEqual({
      projection_schema_version: 1,
      preference_subject: "operator",
      preference_predicate: "prefer",
      preference_object: "dark mode",
      preference_polarity: "positive"
    });
  });

  it("does not retain object and category values in swapped semantic roles", async () => {
    const source = "For theme settings, I prefer dark mode.";
    const [signal] = await providerFor({
      matched_text: source,
      preference_profile: {
        projection_schema_version: 1,
        preference_subject: "I",
        preference_predicate: "prefer",
        preference_object: "theme",
        preference_category: "dark mode",
        preference_polarity: "positive"
      }
    }).compile(source, {
      ...CONTEXT,
      turn_messages: [{ message_id: "u1", role: "user", content: source }]
    });

    expect(signal?.raw_payload).not.toHaveProperty("preference_profile");
  });

  it("does not persist the opposite polarity from an English double negation", async () => {
    const source = "I don't dislike dark mode.";
    const [signal] = await providerFor({
      matched_text: source,
      preference_profile: {
        projection_schema_version: 1,
        preference_subject: "I",
        preference_object: "dark mode",
        preference_polarity: "negative"
      }
    }).compile(source, {
      ...CONTEXT,
      turn_messages: [{ message_id: "u1", role: "user", content: source }]
    });

    expect(signal?.raw_payload.preference_profile).toMatchObject({
      projection_schema_version: 1,
      preference_subject: "operator",
      preference_object: "dark mode"
    });
    expect(signal?.raw_payload.preference_profile).not.toHaveProperty("preference_polarity");
  });

  it("keeps a rejected grounding free of a top-level profile", async () => {
    const [signal] = await providerFor({
      matched_text: "I prefer light mode.",
      preference_profile: {
        projection_schema_version: 1,
        preference_subject: "I",
        preference_predicate: "prefer",
        preference_object: "light mode",
        preference_polarity: "positive"
      }
    }).compile(SOURCE, CONTEXT);

    expect(signal?.raw_payload.source_grounding).toMatchObject({
      status: "rejected",
      content_basis: "none"
    });
    expect(signal?.raw_payload).not.toHaveProperty("preference_profile");
  });

  it("does not widen a long generic assertion through an empty preference proposal", async () => {
    const source = `The deployment report contains ${"x".repeat(600)}.`;
    const [signal] = await providerFor({
      matched_text: source,
      preference_profile: {}
    }).compile(source, {
      ...CONTEXT,
      turn_messages: [{ message_id: "u-long-generic", role: "user", content: source }]
    });

    expect(signal?.raw_payload.source_grounding).toMatchObject({
      status: "rejected",
      content_basis: "none"
    });
    expect(signal?.raw_payload).not.toHaveProperty("preference_profile");
  });
});

function providerFor(fields: Readonly<Record<string, unknown>>): OfficialApiGardenProvider {
  return new OfficialApiGardenProvider({
    apiKey: "sk-test",
    extractor: {
      extract: async () => ({
        rawJson: JSON.stringify({
          signals: [{
            signal_kind: "potential_preference",
            object_kind: "preference",
            confidence: 0.9,
            source_locator: {
              contract_version: 2,
              kind: "assertion_catalog",
              assertion_id: 1
            },
            ...fields
          }]
        })
      })
    },
    generateSignalId: () => "signal-preference"
  });
}
