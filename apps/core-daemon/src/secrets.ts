import { readFileSync } from "node:fs";
import path from "node:path";
import {
  parseSecretRefKeychainTarget,
  SECRET_REF_ENV_PREFIX,
  SECRET_REF_FILE_PREFIX,
  SECRET_REF_KEYCHAIN_PREFIX
} from "@do-soul/alaya-protocol";
import { readPlatformKeychainSecret, type KeychainReadError } from "./secrets/keychain/index.js";

export type SecretRef = string;

export interface SecretRefReader {
  readonly readEnv: (name: string) => string | undefined;
  readonly readFile: (filePath: string) => string;
  readonly readKeychain: (service: string, account: string) => string | KeychainReadError;
}

export interface ResolvedSecret {
  readonly ref: SecretRef;
  readonly value: string;
  readonly origin: "env" | "file" | "keychain";
}

export type ResolveSecretError =
  | { kind: "malformed"; ref: SecretRef; reason: string }
  | { kind: "env_missing"; ref: SecretRef; var_name: string }
  | { kind: "file_missing"; ref: SecretRef; path: string }
  | { kind: "file_unreadable"; ref: SecretRef; path: string; cause: string }
  | { kind: "keychain_tooling_unavailable"; ref: SecretRef; service: string; account: string; reason: string }
  | { kind: "keychain_entry_not_found"; ref: SecretRef; service: string; account: string; reason: string }
  | { kind: "empty"; ref: SecretRef; origin: "env" | "file" | "keychain" };

const ENV_REF_PREFIX = SECRET_REF_ENV_PREFIX;
const FILE_REF_PREFIX = SECRET_REF_FILE_PREFIX;
const KEYCHAIN_REF_PREFIX = SECRET_REF_KEYCHAIN_PREFIX;
const ENV_IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

const defaultSecretRefReader: SecretRefReader = {
  readEnv: (name) => process.env[name],
  readFile: (filePath) => readFileSync(filePath, "utf8"),
  readKeychain: (service, account) => readPlatformKeychainSecret(service, account)
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

  if (ref.startsWith(KEYCHAIN_REF_PREFIX)) {
    return resolveKeychainRef(ref, reader);
  }

  return {
    kind: "malformed",
    ref,
    reason: 'Unsupported secret-ref scheme. Use "env:NAME", "file:/abs/path", or "keychain:service:account".'
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

function resolveKeychainRef(ref: SecretRef, reader: SecretRefReader): ResolvedSecret | ResolveSecretError {
  const parsed = parseSecretRefKeychainTarget(ref);
  if (parsed === null) {
    return {
      kind: "malformed",
      ref,
      reason:
        "Keychain secret ref must match keychain:<service>:<account> with each segment limited to [A-Za-z0-9._-]+."
    };
  }

  const readResult = reader.readKeychain(parsed.service, parsed.account);
  if (typeof readResult !== "string") {
    return {
      ...readResult,
      ref
    };
  }

  const value = readResult.trimEnd();
  if (value.trim().length === 0) {
    return {
      kind: "empty",
      ref,
      origin: "keychain"
    };
  }

  return {
    ref,
    value,
    origin: "keychain"
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
