import { describe, expect, it } from "vitest";
import { shouldEnableE2eEventTriggers } from "../../runtime/daemon-app-composition.js";

describe("shouldEnableE2eEventTriggers", () => {
  it("enables the test routes only outside production when explicitly requested", () => {
    expect(
      shouldEnableE2eEventTriggers({
        NODE_ENV: "development",
        ALAYA_ENABLE_E2E_EVENT_TRIGGERS: "1"
      })
    ).toBe(true);
    expect(
      shouldEnableE2eEventTriggers({
        NODE_ENV: "production",
        ALAYA_ENABLE_E2E_EVENT_TRIGGERS: "1"
      })
    ).toBe(false);
    expect(
      shouldEnableE2eEventTriggers({
        NODE_ENV: "development",
        ALAYA_ENABLE_E2E_EVENT_TRIGGERS: "0"
      })
    ).toBe(false);
  });
});
