import { describe, expect, it } from "vitest";
import {
  classifyPathIndexReadFailure,
  isLegacyPathIndexUnboundError,
  LegacyPathIndexUnboundError
} from "../../recall/runtime/legacy-path-index-unbound-error.js";

describe("legacy path index unbound error", () => {
  it("classifies a live instance and a name-only reconstruction as unbound", () => {
    const live = new LegacyPathIndexUnboundError();
    const reconstructed = new Error(live.message);
    reconstructed.name = "LegacyPathIndexUnboundError";
    expect(isLegacyPathIndexUnboundError(live)).toBe(true);
    expect(isLegacyPathIndexUnboundError(reconstructed)).toBe(true);
    expect(classifyPathIndexReadFailure(live)).toBe("index_unbound");
    expect(classifyPathIndexReadFailure(reconstructed)).toBe("index_unbound");
  });

  it("classifies storage and sqlite faults separately from an unbound index", () => {
    const storage = new Error("Failed to inspect relation projection population.");
    storage.name = "StorageError";
    const sqlite = new Error("database disk image is malformed");
    sqlite.name = "SqliteError";
    expect(classifyPathIndexReadFailure(storage)).toBe("storage_fault");
    expect(classifyPathIndexReadFailure(sqlite)).toBe("storage_fault");
    expect(classifyPathIndexReadFailure(new Error("recall read worker path.findByAnchors timed out after 8000ms")))
      .toBe("storage_fault");
  });
});
