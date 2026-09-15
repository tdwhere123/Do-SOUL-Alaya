import {
  BoundedJsonObjectSchema
} from "@do-soul/alaya-protocol";
import { describe, expect, it } from "vitest";
import { OfficialApiGardenProvider } from "../../../garden/ingestion/compute-provider.js";
import { buildOfficialApiSourceCorpus } from
  "../../../garden/triage/grounding/source-locator.js";
import {
  createContext,
  createExtractor
} from "./compute-provider-fixtures.js";

describe("OfficialApiGardenProvider verified assertion receipt", () => {
  it("preserves a long source through a bounded verified assertion receipt", async () => {
    const assertion = "I use the cobalt release channel for production deployments.";
    const messages = [
      {
        message_id: "user-long-source",
        role: "user" as const,
        content: assertion,
        created_at: "2026-08-09T00:00:00.000Z"
      },
      {
        message_id: "assistant-long-source",
        role: "assistant" as const,
        content: "Background diagnostics. ".repeat(900),
        created_at: "2026-08-09T00:00:01.000Z"
      }
    ];
    expect(buildOfficialApiSourceCorpus(assertion, messages).length).toBeGreaterThan(16_384);
    const provider = new OfficialApiGardenProvider({
      apiKey: "sk-test",
      extractor: createExtractor(JSON.stringify({
        interpretations: [{ assertion_id: 1, relations: [
          { predicate: { text: "use" }, arguments: [], qualifiers: [] }
        ] }]
      })),
      generateSignalId: () => "signal-long-source"
    });

    const [signal] = await provider.compile(assertion, {
      ...createContext(),
      turn_messages: messages
    });

    expect(signal?.interpretation_contract).toBe("source-interpretation-v1");
    expect(signal?.object_kind).toBeNull();
    expect(signal?.confidence).toBeNull();
    expect(BoundedJsonObjectSchema.safeParse(signal?.raw_payload).success).toBe(true);
  });
});
