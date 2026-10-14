import { beforeAll, describe, expect, it } from "vitest";
import { withdrawDerivationLeaves, type FieldEngineState } from "../../../../recall/conditional-field/engine/field-engine.js";
import { coalesceQualifiedResults, finiteExpressionDenotation } from "../engine/qualified-expression.oracle.js";
import { extractQualifiedResults, projectQualifiedExpression } from "../engine/qualified-expression-native.fixture.js";
import { oracleStability, type OracleCompletion } from "../../conditional-field-oracle/completeness-oracle.js";
import { compatible, completeWorld, completionBits, entryIdentity, observeWorld, qualifiedIdentity,
  residualWorld, valueIdentity, type KnownRegions } from "./joint-residual-worlds.fixture.js";

type CompleteWorld = ReturnType<typeof completeWorld>;

function completionsOf(worlds: readonly CompleteWorld[]): OracleCompletion[] {
  return worlds.map(({ expected }) => ({ members: expected.map((row) => ({ id: qualifiedIdentity(row), grade: row.grade })),
    // The first differing short binding is a: Y precedes Z, before c and x are compared.
    claims: {}, order: [...expected].sort((a, b) => a.target.object_id.localeCompare(b.target.object_id)).map(qualifiedIdentity) }));
}

/** Check only claims the runtime actually emits; a loose/open answer is permitted. */
function checkClaims(state: FieldEngineState, worlds: readonly CompleteWorld[]) {
  if (worlds.length === 0) throw new Error("inconsistent completion domain");
  const index = projectQualifiedExpression(state);
  const entries = index.entries.map((entry) => entryIdentity(entry, state));
  const completions = completionsOf(worlds);
  const stability = oracleStability({ members: entries, claims: {}, order: entries }, completions);
  for (const entry of index.entries) {
    if (entry.guaranteed_milligrades === undefined) continue;
    const id = entryIdentity(entry, state);
    for (const world of completions) {
      const member = world.members.find((row) => row.id === id);
      expect(member, `delivered guaranteed member ${id}`).toBeDefined();
      expect(entry.guaranteed_milligrades).toBeLessThanOrEqual(member!.grade);
    }
  }
  if (index.completeness.logical_index === "complete" || index.completeness.logical_index === "exhausted_empty") {
    expect(stability.membership).toBe(true);
  }
  if (state.closure.requested_index === "complete") expect(stability.membership).toBe(true);
  if (index.order_status === "complete") expect(stability.order).toBe(true);
  if (index.order_status === "certified_prefix") {
    for (const world of completions) expect(world.order.slice(0, entries.length)).toEqual(entries);
  }
  if (state.binding.kind === "bound") {
    for (const value of state.binding.snapshot.values.filter((row) => row.accepting)) {
      const id = valueIdentity(value, state);
      for (const { expected } of worlds) {
        const member = expected.find((row) => qualifiedIdentity(row) === id);
        if (value.low_milligrades !== undefined) {
          expect(member, `guaranteed qualified member ${id}`).toBeDefined();
          expect(value.low_milligrades).toBeLessThanOrEqual(member!.grade);
          expect(value.cap_contract_id).toBe(member!.cap_contract_id);
        }
        if (member !== undefined && value.high_milligrades !== undefined) {
          expect(value.high_milligrades).toBeGreaterThanOrEqual(member.grade);
        }
      }
      if ((state.binding.possible_complete === false || state.closure.observation === "invalidated")
          && value.milligrades !== undefined) expect(value.high_milligrades).toBe(1000);
    }
  }
  return { index, entries, stability };
}

