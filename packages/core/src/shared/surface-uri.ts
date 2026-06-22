import { CoreError } from "./errors.js";
import { parseNonEmptyString } from "./validators.js";

// surface://segment(/segment)* — each segment is non-empty [\w.-]; rejects
// empty paths, bare/duplicated slashes, colons, and control chars.
export const SURFACE_URI_PATTERN = /^surface:\/\/[\w.-]+(?:\/[\w.-]+)*$/;

export function parseSurfaceUri(value: string, field: string): string {
  const parsed = parseNonEmptyString(value, field);

  if (!SURFACE_URI_PATTERN.test(parsed)) {
    throw new CoreError("VALIDATION", `${field} must be a surface:// URI`);
  }

  return parsed;
}
