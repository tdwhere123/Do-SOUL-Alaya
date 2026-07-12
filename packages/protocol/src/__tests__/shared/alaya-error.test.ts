import { describe, expect, it } from "vitest";
import { AlayaError, EngineError } from "../../index.js";

describe("AlayaError", () => {
  it("exposes code and optional statusCode", () => {
    const error = new AlayaError("TEST", "boom", { statusCode: 400 });

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(AlayaError);
    expect(error.code).toBe("TEST");
    expect(error.statusCode).toBe(400);
    expect(error.name).toBe("AlayaError");
  });

  it("EngineError is an AlayaError with kind as code", () => {
    const error = new EngineError("upstream failed", "network");

    expect(error).toBeInstanceOf(AlayaError);
    expect(error).toBeInstanceOf(EngineError);
    expect(error.code).toBe("network");
    expect(error.kind).toBe("network");
    expect(error.name).toBe("EngineError");
  });
});
