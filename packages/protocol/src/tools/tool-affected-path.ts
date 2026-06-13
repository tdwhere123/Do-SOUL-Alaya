import { z } from "zod";
import { NonEmptyStringSchema } from "../shared/schema-primitives.js";

const WINDOWS_ABSOLUTE_PATH_PATTERN = /^[A-Za-z]:[\\/]/;

export const ToolAffectedPathSchema = NonEmptyStringSchema.refine(
  (value) => isWorkspaceRelativePosixPath(value),
  "Expected a workspace-relative POSIX path"
);

export const ToolAffectedPathsSchema = z.array(ToolAffectedPathSchema).readonly();

function isWorkspaceRelativePosixPath(value: string): boolean {
  if (value.startsWith("/") || value.startsWith("\\") || value.includes("\\") || WINDOWS_ABSOLUTE_PATH_PATTERN.test(value)) {
    return false;
  }

  const segments = value.split("/");

  return segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}
