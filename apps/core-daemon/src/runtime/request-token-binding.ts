import { randomBytes } from "node:crypto";
import { constantTimeTokenEqual } from "../shared/constant-time-token.js";
import {
  resolveDaemonListenPolicy,
  type DaemonHostEnvLike,
  type DaemonListenPolicy
} from "./server-options.js";

export const REQUEST_TOKEN_GRANT_CONTEXT_KEY = "requestTokenGrant";

export const PROCESS_SECRET_PATCH_PATHS = Object.freeze([
  "/config/runtime/embedding-supplement",
  "/config/runtime/garden-compute"
] as const);

export type WorkspaceTokenBinding = {
  readonly token: string;
  readonly workspaceIds: readonly string[];
  readonly allowProcessSecretPatch?: boolean;
};

export type RequestTokenProtection = {
  readonly requestToken: string;
  readonly tokenSource?: "env" | "ephemeral" | "rotated";
  readonly boundWorkspaceIds?: readonly string[];
  readonly allowProcessSecretPatch?: boolean;
  readonly workspaceTokens?: readonly WorkspaceTokenBinding[];
};

export type RequestTokenGrant = {
  readonly token: string;
  readonly workspaceIds: readonly string[] | "*";
  readonly allowProcessSecretPatch: boolean;
};

export type RequestTokenAuthorization =
  | { readonly ok: true; readonly grant: RequestTokenGrant }
  | { readonly ok: false; readonly error: string };

const WORKSPACE_PATH_PATTERNS = [
  /^\/workspaces\/([^/]+)(?:\/|$)/,
  /^\/soul\/workspaces\/([^/]+)(?:\/|$)/
] as const;

export function extractWorkspaceIdFromPath(path: string): string | null {
  for (const pattern of WORKSPACE_PATH_PATTERNS) {
    const match = pattern.exec(path);
    const encoded = match?.[1];
    if (encoded === undefined) {
      continue;
    }
    try {
      const workspaceId = decodeURIComponent(encoded).trim();
      if (workspaceId.length > 0) {
        return workspaceId;
      }
    } catch {
      return encoded;
    }
  }
  return null;
}

export function isProcessSecretPatchRequest(method: string, path: string): boolean {
  if (method !== "PATCH") {
    return false;
  }
  return (PROCESS_SECRET_PATCH_PATHS as readonly string[]).includes(path);
}

export function workspaceScopeAllows(
  grant: RequestTokenGrant,
  workspaceId: string
): boolean {
  if (grant.workspaceIds === "*") {
    return true;
  }
  return grant.workspaceIds.includes(workspaceId);
}

export function resolveRequestTokenGrants(
  protection: RequestTokenProtection
): readonly RequestTokenGrant[] {
  const processGrant: RequestTokenGrant = {
    token: protection.requestToken,
    workspaceIds:
      protection.boundWorkspaceIds === undefined
        ? "*"
        : protection.boundWorkspaceIds,
    allowProcessSecretPatch: protection.allowProcessSecretPatch ?? true
  };
  const workspaceGrants = (protection.workspaceTokens ?? []).map((binding) => ({
    token: binding.token,
    workspaceIds: binding.workspaceIds,
    allowProcessSecretPatch: binding.allowProcessSecretPatch ?? false
  }));
  // Workspace-scoped grants first so a dedicated Inspector token wins over the process token.
  return [...workspaceGrants, processGrant];
}

export function authorizeProtectedRequest(input: {
  readonly providedToken: string | undefined;
  readonly protection: RequestTokenProtection;
  readonly method: string;
  readonly path: string;
}): RequestTokenAuthorization {
  const provided = input.providedToken?.trim();
  if (provided === undefined || provided.length === 0) {
    return { ok: false, error: "X-Request-Token is required" };
  }

  const grant = matchRequestTokenGrant(provided, resolveRequestTokenGrants(input.protection));
  if (grant === null) {
    return { ok: false, error: "Invalid X-Request-Token" };
  }

  if (isProcessSecretPatchRequest(input.method, input.path) && !grant.allowProcessSecretPatch) {
    return { ok: false, error: "Process-level secret patch is not allowed" };
  }

  const workspaceId = extractWorkspaceIdFromPath(input.path);
  if (workspaceId !== null && !workspaceScopeAllows(grant, workspaceId)) {
    return { ok: false, error: "Workspace is not authorized for this token" };
  }

  return { ok: true, grant };
}

export function grantAllowsProcessSecretPatch(
  grant: RequestTokenGrant | undefined
): boolean {
  return grant?.allowProcessSecretPatch === true;
}

export type RequestProtectionEnvLike = DaemonHostEnvLike & {
  ALAYA_WORKSPACE_ID?: string;
  ALAYA_REQUEST_TOKEN_WORKSPACES?: string;
};

export function applyRemoteBindTokenRotation<T extends RequestTokenProtection>(
  protection: T,
  envLike: RequestProtectionEnvLike,
  generateToken: () => string = generateRotatedRequestToken
): T {
  const withWorkspaceBinding = applyDefaultWorkspaceBinding(protection, envLike);
  if (withWorkspaceBinding.tokenSource === "rotated") {
    return withWorkspaceBinding;
  }
  const policy = tryResolveDaemonListenPolicy(envLike);
  if (policy === null || policy.kind !== "unix") {
    return withWorkspaceBinding;
  }
  return Object.freeze({
    ...withWorkspaceBinding,
    requestToken: generateToken(),
    tokenSource: "rotated" as const
  }) as T;
}

function applyDefaultWorkspaceBinding<T extends RequestTokenProtection>(
  protection: T,
  envLike: RequestProtectionEnvLike
): T {
  if (protection.boundWorkspaceIds !== undefined) {
    return protection;
  }
  const boundWorkspaceIds = workspaceIdsFromEnv(envLike);
  if (boundWorkspaceIds === undefined) {
    return protection;
  }
  return Object.freeze({
    ...protection,
    boundWorkspaceIds
  }) as T;
}

function workspaceIdsFromEnv(envLike: RequestProtectionEnvLike): readonly string[] | undefined {
  const listed = envLike.ALAYA_REQUEST_TOKEN_WORKSPACES?.split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  if (listed !== undefined && listed.length > 0) {
    return listed;
  }
  return undefined;
}

export function generateRotatedRequestToken(): string {
  return randomBytes(32).toString("hex");
}

function tryResolveDaemonListenPolicy(envLike: DaemonHostEnvLike): DaemonListenPolicy | null {
  try {
    return resolveDaemonListenPolicy(envLike);
  } catch {
    return null;
  }
}

function matchRequestTokenGrant(
  provided: string,
  grants: readonly RequestTokenGrant[]
): RequestTokenGrant | null {
  let matched: RequestTokenGrant | null = null;
  for (const grant of grants) {
    if (constantTimeTokenEqual(provided, grant.token) && matched === null) {
      matched = grant;
    }
  }
  return matched;
}
