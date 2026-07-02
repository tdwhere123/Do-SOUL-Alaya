import { describe, expect, it } from "vitest";
import { buildMemoryInput } from "../../garden/materialization-router/inputs.js";
import { createSignal } from "./materialization-router-fixture.js";

// Write-side producer for the entity-graph recall key: buildMemoryInput threads
// the signal's canonical_entities onto the materialized memory_entry. It prefers
// the first-class signal field and falls back to the raw_payload echo (the bench
// seed path round-trips raw_payload, not the first-class field).

describe("buildMemoryInput canonical_entities producer", () => {
  it("threads the first-class signal field onto the memory input", () => {
    const input = buildMemoryInput(createSignal({ canonical_entities: ["alice", "postgresql"] }), []);
    expect(input.canonical_entities).toEqual(["alice", "postgresql"]);
  });

  it("normalizes (lowercase + dedupe + cap 3) the first-class field", () => {
    const input = buildMemoryInput(
      createSignal({ canonical_entities: ["Alice", "alice", "Postgres", "Acme", "Redis"] }),
      []
    );
    expect(input.canonical_entities).toEqual(["alice", "postgres", "acme"]);
  });

  it("falls back to the raw_payload echo when the first-class field is absent", () => {
    const input = buildMemoryInput(createSignal({ raw_payload: { canonical_entities: ["Bob", "bob", "Mongo"] } }), []);
    expect(input.canonical_entities).toEqual(["bob", "mongo"]);
  });

  it("prefers the first-class field over the raw_payload echo", () => {
    const input = buildMemoryInput(
      createSignal({ canonical_entities: ["alice"], raw_payload: { canonical_entities: ["bob"] } }),
      []
    );
    expect(input.canonical_entities).toEqual(["alice"]);
  });

  it("emits no canonical_entities key when neither source is present (byte-identical to flat)", () => {
    const input = buildMemoryInput(createSignal({ raw_payload: {} }), []);
    expect("canonical_entities" in input).toBe(false);
  });

  it("emits no canonical_entities key when the raw_payload echo is not an array", () => {
    const input = buildMemoryInput(createSignal({ raw_payload: { canonical_entities: "alice" } }), []);
    expect("canonical_entities" in input).toBe(false);
  });
});
