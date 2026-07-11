import { describe, expect, it } from "vitest";
import { AlayaError } from "@do-soul/alaya-protocol";
import { StorageError } from "../../shared/errors.js";

describe("StorageError", () => {
  it("is an AlayaError", () => {
    const error = new StorageError("QUERY_FAILED", "Failed to query.");

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(AlayaError);
    expect(error).toBeInstanceOf(StorageError);
    expect(error.code).toBe("QUERY_FAILED");
    expect(error.name).toBe("StorageError");
  });

  it("accepts standard ErrorOptions cause like CoreError", () => {
    const cause = new Error("sqlite failed");
    const error = new StorageError("QUERY_FAILED", "Failed to query.", { cause });

    expect(error).toBeInstanceOf(StorageError);
    expect(error.cause).toBe(cause);
  });

  it("preserves the legacy third-argument cause shape", () => {
    const cause = new Error("sqlite failed");
    const error = new StorageError("QUERY_FAILED", "Failed to query.", cause);

    expect(error.cause).toBe(cause);
  });
});