describe("joint residual completion worlds", () => {
  let worlds: CompleteWorld[];
  beforeAll(() => { worlds = completionBits().map((bits) => completeWorld(residualWorld(bits))); });

  it("executes every qualified AND world independently before comparing closure", () => {
    expect(worlds).toHaveLength(16);
    for (const completed of worlds) {
      expect(completed.actual).toEqual(completed.expected);
      const bits = completed.world.bits;
      expect(completed.actual).toHaveLength(bits.left && bits.right && bits.guard ? (bits.unseen ? 2 : 1) : 0);
      const checked = checkClaims(completed.state, [completed]);
      expect(checked.entries).toEqual(completionsOf([completed])[0]!.order);
      expect(completed.state.closure.requested_index).toBe("complete");
      // Typed hypothesis coverage remains open even when this declared finite interpretation is closed.
      expect(checked.index.completeness.interpretation_coverage).toBe("open");
    }
  });

  it("keeps joint relations, an unseen earlier member and an unknown guard open", () => {
    const full = worlds.find(({ world }) => Object.values(world.bits).every(Boolean))!;
    const stages: KnownRegions[] = [{}, { left: true }, { left: true, right: true },
      { left: true, right: true, guard: true }, { left: true, right: true, guard: true, unseen: true }];
    for (const known of stages) {
      const compatibleWorlds = worlds.filter(({ world }) => compatible(world.bits, known));
      const state = observeWorld(full.world, known);
      const checked = checkClaims(state, compatibleWorlds);
      if (compatibleWorlds.length > 1) {
        expect(checked.index.completeness.logical_index).not.toBe("complete");
        expect(checked.index.order_status).not.toBe("complete");
        expect(state.residuals.some((region) => region.status !== "exhausted")).toBe(true);
      } else expect(checked.entries).toEqual(completionsOf(compatibleWorlds)[0]!.order);
      if (known.guard === true && known.unseen === undefined) {
        expect(state.binding.kind).toBe("bound");
        expect(checked.index.entries.map((entry) => entry.object_id)).toEqual(["Z"]);
        // Physical A->B is lawful, but a=Y from unseen B precedes a=Z from known A.
        expect(checked.index.order_status).not.toBe("certified_prefix");
        expect(state.source_facts?.has("B")).toBe(false);
        const resumed = observeWorld(full.world, undefined, { resume: state });
        expect(resumed.source_facts?.has("B")).toBe(true);
        expect(coalesceQualifiedResults(extractQualifiedResults(resumed, full.world.origins))).toEqual(full.expected);
        expect(checkClaims(resumed, [full]).entries).toEqual(completionsOf([full])[0]!.order);
      }
    }
  });

  it("never assembles a witness from mutually exclusive premise worlds", () => {
    const exclusive = worlds.filter(({ world: { bits } }) => bits.left !== bits.right && bits.guard && !bits.unseen);
    expect(exclusive).toHaveLength(2);
    expect(exclusive.every(({ actual, expected }) => actual.length === 0 && expected.length === 0)).toBe(true);
    const state = observeWorld(residualWorld({ left: true, right: true, unseen: false, guard: true }),
      { unseen: false, guard: true });
    const checked = checkClaims(state, exclusive);
    expect(checked.entries).toEqual([]);
    // The finite restriction is oracle knowledge; native readers supplied no exclusivity certificate.
    expect(checked.index.completeness.logical_index).not.toBe("complete");
  });

  it("retains the three-premise residual even when every proper subset is empty", () => {
    const triples = Array.from({ length: 8 }, (_, mask) => completeWorld(residualWorld({ left: !!(mask & 1),
      right: !!(mask & 2), third: !!(mask & 4), unseen: false, guard: true })));
    for (const [mask, completed] of triples.entries()) {
      expect(completed.actual).toEqual(completed.expected);
      expect(completed.actual).toHaveLength(mask === 7 ? 1 : 0);
    }
    const full = triples[7]!;
    for (const known of [{ unseen: false, guard: true }, { unseen: false, guard: true, left: true },
      { unseen: false, guard: true, left: true, right: true }]) {
      const state = observeWorld(full.world, known);
      const checked = checkClaims(state, triples.filter(({ world }) => compatible(world.bits, known)));
      expect(checked.entries).toEqual([]);
      expect(checked.index.completeness.logical_index).not.toBe("complete");
      expect(checked.index.order_status).not.toBe("complete");
    }
  });

  it("preserves residual claims through actual work interruption and resumed observation", () => {
    const full = worlds.find(({ actual }) => actual.length === 2)!;
    const interrupted = observeWorld(full.world, undefined, { work: 180 });
    expect(interrupted.last_observer_status).toBe("interrupted");
    const checked = checkClaims(interrupted, [full]);
    expect(checked.index.completeness.logical_index).not.toBe("complete");
    expect(checked.index.order_status).not.toBe("complete");
    const resumed = observeWorld(full.world, undefined, { resume: interrupted });
    expect(coalesceQualifiedResults(extractQualifiedResults(resumed, full.world.origins))).toEqual(full.expected);
    expect(checkClaims(resumed, [full]).entries).toEqual(completionsOf([full])[0]!.order);
  });

  it("recomputes the completion population after support withdrawal", () => {
    const full = worlds.find(({ actual }) => actual.length === 2)!;
    const removed = "A-left";
    const changed = { ...full.world, nativeRows: full.world.nativeRows.filter((row) => row.assertionId !== removed),
      world: { ...full.world.world, rows: full.world.world.rows.filter((row) => row.id !== removed) } };
    const expected = finiteExpressionDenotation(changed.expression, changed.world).results;
    const fresh = completeWorld(changed);
    expect(fresh.expected).toEqual(expected);
    expect(expected.map((row) => row.target.object_id)).toEqual(["Y"]);
    const withdrawn = withdrawDerivationLeaves(full.state, removed);
    checkClaims(withdrawn, [fresh]);
    const resumed = observeWorld(changed, undefined, { resume: withdrawn });
    expect(coalesceQualifiedResults(extractQualifiedResults(resumed, changed.origins))).toEqual(expected);
    expect(checkClaims(resumed, [fresh]).entries).toEqual(completionsOf([fresh])[0]!.order);
  });

  it("does not treat an empty completion domain as a vacuous certificate", () => {
    expect(oracleStability({ members: [], claims: {}, order: [] }, [])).toEqual({ membership: false, claim: false, order: false });
    expect(() => checkClaims(worlds[0]!.state, [])).toThrow("inconsistent completion domain");
  });
});
