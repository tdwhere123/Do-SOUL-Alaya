export type ProfileTarget = "codex" | "claude-code";
export type ProfileMutationDirection = "add" | "remove";

export interface ProfilePaths {
  readonly mcpConfigPath: string;
  readonly slashCommandsPath: string;
  readonly slashPathCandidates: readonly string[];
}

export interface ProfileMutationConflict {
  readonly message: string;
  readonly existingCommand: string;
}

export interface ProfileMutationOperation {
  readonly recordKind: "mcp_server_entry" | "slash_alias";
  readonly label: string;
  readonly path: string;
  readonly before: string | undefined;
  readonly after: string | undefined;
  readonly changed: boolean;
  readonly alreadyAbsent: boolean;
  readonly conflict?: ProfileMutationConflict;
}

export interface ProfileMutationPlan {
  readonly target: ProfileTarget;
  readonly direction: ProfileMutationDirection;
  readonly paths: ProfilePaths;
  readonly operations: readonly ProfileMutationOperation[];
  readonly auditEventKind: "profile_mutation_attach" | "profile_mutation_detach";
}

export interface ProfileMutationAuditRecord {
  readonly record_kind: ProfileMutationOperation["recordKind"];
  readonly path: string;
}

export interface ProfileMutationAuditRow {
  readonly event_kind: "profile_mutation_attach" | "profile_mutation_detach";
  readonly target: ProfileTarget;
  readonly direction: ProfileMutationDirection;
  readonly changed_paths: readonly string[];
  readonly records: readonly ProfileMutationAuditRecord[];
  readonly created_at: string;
}

export interface ProfileMutationAuditWriter {
  append(row: ProfileMutationAuditRow): Promise<void>;
  rollback?(row: ProfileMutationAuditRow): Promise<void>;
}

export interface ProfileMutationFs {
  readText(filePath: string): Promise<string | undefined>;
  writeTextAtomic(filePath: string, content: string, mode?: number): Promise<void>;
  removeText(filePath: string): Promise<void>;
}

export interface ResolveProfilePathsOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly fs?: ProfileMutationFs;
}

export interface ProfileMutationBuildOptions extends ResolveProfilePathsOptions {}

export interface ProfileMutationApplyOptions {
  readonly fs?: ProfileMutationFs;
  readonly auditWriter?: ProfileMutationAuditWriter;
  readonly allowConflicts?: boolean;
  readonly nowIso?: () => string;
}

export interface ProfileMutationConfirmIo {
  readonly stdin: NodeJS.ReadableStream;
  readonly stdout: NodeJS.WritableStream;
}

export interface ProfileMutationApplyResult {
  readonly changed: boolean;
  readonly auditRow: ProfileMutationAuditRow | undefined;
}

export class ProfileMutationError extends Error {
  public constructor(
    message: string,
    public readonly exitCode: number
  ) {
    super(message);
    this.name = "ProfileMutationError";
  }
}
