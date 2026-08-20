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

export const CJK_INTERROGATIVE_RESULT_FORMS = Object.freeze([
  ...CJK_COPULAR_MEASURE_FORMS,
  ...CJK_LOCATION_RESULT_FORMS
]);

export const CJK_INTERROGATIVE_FALLBACK_ATOMS: readonly string[] = Object.freeze(
  [
    ...CJK_INTERROGATIVE_RESULT_FORMS,
    ...CJK_COPULAR_PREDICATE_FORMS,
    CJK_LOCATIVE_LINKER_FORM
  ].slice().sort((left, right) => right.length - left.length || left.localeCompare(right))
);

function cjkWhSurfaces(surfaces: readonly string[]): readonly string[] {
  return Object.freeze(surfaces.filter((surface) => /\p{Script=Han}/u.test(surface)));
}
