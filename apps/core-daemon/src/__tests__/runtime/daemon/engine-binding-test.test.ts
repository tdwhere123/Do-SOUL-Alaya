import { expect, it } from "vitest";
import { createEngineBindingTester } from "../../../runtime/daemon/lifecycle/daemon-runtime-support.js";

it("does not report an unperformed connection probe as successful", async () => {
  await expect(createEngineBindingTester().testBinding({
    binding_id: "probe",
    provider: "openai",
    base_url: null,
    model: "fixture-model",
    api_key: "fixture-not-a-credential",
    config: {}
  })).rejects.toThrow("Connection testing is unavailable in this daemon; credentials have not been checked.");
});
