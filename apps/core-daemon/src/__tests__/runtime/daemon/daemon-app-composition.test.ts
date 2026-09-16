import { describe, expect, it } from "vitest";
import { shouldEnableE2eEventTriggers } from "../../../runtime/daemon/wiring/daemon-app-composition.js";

describe("shouldEnableE2eEventTriggers", () => {
  it("enables only in NODE_ENV=test with the switch and a dedicated token", () => {
    expect(
      shouldEnableE2eEventTriggers({
        NODE_ENV: "test",
        ALAYA_ENABLE_E2E_EVENT_TRIGGERS: "1",
        ALAYA_E2E_EVENT_TRIGGER_TOKEN: "e2e-token"
      })
    ).toBe(true);
    expect(
      shouldEnableE2eEventTriggers({
        NODE_ENV: "test",
        ALAYA_ENABLE_E2E_EVENT_TRIGGERS: "1"
      })
    ).toBe(false);
    expect(
      shouldEnableE2eEventTriggers({
        NODE_ENV: "e2e",
        ALAYA_ENABLE_E2E_EVENT_TRIGGERS: "1",
        ALAYA_E2E_EVENT_TRIGGER_TOKEN: "e2e-token"
      })
    ).toBe(false);
    expect(
      shouldEnableE2eEventTriggers({
        NODE_ENV: "development",
        ALAYA_ENABLE_E2E_EVENT_TRIGGERS: "1",
        ALAYA_E2E_EVENT_TRIGGER_TOKEN: "e2e-token"
      })
    ).toBe(false);
    expect(
      shouldEnableE2eEventTriggers({
        NODE_ENV: "production",
        ALAYA_ENABLE_E2E_EVENT_TRIGGERS: "1",
        ALAYA_E2E_EVENT_TRIGGER_TOKEN: "e2e-token"
      })
    ).toBe(false);
    expect(
      shouldEnableE2eEventTriggers({
        NODE_ENV: "test",
        ALAYA_ENABLE_E2E_EVENT_TRIGGERS: "0",
        ALAYA_E2E_EVENT_TRIGGER_TOKEN: "e2e-token"
      })
    ).toBe(false);
    expect(
      shouldEnableE2eEventTriggers({
        NODE_ENV: "test",
        ALAYA_ENABLE_E2E_EVENT_TRIGGERS: "on",
        ALAYA_E2E_EVENT_TRIGGER_TOKEN: "e2e-token"
      })
    ).toBe(true);
    expect(
      shouldEnableE2eEventTriggers({
        NODE_ENV: "test",
        ALAYA_ENABLE_E2E_EVENT_TRIGGERS: "on"
      })
    ).toBe(false);
  });
});
