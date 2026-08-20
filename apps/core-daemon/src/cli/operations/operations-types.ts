export type OperationName = "backup" | "export" | "import";

export interface OperationAuditRecord {
  readonly operation: OperationName;
  readonly status: "started" | "succeeded" | "failed";
  readonly started_at: string;
  readonly finished_at: string | null;
  readonly audit_version: 1;
  readonly artifact_path: string | null;
  readonly bundle_path: string | null;
  readonly partial_state: readonly string[];
  readonly error: string | null;
}

export interface OperationsBundle {
  readonly bundle_version: 1;
  readonly kind: "backup" | "export";
  readonly created_at: string;
  readonly config: Readonly<{
    alaya_toml: string | null;
    env_file: string | null;
  }>;
  readonly storage: Readonly<{
    db_path: string | null;
    db_base64: string | null;
  }>;
}

export interface ImportPreview {
  readonly bundle_kind: OperationsBundle["kind"];
  readonly created_at: string;
  readonly has_config_toml: boolean;
  readonly has_env_file: boolean;
  readonly has_database_payload: boolean;
  readonly db_path: string | null;
}

export interface AlayaOperationsService {
  backup(input?: { readonly outputPath?: string | null }): Promise<Readonly<{ artifact_path: string; audit_path: string }>>;
  exportBundle(input?: { readonly outputPath?: string | null }): Promise<Readonly<{ artifact_path: string; audit_path: string }>>;
  previewImport(input: { readonly bundlePath: string }): Promise<ImportPreview>;
  importBundle(input: { readonly bundlePath: string }): Promise<Readonly<{ audit_path: string; restored_paths: readonly string[] }>>;
}

export class AlayaOperationError extends Error {
  public constructor(
    public readonly code: "DATAERR" | "NOINPUT" | "CANTCREAT" | "NOPERM",
    message: string
  ) {
    super(message);
    this.name = "AlayaOperationError";
  }
}
