import { createHash } from "node:crypto";
import path from "node:path";
import { CoreError } from "@do-soul/alaya-core";
import type { AlayaCliContext } from "./bridge.js";

export interface ResolvedCliWorkspaceContext {
  readonly workspaceId: string;
  readonly implicitLocalWorkspace: null | Readonly<{
    readonly workspaceId: string;
    readonly name: string;
    readonly rootPath: string;
  }>;
}

export interface EnsureLocalWorkspacePort {
  ensureLocalWorkspace(input: {
    readonly workspaceId: string;
    readonly name: string;
    readonly rootPath: string;
  }): Promise<unknown>;
}

export interface RunWorkspaceLookupPort {
  getById(runId: string): Promise<Readonly<{ readonly workspace_id: string }>>;
}

export function resolveCliWorkspaceContext(
  ctx: Pick<AlayaCliContext, "cwd" | "env">,
  explicitWorkspaceId?: string | null,
  defaultWorkspaceId?: string | null
): ResolvedCliWorkspaceContext {
  const explicit = normalizeOptionalWorkspaceId(explicitWorkspaceId);
  if (explicit !== null) {
    return { workspaceId: explicit, implicitLocalWorkspace: null };
  }

  const dependencyDefault = normalizeOptionalWorkspaceId(defaultWorkspaceId);
  if (dependencyDefault !== null) {
    return { workspaceId: dependencyDefault, implicitLocalWorkspace: null };
  }

  const envDefault = normalizeOptionalWorkspaceId(ctx.env.ALAYA_WORKSPACE_ID);
  if (envDefault !== null) {
    return { workspaceId: envDefault, implicitLocalWorkspace: null };
  }

  const rootPath = path.resolve(ctx.cwd);
  const workspaceId = deriveLocalWorkspaceId(rootPath);
  return {
    workspaceId,
    implicitLocalWorkspace: {
      workspaceId,
      name: deriveLocalWorkspaceName(rootPath),
      rootPath
    }
  };
}

export async function ensureImplicitLocalWorkspace(
  workspaceContext: ResolvedCliWorkspaceContext,
  port?: EnsureLocalWorkspacePort | null
): Promise<void> {
  if (workspaceContext.implicitLocalWorkspace === null || port === undefined || port === null) {
    return;
  }

  await port.ensureLocalWorkspace(workspaceContext.implicitLocalWorkspace);
}

export async function resolveTrustedCliRunId(input: {
  readonly runId: string | null | undefined;
  readonly workspaceId: string;
  readonly runService?: RunWorkspaceLookupPort | null;
  readonly sourceLabel: string;
}): Promise<
  | { readonly ok: true; readonly runId: string | null }
  | { readonly ok: false; readonly message: string }
> {
  const runId = normalizeOptionalWorkspaceId(input.runId);
  if (runId === null) {
    return { ok: true, runId: null };
  }

  if (input.runService === undefined || input.runService === null) {
    return {
      ok: false,
      message: `${input.sourceLabel} ${runId} cannot be trusted without run lookup service.`
    };
  }

  try {
    const run = await input.runService.getById(runId);
    if (run.workspace_id !== input.workspaceId) {
      return {
        ok: false,
        message: `${input.sourceLabel} ${runId} belongs to workspace ${run.workspace_id}, not ${input.workspaceId}.`
      };
    }
    return { ok: true, runId };
  } catch (error) {
    if (!(error instanceof CoreError && error.code === "NOT_FOUND")) {
      throw error;
    }
    return {
      ok: false,
      message: `${input.sourceLabel} ${runId} was not found for workspace ${input.workspaceId}.`
    };
  }
}

function deriveLocalWorkspaceId(rootPath: string): string {
  const digest = createHash("sha256").update(rootPath).digest("hex").slice(0, 16);
  return `local_${digest}`;
}

function deriveLocalWorkspaceName(rootPath: string): string {
  const basename = path.basename(rootPath);
  return basename.length > 0 ? basename : rootPath;
}

function normalizeOptionalWorkspaceId(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length === 0 ? null : trimmed;
}
