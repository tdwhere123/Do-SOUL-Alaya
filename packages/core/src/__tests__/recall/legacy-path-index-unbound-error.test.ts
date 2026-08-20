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

  it("classifies a missing historical projection generation as unbound, not a storage fault", () => {
    const liveName = "TemporalProjectionGenerationMissingError";
    const missing = new Error(
      "No verified temporal projection exists for as-of 2023-05-30T23:40:00.000Z; rebuild it before recall."
    );
    missing.name = liveName;
    const reconstructed = new Error(missing.message);
    reconstructed.name = liveName;
    expect(classifyPathIndexReadFailure(missing)).toBe("index_unbound");
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
