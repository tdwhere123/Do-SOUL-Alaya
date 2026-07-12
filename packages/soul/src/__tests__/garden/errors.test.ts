import { describe, expect, it } from "vitest";
import { AlayaError } from "@do-soul/alaya-protocol";
import { GardenProviderError } from "../../garden/compute-provider.js";
import { MaterializationPartialFailureError } from "../../garden/materialization-router/materialization-results.js";
import { SignalExtractorError } from "../../garden/pi-mono-errors.js";
import { WallClockTimeoutError } from "../../garden/wall-clock-timeout.js";

describe("garden leaf errors", () => {
  it("GardenProviderError extends AlayaError with kind as code", () => {
    const error = new GardenProviderError("upstream failed", "network");

    expect(error).toBeInstanceOf(AlayaError);
    expect(error).toBeInstanceOf(GardenProviderError);
    expect(error.code).toBe("network");
    expect(error.kind).toBe("network");
  });

  it("SignalExtractorError extends AlayaError with kind as code", () => {
    const error = new SignalExtractorError("timeout", "timed out");

    expect(error).toBeInstanceOf(AlayaError);
    expect(error.code).toBe("timeout");
    expect(error.kind).toBe("timeout");
  });

  it("MaterializationPartialFailureError extends AlayaError", () => {
    const error = new MaterializationPartialFailureError("partial", []);

    expect(error).toBeInstanceOf(AlayaError);
    expect(error.code).toBe("MATERIALIZATION_PARTIAL_FAILURE");
  });

  it("WallClockTimeoutError extends AlayaError", () => {
    const error = new WallClockTimeoutError(1_000, 1_100, "wall_clock");

    expect(error).toBeInstanceOf(AlayaError);
    expect(error.code).toBe("WALL_CLOCK_TIMEOUT");
  });
});
