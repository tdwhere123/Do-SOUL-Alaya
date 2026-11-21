import {
  OPEN_SEMANTIC_DURATION_WH_SURFACES,
  OPEN_SEMANTIC_LOCATION_WH_SURFACES
} from "@do-soul/alaya-protocol";

export const CJK_COPULAR_MEASURE_FORMS = cjkWhSurfaces(
  OPEN_SEMANTIC_DURATION_WH_SURFACES
);
export const CJK_LOCATION_RESULT_FORMS = cjkWhSurfaces(
  OPEN_SEMANTIC_LOCATION_WH_SURFACES
);
export const CJK_COPULAR_PREDICATE_FORMS = ["要", "是"] as const;
export const CJK_LOCATIVE_LINKER_FORM = "在" as const;

function cjkWhSurfaces(surfaces: readonly string[]): readonly string[] {
  return Object.freeze(surfaces.filter((surface) => /\p{Script=Han}/u.test(surface)));
}
