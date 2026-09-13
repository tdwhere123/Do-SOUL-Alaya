import { describe, expect, it } from "vitest";
import * as core from "../../index.js";

describe("core package root barrel", () => {
  it("does not export retired finite-field and query-probe recall shapes", () => {
    expect(core).not.toHaveProperty("createRecallFiniteFieldSeal");
    expect(core).not.toHaveProperty("verifyRecallFiniteFieldSeal");
    expect(core).not.toHaveProperty("RECALL_RETRIEVAL_FIELD_CHANNEL_CATALOG_V1");
    expect(core).not.toHaveProperty("compileRecallQueryProbes");
    expect(core).not.toHaveProperty("RuleBasedEntityExtractor");
    expect(core).toHaveProperty("digestRecallFieldIdentity");
    expect(core).toHaveProperty("captureRecallQueryFactFrames");
    expect(core).toHaveProperty("RuleBasedQueryFactFrameExtractor");
  });
});
