import { CoreError } from "../errors.js";
import { parseNonEmptyString } from "./validators.js";

export const SURFACE_URI_PATTERN = /^surface:\/\/[\w\-.:/]+$/;

export function parseSurfaceUri(value: string, field: string): string {
  const parsed = parseNonEmptyString(value, field);

  if (!SURFACE_URI_PATTERN.test(parsed)) {
    throw new CoreError("VALIDATION", `${field} must be a surface:// URI`);
  }

  return parsed;
}
