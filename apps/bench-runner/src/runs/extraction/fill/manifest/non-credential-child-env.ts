const NON_CREDENTIAL_ENV_KEYS = [
  "PATH", "Path", "PATHEXT", "SYSTEMROOT", "SystemRoot", "WINDIR", "ComSpec",
  "HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "TMP", "TEMP", "TMPDIR",
  "LANG", "LC_ALL", "LC_CTYPE"
] as const;

/** Child processes may locate system tools. They do not inherit credential-like environment keys. */
export function nonCredentialChildEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of NON_CREDENTIAL_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}
