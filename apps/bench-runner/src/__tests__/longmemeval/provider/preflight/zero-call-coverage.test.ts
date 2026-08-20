import { describe, expect, it } from "vitest";
import { proveProviderZeroCallReplay } from
  "../../../../bench/provider/replay-proof.js";
import { loopRequest } from "../../diagnostic-loop/fixture.js";
import { MIMO } from "./complete-mimo-cache.js";

describe("provider zero-call request coverage", () => {
  it("rejects an empty requestedKeys set before proving physical_calls=0", async () => {
    await expect(proveProviderZeroCallReplay({
      request: loopRequest({
        requestedKeys: [],
        model: MIMO.id,
        requestProfile: MIMO.requestProfile
      })
    })).rejects.toThrow(/non-empty request key set/u);
  });
});
