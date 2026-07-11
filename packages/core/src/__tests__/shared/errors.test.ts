import { describe, expect, it } from "vitest";
import { AlayaError } from "@do-soul/alaya-protocol";
import { CoreError } from "../../shared/errors.js";

describe("CoreError", () => {
  it("is an AlayaError with narrowed code", () => {
    const error = new CoreError("NOT_FOUND", "missing", { statusCode: 404 });

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(AlayaError);
    expect(error).toBeInstanceOf(CoreError);
    expect(error.code).toBe("NOT_FOUND");
    expect(error.statusCode).toBe(404);
    expect(error.name).toBe("CoreError");
  });
});
