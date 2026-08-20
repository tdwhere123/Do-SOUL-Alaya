import { describe, expect, it } from "vitest";
import {
  OPEN_SEMANTIC_FACTOR_ACTIVATION_STATES,
  OpenSemanticFactorActivationStateSchema
} from "../../soul/open-semantic-factor-activation-state.js";

describe("open semantic factor activation state", () => {
  it.each(OPEN_SEMANTIC_FACTOR_ACTIVATION_STATES)(
    "accepts the protocol state %s",
    (state) => {
      expect(OpenSemanticFactorActivationStateSchema.parse(state)).toBe(state);
    }
  );

  it.each(["inferred", "unknown", "observed "] as const)(
    "rejects the unknown state %s",
    (state) => {
      expect(OpenSemanticFactorActivationStateSchema.safeParse(state).success).toBe(false);
    }
  );
});
