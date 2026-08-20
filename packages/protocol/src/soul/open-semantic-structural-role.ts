export const OPEN_SEMANTIC_DURATION_ROLE = "duration" as const;
export const OPEN_SEMANTIC_LOCATION_ROLE = "location" as const;

export const OPEN_SEMANTIC_STRUCTURAL_ROLES = [
  OPEN_SEMANTIC_DURATION_ROLE,
  OPEN_SEMANTIC_LOCATION_ROLE
] as const;

export type OpenSemanticStructuralRole =
  typeof OPEN_SEMANTIC_STRUCTURAL_ROLES[number];

const DURATION_ALIASES: ReadonlySet<string> = new Set([
  OPEN_SEMANTIC_DURATION_ROLE,
  "时长",
  "持续时间"
]);

const LOCATION_ALIASES: ReadonlySet<string> = new Set([
  OPEN_SEMANTIC_LOCATION_ROLE,
  "place",
  "地点",
  "位置"
]);

export function classifyOpenSemanticStructuralRole(
  bindingIdentity: string
): OpenSemanticStructuralRole | null {
  const normalized = normalizeRoleAlias(bindingIdentity);
  if (normalized.length === 0) return null;
  if (DURATION_ALIASES.has(normalized)) return OPEN_SEMANTIC_DURATION_ROLE;
  if (LOCATION_ALIASES.has(normalized)) return OPEN_SEMANTIC_LOCATION_ROLE;
  return null;
}

export function isOpenSemanticStructuralRole(
  bindingIdentity: string,
  role: OpenSemanticStructuralRole
): boolean {
  return classifyOpenSemanticStructuralRole(bindingIdentity) === role;
}

export const OPEN_SEMANTIC_DURATION_WH_SURFACES = [
  "how long",
  "多久",
  "多长时间"
] as const;

export const OPEN_SEMANTIC_LOCATION_WH_SURFACES = [
  "where",
  "哪里",
  "何处",
  "哪儿"
] as const;

const DURATION_OBLIGATION_SURFACES: ReadonlySet<string> = new Set(
  OPEN_SEMANTIC_DURATION_WH_SURFACES
);

const LOCATION_OBLIGATION_SURFACES: ReadonlySet<string> = new Set(
  OPEN_SEMANTIC_LOCATION_WH_SURFACES
);

export function classifyQueryObligationStructuralRole(
  valueSurface: string
): OpenSemanticStructuralRole | null {
  const normalized = normalizeObligationSurface(valueSurface);
  if (DURATION_OBLIGATION_SURFACES.has(normalized)) return OPEN_SEMANTIC_DURATION_ROLE;
  if (LOCATION_OBLIGATION_SURFACES.has(normalized)) return OPEN_SEMANTIC_LOCATION_ROLE;
  return null;
}

function normalizeRoleAlias(value: string): string {
  return value.normalize("NFKC").trim().toLowerCase();
}

function normalizeObligationSurface(value: string): string {
  return value.normalize("NFKC").trim().toLowerCase().replace(/\s+/gu, " ");
}
