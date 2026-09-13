import { describe, expect, it } from "vitest";
import { shouldEnableE2eEventTriggers } from "../../../runtime/daemon/wiring/daemon-app-composition.js";

describe("shouldEnableE2eEventTriggers", () => {
  it("enables only with the explicit switch and never in production", () => {
    expect(
      shouldEnableE2eEventTriggers({
        NODE_ENV: "test",
        ALAYA_ENABLE_E2E_EVENT_TRIGGERS: "1"
      })
    ).toBe(true);
    expect(
      shouldEnableE2eEventTriggers({
        NODE_ENV: "e2e",
        ALAYA_ENABLE_E2E_EVENT_TRIGGERS: "1"
      })
    ).toBe(true);
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
        NODE_ENV: "test",
        ALAYA_ENABLE_E2E_EVENT_TRIGGERS: "0"
      })
    ).toBe(false);
  });
});
