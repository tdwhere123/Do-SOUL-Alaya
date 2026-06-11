import { CoreError } from "./errors.js";

interface WorkspaceScopedRecord {
  readonly workspace_id: string;
}

export interface LoadOrDefaultWithWorkspaceGuardInput<T extends WorkspaceScopedRecord> {
  readonly workspaceId: string;
  readonly load: () => Promise<Readonly<T> | null>;
  readonly parse: (value: Readonly<T>) => Readonly<T>;
  readonly createDefault: () => Readonly<T>;
  readonly label: string;
}

export interface LoadOrDefaultWithWorkspaceGuardResult<T extends WorkspaceScopedRecord> {
  readonly loaded: Readonly<T> | null;
  readonly value: Readonly<T>;
}

export async function loadOrDefaultWithWorkspaceGuard<T extends WorkspaceScopedRecord>(
  input: LoadOrDefaultWithWorkspaceGuardInput<T>
): Promise<LoadOrDefaultWithWorkspaceGuardResult<T>> {
  const loaded = await input.load();

  if (loaded === null) {
    return {
      loaded: null,
      value: input.createDefault()
    };
  }

  const parsed = input.parse(loaded);

  if (parsed.workspace_id !== input.workspaceId) {
    throw new CoreError(
      "VALIDATION",
      `${input.label} workspace mismatch: expected ${input.workspaceId} but received ${parsed.workspace_id}.`
    );
  }

  return {
    loaded: parsed,
    value: parsed
  };
}
