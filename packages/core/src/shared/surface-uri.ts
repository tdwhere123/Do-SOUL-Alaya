import { SURFACE_URI_PATTERN } from "@do-soul/alaya-protocol";
import { CoreError } from "./errors.js";
import { parseNonEmptyString } from "./validators.js";

export { SURFACE_URI_PATTERN };

export function parseSurfaceUri(value: string, field: string): string {
  const parsed = parseNonEmptyString(value, field);

  if (!SURFACE_URI_PATTERN.test(parsed)) {
    throw new CoreError("VALIDATION", `${field} must be a surface:// URI`);
  }

  return parsed;
}
