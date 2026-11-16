import { describe, expect, it } from "vitest";
import { isRequestBodyTooLargeError } from "../../routes/request-body-guard.js";

describe("isRequestBodyTooLargeError", () => {
  it.each([
    ["top-level numeric status 413", { status: 413 }, true],
    ["top-level numeric statusCode 413", { statusCode: 413 }, true],
    ["nested cause status 413", { cause: { status: 413 } }, true],
    ["nested cause statusCode 413", { cause: { cause: { statusCode: 413 } } }, true],
    ["status 413 wins over a non-413 statusCode", { status: 413, statusCode: 200 }, true],
    ["numeric status is preferred over statusCode", { status: 400, statusCode: 413 }, false],
    ["string status 413 is not numeric", { status: "413" }, false],
    ["plain object named BodyLimitError is not an Error", { name: "BodyLimitError" }, false],
    ["unrelated status", { status: 400 }, false],
    ["empty object", {}, false]
  ] as const)("classifies %s", (_title, error, expected) => {
    expect(isRequestBodyTooLargeError(error)).toBe(expected);
  });

  it("does not classify null, undefined, or non-object 413 sentinels", () => {
    expect(isRequestBodyTooLargeError(null)).toBe(false);
    expect(isRequestBodyTooLargeError(undefined)).toBe(false);
    expect(isRequestBodyTooLargeError("BodyLimitError")).toBe(false);
    expect(isRequestBodyTooLargeError(413)).toBe(false);
  });

  it("classifies an Error named BodyLimitError", () => {
    expect(isRequestBodyTooLargeError(namedError("BodyLimitError"))).toBe(true);
  });

  it("classifies a nested Error named BodyLimitError", () => {
    expect(isRequestBodyTooLargeError({ cause: { cause: namedError("BodyLimitError") } })).toBe(true);
  });

  it("classifies BodyLimitError even when a nested status is not 413", () => {
    const error = namedError("BodyLimitError") as Error & { status: number };
    error.status = 400;
    expect(isRequestBodyTooLargeError({ cause: error })).toBe(true);
  });

  it("does not classify an ordinary Error", () => {
    expect(isRequestBodyTooLargeError(new Error("request failed"))).toBe(false);
  });
});

function namedError(name: string): Error {
  const error = new Error("body limited");
  error.name = name;
  return error;
}
