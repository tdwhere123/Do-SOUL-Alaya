export const EXTRACTION_REQUEST_PROFILES = [
  "provider-default-v1",
  "deepseek-v4-nonthinking-v1",
  "mimo-v2.5-nonthinking-v1"
] as const;

export const CURRENT_EXTRACTION_REQUEST_PROFILES = [
  "provider-default-v1",
  "mimo-v2.5-nonthinking-v1"
] as const;

export type ExtractionRequestProfile =
  (typeof EXTRACTION_REQUEST_PROFILES)[number];
export type CurrentExtractionRequestProfile =
  (typeof CURRENT_EXTRACTION_REQUEST_PROFILES)[number];

export function isExtractionRequestProfile(
  value: unknown
): value is ExtractionRequestProfile {
  return typeof value === "string" &&
    (EXTRACTION_REQUEST_PROFILES as readonly string[]).includes(value);
}

export function isCurrentExtractionRequestProfile(
  value: unknown
): value is CurrentExtractionRequestProfile {
  return typeof value === "string" &&
    (CURRENT_EXTRACTION_REQUEST_PROFILES as readonly string[]).includes(value);
}
