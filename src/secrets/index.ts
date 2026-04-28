import { readFile } from "node:fs/promises";
import {
  assertIsoDatetime,
  assertObject,
  assertOneOf,
  assertText
} from "../foundation/validation.js";

export const secretRefSourceTypes = ["env", "local_file"] as const;
export type SecretRefSourceType = (typeof secretRefSourceTypes)[number];

export const secretResolutionStates = ["resolved", "missing", "empty", "unavailable"] as const;
export type SecretResolutionState = (typeof secretResolutionStates)[number];

export interface SecretRef {
  readonly secret_ref: string;
  readonly source_type: SecretRefSourceType;
  readonly source_key: string;
  readonly purpose: string;
}

export interface CreateEnvSecretRefInput {
  readonly secret_ref: string;
  readonly env_var: string;
  readonly purpose: string;
}

export interface CreateLocalFileSecretRefInput {
  readonly secret_ref: string;
  readonly file_path: string;
  readonly purpose: string;
}

export interface SecretResolutionStatus {
  readonly secret_ref: string;
  readonly source_type: SecretRefSourceType;
  readonly source_key: string;
  readonly purpose: string;
  readonly state: SecretResolutionState;
  readonly resolved: boolean;
  readonly reason: string | null;
  readonly checked_at: string;
}

export interface ResolveSecretRefOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly readFileText?: (path: string) => Promise<string> | string;
  readonly now?: () => string;
}

export function createEnvSecretRef(input: CreateEnvSecretRefInput): SecretRef {
  assertObject(input, "CreateEnvSecretRefInput");
  assertText(input.secret_ref, "secret_ref");
  assertText(input.env_var, "env_var");
  assertText(input.purpose, "purpose");
  return {
    purpose: input.purpose,
    secret_ref: input.secret_ref,
    source_key: input.env_var,
    source_type: "env"
  };
}

export function createLocalFileSecretRef(input: CreateLocalFileSecretRefInput): SecretRef {
  assertObject(input, "CreateLocalFileSecretRefInput");
  assertText(input.secret_ref, "secret_ref");
  assertText(input.file_path, "file_path");
  assertText(input.purpose, "purpose");
  return {
    purpose: input.purpose,
    secret_ref: input.secret_ref,
    source_key: input.file_path,
    source_type: "local_file"
  };
}

export async function resolveSecretRef(
  ref: SecretRef,
  options: ResolveSecretRefOptions = {}
): Promise<SecretResolutionStatus> {
  validateSecretRef(ref);
  const checkedAt = options.now?.() ?? new Date().toISOString();
  assertIsoDatetime(checkedAt, "checked_at");

  switch (ref.source_type) {
    case "env":
      return resolveEnvSecretRef(ref, options.env ?? process.env, checkedAt);
    case "local_file":
      return resolveLocalFileSecretRef(ref, options.readFileText ?? defaultReadFileText, checkedAt);
  }
}

function resolveEnvSecretRef(
  ref: SecretRef,
  env: Readonly<Record<string, string | undefined>>,
  checkedAt: string
): SecretResolutionStatus {
  const value = env[ref.source_key];
  if (value === undefined) {
    return status(ref, "missing", "env_var_missing", checkedAt);
  }
  if (value.trim().length === 0) {
    return status(ref, "empty", "env_var_empty", checkedAt);
  }
  return status(ref, "resolved", null, checkedAt);
}

async function resolveLocalFileSecretRef(
  ref: SecretRef,
  readFileText: (path: string) => Promise<string> | string,
  checkedAt: string
): Promise<SecretResolutionStatus> {
  try {
    const value = await readFileText(ref.source_key);
    if (value.trim().length === 0) {
      return status(ref, "empty", "local_file_empty", checkedAt);
    }
    return status(ref, "resolved", null, checkedAt);
  } catch (error) {
    if (isNodeErrorCode(error, "ENOENT")) {
      return status(ref, "missing", "local_file_missing", checkedAt);
    }
    return status(ref, "unavailable", "local_file_unavailable", checkedAt);
  }
}

function status(
  ref: SecretRef,
  state: SecretResolutionState,
  reason: string | null,
  checkedAt: string
): SecretResolutionStatus {
  return {
    checked_at: checkedAt,
    purpose: ref.purpose,
    reason,
    resolved: state === "resolved",
    secret_ref: ref.secret_ref,
    source_key: ref.source_key,
    source_type: ref.source_type,
    state
  };
}

async function defaultReadFileText(path: string): Promise<string> {
  return readFile(path, "utf8");
}

function validateSecretRef(ref: SecretRef): void {
  assertObject(ref, "SecretRef");
  assertText(ref.secret_ref, "secret_ref");
  assertOneOf(ref.source_type, secretRefSourceTypes, "source_type");
  assertText(ref.source_key, "source_key");
  assertText(ref.purpose, "purpose");
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === code;
}
