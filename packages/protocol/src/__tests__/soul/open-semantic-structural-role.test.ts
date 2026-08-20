import { describe, expect, it } from "vitest";
import {
  classifyOpenSemanticStructuralRole,
  classifyQueryObligationStructuralRole,
  isOpenSemanticStructuralRole,
  OPEN_SEMANTIC_DURATION_ROLE,
  OPEN_SEMANTIC_LOCATION_ROLE
} from "../../soul/open-semantic-structural-role.js";

describe("open semantic structural role owner", () => {
  it.each([
    ["duration", OPEN_SEMANTIC_DURATION_ROLE],
    ["Duration", OPEN_SEMANTIC_DURATION_ROLE],
    ["时长", OPEN_SEMANTIC_DURATION_ROLE],
    ["持续时间", OPEN_SEMANTIC_DURATION_ROLE],
    ["location", OPEN_SEMANTIC_LOCATION_ROLE],
    ["PLACE", OPEN_SEMANTIC_LOCATION_ROLE],
    ["地点", OPEN_SEMANTIC_LOCATION_ROLE],
    ["位置", OPEN_SEMANTIC_LOCATION_ROLE]
  ] as const)("classifies %s as %s", (alias, role) => {
    expect(classifyOpenSemanticStructuralRole(alias)).toBe(role);
    expect(isOpenSemanticStructuralRole(alias, role)).toBe(true);
  });

  it.each([
    ["How long", OPEN_SEMANTIC_DURATION_ROLE],
    ["多久", OPEN_SEMANTIC_DURATION_ROLE],
    ["多长时间", OPEN_SEMANTIC_DURATION_ROLE],
    ["Where", OPEN_SEMANTIC_LOCATION_ROLE],
    ["哪里", OPEN_SEMANTIC_LOCATION_ROLE],
    ["何处", OPEN_SEMANTIC_LOCATION_ROLE],
    ["哪儿", OPEN_SEMANTIC_LOCATION_ROLE]
  ] as const)("maps obligation value %s to %s", (surface, role) => {
    expect(classifyQueryObligationStructuralRole(surface)).toBe(role);
  });

  it.each([
    "What",
    "How many hours",
    "time",
    "object",
    "hour",
    "minute",
    "45",
    "target",
    "Target",
    "旧金山",
    "subject"
  ] as const)("does not treat %s as a structural role", (surface) => {
    expect(classifyOpenSemanticStructuralRole(surface)).toBeNull();
    expect(classifyQueryObligationStructuralRole(surface)).toBeNull();
    expect(isOpenSemanticStructuralRole(surface, OPEN_SEMANTIC_DURATION_ROLE)).toBe(false);
    expect(isOpenSemanticStructuralRole(surface, OPEN_SEMANTIC_LOCATION_ROLE)).toBe(false);
  });
});
