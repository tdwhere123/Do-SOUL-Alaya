export const EXTRACTION_REQUEST_PROFILES = [
  "provider-default-v1",
  "deepseek-v4-nonthinking-v1"
] as const;

export type ExtractionRequestProfile =
  (typeof EXTRACTION_REQUEST_PROFILES)[number];
