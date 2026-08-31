import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { MemoryEntry } from "@do-soul/alaya-protocol";
import {
  installCoreConfigFromProcessEnv,
  resetCoreConfigForTests
} from "../../runtime/config/index.js";
import { compileRecallQueryProbes } from "../../recall/query/recall-query-probes.js";
import { scorePreferenceProfileAlignment } from "../../recall/scoring/preference-fusion-scoring.js";
import { createMemoryEntry } from "./recall-service-test-fixtures.js";

const PREFERENCE_QUERY = compileRecallQueryProbes("what coffee do I prefer?");

beforeAll(() => {
  resetCoreConfigForTests();
  installCoreConfigFromProcessEnv({
    ALAYA_RECALL_PROJECTIONS: "on"
  });
});

afterAll(() => {
  resetCoreConfigForTests();
});

describe("scorePreferenceProfileAlignment", () => {
  it.each([
    ["a subject-only profile", { preference_subject: "operator" }],
    ["a generic subject, predicate, and polarity-only profile", {
      preference_subject: "operator",
      preference_predicate: "prefer",
      preference_polarity: "positive" as const
    }],
    ["an unrelated positive profile", {
      preference_subject: "operator",
      preference_predicate: "prefer",
      preference_object: "dark mode",
      preference_category: "theme",
      preference_polarity: "positive" as const
    }]
  ])("returns zero for %s", (_label, profile) => {
    expect(scorePreferenceProfileAlignment(
      createMemoryEntry({ dimension: "preference", ...profile }),
      PREFERENCE_QUERY
    )).toBe(0);
  });

  it.each(["fact", "episode", "constraint"] satisfies readonly MemoryEntry["dimension"][])
    ("scores a verified Garden profile carried by a %s memory", (dimension) => {
      expect(scorePreferenceProfileAlignment(
        createMemoryEntry({
          dimension,
          source_kind: "compiler",
          formation_kind: "extracted",
          preference_subject: "operator",
          preference_predicate: "prefer",
          preference_object: "coffee",
          preference_category: "drink",
          preference_polarity: "positive"
        }),
        PREFERENCE_QUERY
      )).toBeGreaterThan(0);
    });

  it.each([
    ["model-tool inference", "compiler", "inferred"],
    ["model-tool derivation", "compiler", "derived"],
    ["import", "import", "imported"]
  ] satisfies readonly [
    string,
    MemoryEntry["source_kind"],
    MemoryEntry["formation_kind"]
  ][])("does not score an untrusted %s profile owner", (_label, sourceKind, formationKind) => {
    expect(scorePreferenceProfileAlignment(
      createMemoryEntry({
        dimension: "fact",
        source_kind: sourceKind,
        formation_kind: formationKind,
        preference_subject: "operator",
        preference_predicate: "prefer",
        preference_object: "coffee",
        preference_category: "drink",
        preference_polarity: "positive"
      }),
      PREFERENCE_QUERY
    )).toBe(0);
  });

  it.each([
    ["model-tool inference", "compiler", "inferred"],
    ["model-tool derivation", "compiler", "derived"],
    ["import", "import", "imported"]
  ] satisfies readonly [
    string,
    MemoryEntry["source_kind"],
    MemoryEntry["formation_kind"]
  ][])("does not score an untrusted %s preference owner", (_label, sourceKind, formationKind) => {
    expect(scorePreferenceProfileAlignment(
      createMemoryEntry({
        dimension: "preference",
        source_kind: sourceKind,
        formation_kind: formationKind,
        preference_subject: "operator",
        preference_predicate: "prefer",
        preference_object: "coffee",
        preference_category: "drink",
        preference_polarity: "positive"
      }),
      PREFERENCE_QUERY
    )).toBe(0);
  });

  it("scores an explicit seeded preference owner", () => {
    expect(scorePreferenceProfileAlignment(
      createMemoryEntry({
        dimension: "preference",
        source_kind: "seed",
        formation_kind: "explicit",
        preference_subject: "operator",
        preference_predicate: "prefer",
        preference_object: "coffee",
        preference_category: "drink",
        preference_polarity: "positive"
      }),
      PREFERENCE_QUERY
    )).toBeGreaterThan(0);
  });

  it("scores an explicit User preference owner", () => {
    expect(scorePreferenceProfileAlignment(
      createMemoryEntry({
        dimension: "preference",
        source_kind: "user",
        formation_kind: "explicit",
        preference_subject: "operator",
        preference_predicate: "prefer",
        preference_object: "coffee",
        preference_category: "drink",
        preference_polarity: "positive"
      }),
      PREFERENCE_QUERY
    )).toBeGreaterThan(0);
  });

  it("gives a profile score only to the discriminative same-polarity profile", () => {
    const relevant = preferenceOwner("memory-coffee", "constraint", "coffee", "drink");
    const unrelated = [
      preferenceOwner("memory-tea", "fact", "tea", "drink"),
      preferenceOwner("memory-theme", "episode", "dark mode", "theme"),
      preferenceOwner("memory-seat", "constraint", "window seat", "travel")
    ];

    expect(scorePreferenceProfileAlignment(relevant, PREFERENCE_QUERY)).toBeGreaterThan(0);
    expect(unrelated.map((entry) =>
      scorePreferenceProfileAlignment(entry, PREFERENCE_QUERY)
    )).toEqual([0, 0, 0]);
  });

  it("keeps mixed preference-update alignment discriminative", () => {
    const relevant = preferenceOwner("memory-current-coffee", "constraint", "coffee", "drink");
    const unrelatedProfile = preferenceOwner("memory-current-theme", "fact", "dark mode", "theme");
    const query = compileRecallQueryProbes("what coffee do I prefer now?");

    expect(scorePreferenceProfileAlignment(relevant, query)).toBeGreaterThan(0);
    expect(scorePreferenceProfileAlignment(unrelatedProfile, query)).toBe(0);
  });
});

function preferenceOwner(
  objectId: string,
  dimension: MemoryEntry["dimension"],
  preferenceObject: string,
  preferenceCategory: string
): MemoryEntry {
  return createMemoryEntry({
    object_id: objectId,
    dimension,
    content: `I prefer ${preferenceObject}.`,
    source_kind: "compiler",
    formation_kind: "extracted",
    preference_subject: "operator",
    preference_predicate: "prefer",
    preference_object: preferenceObject,
    preference_category: preferenceCategory,
    preference_polarity: "positive"
  });
}
