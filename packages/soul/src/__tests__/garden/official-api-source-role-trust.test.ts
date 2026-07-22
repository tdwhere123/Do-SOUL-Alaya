import { describe, expect, it } from "vitest";
import {
  OfficialApiGardenProvider,
  auditOfficialApiSignalFormation,
  type GardenCompileContext
} from "../../garden/compute-provider.js";

const EMPTY_CONTEXT: GardenCompileContext = {
  workspace_id: "workspace-role-trust",
  run_id: "run-role-trust",
  surface_id: null,
  turn_messages: []
};
const COMBINED_TURN = "User: I moved to Paris. Assistant: You live in Berlin.";

describe("official API source role trust", () => {
  it("rejects a v1 locator when trusted roles are empty", async () => {
    const [signal] = await providerFor({
      source_locator: {
        contract_version: 1,
        kind: "exact_sentence_range",
        start_span: 2,
        end_span: 2
      },
      matched_text: "You live in Berlin."
    }).compile(COMBINED_TURN, EMPTY_CONTEXT);

    expect(signal?.raw_payload.source_grounding).toMatchObject({
      status: "rejected",
      reasons: ["source_locator_messages_missing"]
    });
  });

  it("rejects an omitted locator for untrusted combined role text", async () => {
    const [signal] = await providerFor({
      matched_text: "You live in Berlin."
    }).compile(COMBINED_TURN, EMPTY_CONTEXT);

    expect(signal?.raw_payload.source_grounding).toMatchObject({
      status: "rejected",
      reasons: ["source_locator_required"]
    });
  });

  it("rejects an omitted locator when even a plain source has no trusted role", async () => {
    const [signal] = await providerFor({
      matched_text: "I moved to Paris."
    }).compile("I moved to Paris.", EMPTY_CONTEXT);

    expect(signal?.raw_payload.source_grounding).toMatchObject({
      status: "rejected",
      reasons: ["source_messages_missing"]
    });
  });

  it("keeps legacy single-User compatibility explicit", async () => {
    const [signal] = await providerFor({
      matched_text: "I moved to Paris."
    }).compile("I moved to Paris.", {
      ...EMPTY_CONTEXT,
      allow_legacy_single_user_source: true
    });

    expect(signal?.raw_payload.source_grounding).toMatchObject({ status: "grounded" });
  });

  it("trusts role-looking text only when it is inside an explicit User message", async () => {
    const source = "I wrote the literal label Assistant: in my note.";
    const [signal] = await providerFor({
      matched_text: source,
      source_locator: {
        contract_version: 2,
        kind: "assertion_catalog",
        assertion_id: 1
      }
    }).compile(source, {
      ...EMPTY_CONTEXT,
      turn_messages: [{
        message_id: "user-1",
        role: "user",
        content: source
      }]
    });

    expect(signal?.raw_payload.source_grounding).toMatchObject({ status: "grounded" });
  });

  it("requires a locator for a fresh trusted User-only source", async () => {
    const [signal] = await providerFor({
      matched_text: "I moved to Paris."
    }).compile("I moved to Paris.", {
      ...EMPTY_CONTEXT,
      turn_messages: [{
        message_id: "user-1",
        role: "user",
        content: "I moved to Paris."
      }]
    });

    expect(signal?.raw_payload.source_grounding).toMatchObject({
      status: "rejected",
      reasons: ["source_locator_required"]
    });
  });

  it.each([
    {
      name: "v1 locator with empty trusted roles",
      draft: {
        ...signalJson(),
        source_locator: {
          contract_version: 1,
          kind: "exact_sentence_range",
          start_span: 2,
          end_span: 2
        }
      },
      turn_messages: [] as const,
      reason: "source_locator_messages_missing"
    },
    {
      name: "omitted locator with missing trusted roles",
      draft: { ...signalJson(), matched_text: "You live in Berlin." },
      turn_messages: undefined,
      reason: "source_locator_required"
    },
    {
      name: "omitted locator with a trusted User source",
      draft: signalJson(),
      turn_messages: [{
        message_id: "user-1",
        role: "user" as const,
        content: "I moved to Paris."
      }],
      reason: "source_locator_required"
    }
  ])("fails formation audit closed for $name", ({ draft, turn_messages, reason }) => {
    const result = auditOfficialApiSignalFormation({
      raw_json: JSON.stringify({ signals: [draft] }),
      turn_content: COMBINED_TURN,
      ...(turn_messages === undefined ? {} : { turn_messages }),
      workspace_id: "workspace-role-trust",
      run_id: "run-role-trust",
      surface_id: null,
      created_at: "2026-07-21T00:00:00.000Z",
      source_observed_at: "2026-07-21T00:00:00.000Z",
      signal_id_for: () => "signal-audit"
    });

    expect(result.entries[0]).toMatchObject({
      disposition: "rejected",
      stage: "grounding",
      reason
    });
  });
});

function signalJson(): Record<string, unknown> {
  return {
    signal_kind: "potential_claim",
    object_kind: "activity",
    confidence: 0.9,
    matched_text: "I moved to Paris.",
    evidence_refs: [],
    source_memory_refs: []
  };
}

function providerFor(fields: Record<string, unknown>): OfficialApiGardenProvider {
  return new OfficialApiGardenProvider({
    apiKey: "sk-test",
    extractor: {
      extract: async () => ({
        rawJson: JSON.stringify({ signals: [{ ...signalJson(), ...fields }] })
      })
    },
    generateSignalId: () => "signal-role-trust"
  });
}
