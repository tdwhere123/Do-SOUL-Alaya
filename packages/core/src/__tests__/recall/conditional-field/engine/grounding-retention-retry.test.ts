import { describe, expect, it } from "vitest";
import { memoryProductStateKey, type SeedActivation, type Transition } from "@do-soul/alaya-protocol";
import { groundedOutputDerivations, type GroundingProgress } from "../../../../recall/conditional-field/engine/output-derivations.js";

const state = (object_id: string) => memoryProductStateKey({ workspace_id: "w", object_id,
  source_revision: "r", program_state: "accepting", hypothesis_id: "h", binding_context: "b", time_state: "as_of" });
const seed: SeedActivation = { schema_version: 1, state: state("a"), milligrades: 1000 };
const edge: Transition = { schema_version: 1, from: state("a"), to: state("b"), relation_kind: "p",
  strength_milligrades: 900, applicable: true, validity: { kind: "open", valid_from: "2026-01-01T00:00:00.000Z" } };

describe("grounding retention after memory refusal", () => {
  it.each(["rule", "seed"] as const)("retries a refused %s allocation without retaining phantom bytes", (kind) => {
    const input = { seeds: kind === "seed" ? [seed] : [], transitions: kind === "rule" ? [edge] : [],
      derivations: [], transition_derivations: {}, allowance: 1 };
    const admitted = groundedOutputDerivations({ ...input, memory_bytes: 100_000 });
    expect(admitted.progress.completed_steps).toBe(1);
    const refusedMemory = Math.floor(admitted.retained_bytes * 0.9);
    expect(admitted.retained_bytes).toBeGreaterThan(0);
    let progress: GroundingProgress | undefined;
    for (let retry = 0; retry < 4; retry += 1) {
      const refused = groundedOutputDerivations({ ...input, memory_bytes: refusedMemory, progress });
      expect(refused.complete).toBe(false);
      expect(refused.retained_bytes).toBe(0);
      expect(refused.admitted_bytes).toBe(0);
      expect(refused.progress.retained_bytes).toBe(0);
      expect(refused.progress.forest.size).toBe(0);
      expect(refused.progress.incoming.size).toBe(0);
      expect(refused.progress.completed_steps).toBe(0);
      progress = refused.progress;
    }
    const recovered = groundedOutputDerivations({ ...input, memory_bytes: 100_000, progress });
    expect(recovered.complete).toBe(admitted.complete);
    expect(recovered.retained_bytes).toBe(admitted.retained_bytes);
    expect(recovered.admitted_bytes).toBe(admitted.admitted_bytes);
    expect(recovered.progress.retained_bytes).toBe(admitted.progress.retained_bytes);
    expect(recovered.progress.completed_steps).toBe(admitted.progress.completed_steps);
    expect([...recovered.progress.forest]).toEqual([...admitted.progress.forest]);
    expect([...recovered.progress.root_map]).toEqual([...admitted.progress.root_map]);
  });

  it("separates a released owner from an equal-size replacement allocation", () => {
    const input = { seeds: [seed], transitions: [], derivations: [], transition_derivations: {} };
    const before = groundedOutputDerivations({ ...input, allowance: 1 });
    const changed = { ...input, seeds: [{ ...seed, state: state("b") }] };
    const released = groundedOutputDerivations({ ...changed, allowance: 0, progress: before.progress });
    expect(released.admitted_bytes).toBe(0);
    expect(released.retained_bytes).toBe(-before.progress.retained_bytes);
    expect(released.progress.retained_bytes).toBe(0);

    const rebuilt = groundedOutputDerivations({ ...changed, allowance: 1, progress: before.progress });
    expect(rebuilt.progress.retained_bytes).toBe(before.progress.retained_bytes);
    expect(rebuilt.retained_bytes).toBe(0);
    expect(rebuilt.admitted_bytes).toBe(rebuilt.progress.retained_bytes);
  });
});
