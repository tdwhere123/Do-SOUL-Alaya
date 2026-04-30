import { readFileSync } from "node:fs";
import path from "node:path";

export type SecretRef = string;

export interface SecretRefReader {
  readonly readEnv: (name: string) => string | undefined;
  readonly readFile: (filePath: string) => string;
}

export interface ResolvedSecret {
  readonly ref: SecretRef;
  readonly value: string;
  readonly origin: "env" | "file";
}

export type ResolveSecretError =
  | { kind: "malformed"; ref: SecretRef; reason: string }
  | { kind: "env_missing"; ref: SecretRef; var_name: string }
  | { kind: "file_missing"; ref: SecretRef; path: string }
  | { kind: "file_unreadable"; ref: SecretRef; path: string; cause: string }
  | { kind: "empty"; ref: SecretRef; origin: "env" | "file" };

const ENV_REF_PREFIX = "env:";
const FILE_REF_PREFIX = "file:";
const ENV_IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

const defaultSecretRefReader: SecretRefReader = {
  readEnv: (name) => process.env[name],
  readFile: (filePath) => readFileSync(filePath, "utf8")
};

export function resolveSecretRef(
  ref: SecretRef,
  reader: SecretRefReader = defaultSecretRefReader
): ResolvedSecret | ResolveSecretError {
  if (ref.startsWith(ENV_REF_PREFIX)) {
    return resolveEnvRef(ref, reader);
  }

  if (ref.startsWith(FILE_REF_PREFIX)) {
    return resolveFileRef(ref, reader);
  }

  return {
    kind: "malformed",
    ref,
    reason: 'Unsupported secret-ref scheme. Use "env:NAME" or "file:/abs/path".'
  };
}

function resolveEnvRef(ref: SecretRef, reader: SecretRefReader): ResolvedSecret | ResolveSecretError {
  const varName = ref.slice(ENV_REF_PREFIX.length);
  if (!ENV_IDENTIFIER_PATTERN.test(varName)) {
    return {
      kind: "malformed",
      ref,
      reason: "Environment secret ref must match env:[A-Za-z_][A-Za-z0-9_]*."
    };
  }

  const value = reader.readEnv(varName);
  if (value === undefined) {
    return {
      kind: "env_missing",
      ref,
      var_name: varName
    };
  }

  if (value.trim().length === 0) {
    return {
      kind: "empty",
      ref,
      origin: "env"
    };
  }

  return {
    ref,
    value,
    origin: "env"
  };
}

function resolveFileRef(ref: SecretRef, reader: SecretRefReader): ResolvedSecret | ResolveSecretError {
  const filePath = ref.slice(FILE_REF_PREFIX.length);
  if (filePath.length === 0 || !path.isAbsolute(filePath)) {
    return {
      kind: "malformed",
      ref,
      reason: "File secret ref must use an absolute path (file:/abs/path)."
    };
  }

  let fileContent: string;
  try {
    fileContent = reader.readFile(filePath);
  } catch (error) {
    if (isNodeErrorWithCode(error) && error.code === "ENOENT") {
      return {
        kind: "file_missing",
        ref,
        path: filePath
      };
    }

    return {
      kind: "file_unreadable",
      ref,
      path: filePath,
      cause: toSafeCauseCode(error)
    };
  }

  const value = fileContent.trimEnd();
  if (value.trim().length === 0) {
    return {
      kind: "empty",
      ref,
      origin: "file"
    };
  }

  return {
    ref,
    value,
    origin: "file"
  };
}

function isNodeErrorWithCode(error: unknown): error is NodeJS.ErrnoException & { readonly code: string } {
  return error instanceof Error && "code" in error && typeof error.code === "string";
}

function toSafeCauseCode(error: unknown): string {
  if (isNodeErrorWithCode(error)) {
    return error.code;
  }

  if (error instanceof Error && typeof error.name === "string" && error.name.length > 0) {
    return error.name;
  }

  return "unknown_error";
}
