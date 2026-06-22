import { describe, expect, it } from "vitest";
import { SignalExtractorError } from "../../garden/pi-mono-errors.js";

describe("SignalExtractorError", () => {
  it("carries kind and message and defaults retry metadata", () => {
    const error = new SignalExtractorError("timeout", "extractor timed out");

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("SignalExtractorError");
    expect(error.kind).toBe("timeout");
    expect(error.message).toBe("extractor timed out");
    expect(error.retryCount).toBe(0);
    expect(error.retryClassification).toBe("failure_max_retries");
  });

  it("preserves provided retry metadata and cause", () => {
    const cause = new Error("root");
    const error = new SignalExtractorError("transport_failure", "boom", {
      cause,
      retryCount: 3,
      retryClassification: "failure_aborted"
    });

    expect(error.kind).toBe("transport_failure");
    expect(error.retryCount).toBe(3);
    expect(error.retryClassification).toBe("failure_aborted");
    expect(error.cause).toBe(cause);
  });

  it("accepts each terminal extractor kind", () => {
    for (const kind of ["timeout", "transport_failure", "invalid_json"] as const) {
      expect(new SignalExtractorError(kind, "x").kind).toBe(kind);
    }
  });
});
