import type { GitBindingValidationResult } from "./workspace-git-binding-types.js";

export function mapFsErrorToValidationResult(
  error: unknown,
  notFoundDetail: string
): GitBindingValidationResult {
  logGitBindingFsWarning("validateWorkspaceGitBindingInput", "repo_path", error);
  const code = readFsErrorCode(error);
  if (code === "EACCES" || code === "EPERM") {
    return {
      ok: false,
      code: "permission_denied",
      detail: "repo_path could not be accessed due to insufficient permissions."
    };
  }
  return {
    ok: false,
    code: "path_not_found",
    detail: notFoundDetail
  };
}

export function logGitBindingFsWarning(scope: string, target: string, error: unknown): void {
  const code = readFsErrorCode(error);
  process.emitWarning(
    `Workspace git binding ${scope} failed for ${target}${code === undefined ? "" : ` (${code})`}`,
    { type: "AlayaGitBindingWarning", code: "ALAYA_GIT_BINDING_FS_ERROR" }
  );
}

function readFsErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  const code = (error as { readonly code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}
