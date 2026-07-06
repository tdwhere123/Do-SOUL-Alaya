import { describe, expect, it } from "vitest";
import { deriveKarmaFieldUpdates } from "../../dynamics/dynamics-service-ports.js";
import { createKarmaEvent, createMemoryEntry } from "./karma-fixtures.js";

describe("deriveKarmaFieldUpdates", () => {
  it("records supersede_penalty superseded_by as the replacing memory, not the penalized target", () => {
    const memory = createMemoryEntry({ object_id: "memory-existing" });
    const event = createKarmaEvent({
      kind: "supersede_penalty",
      object_id: "memory-existing",
      amount: -0.2
    });

    const updates = deriveKarmaFieldUpdates(memory, event, {
      supersedingObjectId: "memory-new"
    });

    expect(updates.superseded_by).toBe("memory-new");
    expect(updates.contradiction_count).toBe(1);
  });

  it("does not write superseded_by when superseding id equals the penalized target", () => {
    const memory = createMemoryEntry({ object_id: "memory-existing" });
    const event = createKarmaEvent({
      kind: "supersede_penalty",
      object_id: "memory-existing",
      amount: -0.2
    });

    const updates = deriveKarmaFieldUpdates(memory, event, {
      supersedingObjectId: "memory-existing"
    });

    expect(updates.superseded_by).toBeUndefined();
  });
});
