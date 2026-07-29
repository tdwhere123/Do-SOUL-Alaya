export const DEFAULT_MAX_BYTES = 1_048_576;
export const DEFAULT_MAX_RESULTS = 200;
export const DEFAULT_EXEC_TIMEOUT_MS = 30_000;
export const MAX_EXEC_TIMEOUT_MS = 120_000;
export const MAX_EXEC_OUTPUT_BYTES = 131_072;
export const MAX_EXEC_BUFFER_BYTES = MAX_EXEC_OUTPUT_BYTES * 10;
export const EXEC_CHILD_ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "USER",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "NODE_ENV",
  "SHELL",
  "TMPDIR",
  "TMP",
  "TEMP",
  "SystemRoot",
  "ComSpec",
  "PATHEXT"
] as const;
