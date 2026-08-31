import { describe, expect, it } from "vitest";
import { readOfficialApiKindProjectionDraft } from
  "../../../../garden/ingestion/official-api/kind-projection-draft.js";

describe("official API kind projection draft", () => {
  it("accepts a single source-named kind", () => {
    expect(readOfficialApiKindProjectionDraft({
      factor_id: "spotify",
      kind_values: ["Music Streaming Service"]
    })).toEqual({
      factor_id: "spotify",
      kind_values: ["music streaming service"]
    });
  });

  it("drops a malformed draft without throwing", () => {
    expect(readOfficialApiKindProjectionDraft({ factor_id: "spotify" })).toBeUndefined();
    expect(readOfficialApiKindProjectionDraft({
      factor_id: "spotify",
      kind_values: ["a", "b", "c"]
    })).toBeUndefined();
  });
});
