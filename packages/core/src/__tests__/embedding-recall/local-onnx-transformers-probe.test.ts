import { describe, expect, it } from "vitest";
import {
  isLocalOnnxTransformersModuleNotFound,
  localOnnxTransformersMissingCode,
  probeLocalOnnxTransformersPackage
} from "../../embedding-recall/local-onnx.js";

function moduleNotFound(code: string): Error {
  const error = new Error("Cannot find package");
  (error as { code?: string }).code = code;
  return error;
}

describe("local ONNX transformers package probe", () => {
  it("treats ERR_MODULE_NOT_FOUND and MODULE_NOT_FOUND as the same packaging miss", () => {
    expect(isLocalOnnxTransformersModuleNotFound(moduleNotFound("ERR_MODULE_NOT_FOUND"))).toBe(true);
    expect(isLocalOnnxTransformersModuleNotFound(moduleNotFound("MODULE_NOT_FOUND"))).toBe(true);
    expect(localOnnxTransformersMissingCode(moduleNotFound("MODULE_NOT_FOUND")))
      .toBe("ERR_MODULE_NOT_FOUND");
    expect(isLocalOnnxTransformersModuleNotFound(new Error("model artifact missing"))).toBe(false);
  });

  it("reports unavailable for ERR_MODULE_NOT_FOUND instead of pretending the extra loaded", () => {
    expect(probeLocalOnnxTransformersPackage(() => {
      throw moduleNotFound("ERR_MODULE_NOT_FOUND");
    })).toEqual({
      availability: "unavailable",
      code: "ERR_MODULE_NOT_FOUND"
    });
  });

  it("reports available when the extra specifier resolves", () => {
    expect(probeLocalOnnxTransformersPackage(() => "/resolved/@huggingface/transformers"))
      .toEqual({ availability: "available" });
  });
});
