import { describe, expect, it, vi } from "vitest";
import {
  indexObservationOffsets,
  lookupIndexedObservation
} from "../../../../recall/conditional-field/engine/field-retention-index.js";

describe("indexed observation lookup", () => {
  it("resolves exact and region-prefix ids without scanning the observation list", () => {
    const observations = Array.from({ length: 1000 }, (_value, index) => ({
      observation_id: `seed:${String(index)}`
    }));
    const offsets = indexObservationOffsets(observations);
    const rows = { at: (index: number) => observations[index] };
    const find = vi.spyOn(Array.prototype, "find");
    try {
      for (let index = 0; index < 1000; index += 1) {
        expect(lookupIndexedObservation(`seed:${String(index)}`, offsets, rows)?.observation_id)
          .toBe(`seed:${String(index)}`);
        expect(lookupIndexedObservation(`seed:${String(index)}:profile`, offsets, rows)?.observation_id)
          .toBe(`seed:${String(index)}`);
      }
      expect(find).not.toHaveBeenCalled();
    } finally {
      find.mockRestore();
    }
  });
});
