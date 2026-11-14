import { describe, expect, it } from "vitest";
import { assessStartupReadiness } from "../../runtime/daemon/support/startup-readiness.js";
import { assessGardenPassHealth } from "../../cli/doctor/doctor.js";
import { GARDEN_SCHEDULER_INTERVAL_MS } from "../../garden/runtime/runtime-background-services.js";

describe("required startup readiness", () => {
  it("requires each runtime phase and preserves observed order and duplicates", () => {
    expect(assessStartupReadiness([])).toEqual({
      ready: false, completed_steps: [],
      missing_steps: ["database", "repositories", "core-services", "garden-runtime", "mcp-tooling", "http-app"]
    });
    expect(assessStartupReadiness([
      { step: "database", completedAt: "irrelevant" },
      { step: "database", completedAt: "irrelevant" },
      { step: "http-app", completedAt: "irrelevant" }
    ])).toEqual({
      ready: false, completed_steps: ["database", "database", "http-app"],
      missing_steps: ["repositories", "core-services", "garden-runtime", "mcp-tooling"]
    });
    expect(assessStartupReadiness([
      { step: "database", completedAt: "" }, { step: "repositories", completedAt: "" },
      { step: "core-services", completedAt: "" }, { step: "garden-runtime", completedAt: "" },
      { step: "mcp-tooling", completedAt: "" }, { step: "http-app", completedAt: "" }
    ]).ready).toBe(true);
  });
});

describe("runtime cadence versus Doctor tolerance", () => {
  it("keeps the runtime cadence at one minute", () => expect(GARDEN_SCHEDULER_INTERVAL_MS).toBe(60000));
  it.each([
    [119999, "healthy"], [120000, "healthy"], [120001, "degraded"]
  ] as const)("classifies a pass %dms old as %s", (age, status) => {
    expect(assessGardenPassHealth("2026-11-13T00:00:00.000Z", Date.parse("2026-11-13T00:00:00.000Z") + age)).toBe(status);
  });
  it("keeps missing and invalid observations degraded", () => {
    expect(assessGardenPassHealth(null, 0)).toBe("degraded");
    expect(assessGardenPassHealth("invalid", 0)).toBe("degraded");
  });
});
